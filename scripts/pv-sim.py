#!/usr/bin/env python3
"""Rooftop PV, home battery and EV charging against the house's measured hourly load.

Simulates one calendar year hour by hour for every combination of PV size, battery
size and EV on/off, for each price year, as the mean of several PVGIS weather years.
The house's own figures (rounded location, roof, Estfeed statistic, heating
assumptions, tariff, EV) live in the private khe-meta repo (house/house-hvac.md) as a
fenced block with the info string `json pv-sim`; nothing house-specific is in here.

Usage:
  pv-sim.py fetch   CONFIG.md --data DIR [--refresh] [--refresh-pv]
                    load (HA), prices (Elering), PV (PVGIS); --refresh re-reads the load
  pv-sim.py grid    CONFIG.md --data DIR [--procs N]   writes DIR/grid.json
  pv-sim.py summary --data DIR                         savings table from grid.json
  pv-sim.py page    --data DIR --page-in A.html --page-out B.html
                    swaps the `const DATA = ...;` line of the published page for grid.json

Model:
  - Frame: the config's frame_year, local days x 24 local hours. Measured days are
    moved by whole 364-day steps into the frame (weekdays line up); frame days with
    no measured twin replay measured days of the same weekday type from the pool and
    with the flat add-on that month_templates names.
  - Price year Y uses Elering spot shifted by 364-day steps, frame year where Y has none.
  - Buy = (spot + margin + fees + network day/night) x VAT; sell = spot - sell_fee;
    PV is curtailed rather than sold at a negative price.
  - Battery and EV charging: a linear program per day over a 48 h horizon, committing
    24 h. It knows the next 48 h of prices and load, so battery figures are an upper
    bound. The battery never exports; a wear cost per kWh discharged shapes its
    dispatch but is not in the bill.

Needs: python3 with numpy and scipy, plus websockets for `fetch` (it runs ha-ws.py).
"""
import argparse, datetime as dt, json, os, re, subprocess, sys, urllib.request
from multiprocessing import Pool
from zoneinfo import ZoneInfo

BLOCK = re.compile(r"^```json pv-sim[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)
TZ, UTC = ZoneInfo("Europe/Tallinn"), dt.timezone.utc
WEEK52 = dt.timedelta(days=364)
HERE = os.path.dirname(os.path.abspath(__file__))


def read_config(path):
    with open(path, encoding="utf-8") as f:
        found = BLOCK.findall(f.read())
    if len(found) != 1:
        sys.exit(f"{path}: expected one `json pv-sim` block, found {len(found)}")
    return json.loads(found[0])


def day(s):
    return dt.date.fromisoformat(s)


def utc_ts(d, h):
    return int(dt.datetime(d.year, d.month, d.day, h, tzinfo=TZ).astimezone(UTC).timestamp())


def get_json(url):
    with urllib.request.urlopen(url, timeout=120) as r:
        return json.load(r)


# ---------- fetch ----------

def fetch(cfg, data, refresh, refresh_pv):
    os.makedirs(data, exist_ok=True)
    today = dt.date.today()
    path = os.path.join(data, "load.json")
    if refresh or not os.path.exists(path):
        start = dt.datetime.combine(day(cfg["measured_from"]), dt.time(), TZ).astimezone(UTC)
        cmd = {"type": "recorder/statistics_during_period", "start_time": start.isoformat(),
               "end_time": dt.datetime.now(UTC).isoformat(), "statistic_ids": [cfg["estfeed_statistic"]],
               "period": "hour", "types": ["change"]}
        run = subprocess.run([sys.executable, os.path.join(HERE, "ha-ws.py"), json.dumps(cmd)],
                             stdout=subprocess.PIPE, text=True)  # stderr passes through: auth and network errors
        if run.returncode:
            sys.exit("load: ha-ws.py failed (above)")
        out = run.stdout
        with open(path, "w") as f:
            f.write(out)
        print("load", len(json.loads(out)[cfg["estfeed_statistic"]]), "hours")
    for year in sorted({cfg["frame_year"], *cfg["price_years"]}):
        path = os.path.join(data, f"prices-{year}.json")
        if os.path.exists(path) and not refresh and year < today.year:
            last = max(map(int, json.load(open(path))))
            if last >= utc_ts(dt.date(year, 12, 31), 23):  # a year cached before it ended is fetched again
                continue
        hourly = {}
        for q in range(4):
            a = dt.date(year, 3 * q + 1, 1)
            if a > today:
                break
            b = dt.date(year, 3 * q + 4, 1) if q < 3 else dt.date(year + 1, 1, 1)
            url = f"https://dashboard.elering.ee/api/nps/price?start={a}T00:00:00.000Z&end={b}T00:00:00.000Z"
            for r in get_json(url)["data"]["ee"]:
                hourly.setdefault(r["timestamp"] - r["timestamp"] % 3600, []).append(r["price"])
        # Quarter-hour prices from October 2025 on, averaged to hours; EUR/MWh -> EUR/kWh.
        with open(path, "w") as f:
            json.dump({str(h): sum(v) / len(v) / 1000 for h, v in hourly.items()}, f)
        print("prices", year, len(hourly), "hours")
    path = os.path.join(data, "pv.json")
    if refresh_pv or not os.path.exists(path):
        p, loc = cfg["pv"], cfg["location"]
        url = ("https://re.jrc.ec.europa.eu/api/v5_3/seriescalc?pvcalculation=1&peakpower=1&outputformat=json"
               f"&lat={loc['lat']}&lon={loc['lon']}&angle={p['angle']}&aspect={p['aspect']}&loss={p['loss']}"
               f"&startyear={p['years'][0]}&endyear={p['years'][1]}")
        hourly = {r["time"][:11]: r["P"] / 1000 for r in get_json(url)["outputs"]["hourly"]}
        with open(path, "w") as f:
            json.dump(hourly, f)
        print("pv", len(hourly), "hours")


# ---------- model ----------

def build_model(cfg, data):
    import numpy as np
    fy = cfg["frame_year"]
    days = [dt.date(fy, 1, 1) + dt.timedelta(n) for n in range((dt.date(fy + 1, 1, 1) - dt.date(fy, 1, 1)).days)]
    ts = [utc_ts(d, h) for d in days for h in range(24)]

    stat = json.load(open(os.path.join(data, "load.json")))[cfg["estfeed_statistic"]]
    meas = {r["start"] // 1000: r["change"] for r in stat}
    mdays = {}
    d = day(cfg["measured_from"])
    while d < dt.date.today():
        v = [meas.get(utc_ts(d, h)) for h in range(24)]
        if all(x is not None for x in v):
            mdays[d] = np.array(v)
        d += dt.timedelta(1)
    weekday = lambda d: d.weekday() < 5
    pools = {}
    for name, (a, b) in cfg["templates"].items():
        a, b = day(a), day(b) if b else dt.date.max
        for wk in (True, False):
            pools[(name, wk)] = [d for d in mdays if a <= d <= b and weekday(d) == wk]
            if not pools[(name, wk)]:
                sys.exit(f"template {name}: no measured {'weekdays' if wk else 'weekend days'} in its range")
    turn = {k: 0 for k in pools}
    load, measured = [], 0
    for d in days:
        twins = [d + k * WEEK52 for k in range(4) if d + k * WEEK52 in mdays]
        if twins:
            load.append(mdays[twins[-1]]); measured += 1
            continue
        pool, add = cfg["month_templates"][str(d.month)]
        key = (pool, weekday(d)); p = pools[key]; turn[key] += 1
        days_in_month = ((d.replace(day=28) + dt.timedelta(4)).replace(day=1) - d.replace(day=1)).days
        load.append(mdays[p[turn[key] % len(p)]] + add / days_in_month / 24)
    L = np.concatenate(load)

    frame_spot = {int(k): v for k, v in json.load(open(os.path.join(data, f"prices-{fy}.json"))).items()}
    # The first local hours of the frame fall in the previous UTC year: borrow the next day's.
    base = np.array([frame_spot.get(t, frame_spot.get(t + 86400)) for t in ts])
    spot = {}
    for y in cfg["price_years"]:
        s = {int(k): v for k, v in json.load(open(os.path.join(data, f"prices-{y}.json"))).items()}
        shift = int(((y - fy) * WEEK52).total_seconds())
        spot[str(y)] = np.array([s.get(t + shift, base[i]) for i, t in enumerate(ts)])

    t = cfg["tariff"]
    holidays = {day(h) for h in cfg["holidays"]}
    if any(h.year != fy for h in holidays):
        sys.exit(f"holidays must all be in frame_year {fy}")
    network = np.array([t["day"] if d.weekday() < 5 and d not in holidays and t["day_hours"][0] <= h < t["day_hours"][1]
                        else t["night"] for d in days for h in range(24)])
    buy = {y: (s + t["margin"] + t["fees"] + network) * (1 + t["vat"]) for y, s in spot.items()}
    sell = {y: s - t["sell_fee"] for y, s in spot.items()}

    pvh = {k: v for k, v in json.load(open(os.path.join(data, "pv.json"))).items()}
    pv = {}
    for y in range(cfg["pv"]["years"][0], cfg["pv"]["years"][1] + 1):
        out = []
        for x in ts:
            u = dt.datetime.fromtimestamp(x, UTC)
            out.append(pvh.get(f"{y}{u.month:02}{u.day:02}:{u.hour:02}", 0.0))
        pv[y] = np.array(out)

    local = [dt.datetime.fromtimestamp(x, TZ) for x in ts]
    return dict(cfg=cfg, days=days, L=L, buy=buy, sell=sell, pv=pv, measured_days=measured,
                month=np.array([x.month for x in local]), hour=np.array([x.hour for x in local]),
                workday=np.repeat([weekday(d) for d in days], 24))


def ev_profile(M, on):
    import numpy as np
    n = len(M["L"])
    drive, home = np.zeros(n), np.zeros(n)
    if on:
        ev = M["cfg"]["ev"]
        home[:] = 1
        for k, d in enumerate(M["days"]):
            per100 = ev["per100_winter"] if d.month in ev["winter_months"] else ev["per100_summer"]
            e = ev["km"] / len(M["days"]) / 100 * per100
            for h in ev["away_hours"]:
                drive[k * 24 + h] = e / len(ev["away_hours"])
                home[k * 24 + h] = 0
    return drive, home


def lp_day(M, load, pv, buy, sell, cap, s0, ev_on, ev0, drv, hm):
    """One horizon. Variables per hour: import, export, charge, discharge, soc, pv used, EV charge, EV soc."""
    import numpy as np
    from scipy.optimize import linprog
    from scipy.sparse import coo_matrix
    b_, ev = M["cfg"]["battery"], M["cfg"]["ev"]
    eta, ev_eta = b_["eta"], ev["eta"]
    lo, hi, end = (ev["min"], ev["max"], ev["end"]) if ev_on else (0, 0, 0)
    n = len(load)
    I, E, C, D, S, U, EC, ES = (np.arange(n) + k * n for k in range(8))
    cost = np.zeros(8 * n); cost[I] = buy; cost[E] = -sell; cost[D] = b_["wear"]
    rows, cols, vals, rhs = [], [], [], np.zeros(3 * n)
    def put(r, c, v): rows.append(r); cols.append(c); vals.append(v)
    for t in range(n):
        for c, v in ((U[t], 1), (I[t], 1), (D[t], eta), (E[t], -1), (C[t], -1), (EC[t], -1)):
            put(t, c, v)
        rhs[t] = load[t]
        put(n + t, S[t], 1); put(n + t, C[t], -eta); put(n + t, D[t], 1)
        put(2 * n + t, ES[t], 1); put(2 * n + t, EC[t], -ev_eta); rhs[2 * n + t] = -drv[t]
        if t:
            put(n + t, S[t - 1], -1); put(2 * n + t, ES[t - 1], -1)
        else:
            rhs[n] = s0; rhs[2 * n] += ev0
    A = coo_matrix((vals, (rows, cols)), shape=(3 * n, 8 * n)).tocsr()
    Au = coo_matrix(([1] * n + [-1] * n, (list(range(n)) * 2, list(E) + list(U))), shape=(n, 8 * n)).tocsr()
    bounds = ([(0, M["cfg"]["import_cap_kw"])] * n + [(0, None)] * n + [(0, cap * b_["c_rate"])] * 2 * n
              + [(0, cap)] * n + [(0, p) for p in pv] + [(0, ev["charger_kw"] * h) for h in hm]
              + [(lo, hi)] * (n - 1) + [(end, hi)])
    res = linprog(cost, A_ub=Au, b_ub=np.zeros(n), A_eq=A, b_eq=rhs, bounds=bounds, method="highs")
    if res.status != 0:
        raise RuntimeError(res.message)
    x = res.x
    return x[I], x[E], x[C], x[D], x[S][23], x[U], x[EC], x[ES][23]


def simulate(M, prices, kwp, cap, ev_on):
    import numpy as np
    n = len(M["L"])
    drive, home = ev_profile(M, ev_on)
    years = list(M["pv"]) if kwp else list(M["pv"])[:1]
    keys = ("imp", "exp", "ch", "dis", "u", "evc")
    runs = []
    for y in years:
        pv = M["pv"][y] * kwp
        out = {k: np.zeros(n) for k in keys}
        s, e0 = 0.0, (M["cfg"]["ev"]["start"] if ev_on else 0.0)
        for d0 in range(0, n, 24):
            sl = slice(d0, min(d0 + 48, n))
            i, e, c, d, s, u, ec, e0 = lp_day(M, M["L"][sl], pv[sl], M["buy"][prices][sl], M["sell"][prices][sl],
                                              cap, s, ev_on, e0, drive[sl], home[sl])
            for k, v in zip(keys, (i, e, c, d, u, ec)):
                out[k][d0:d0 + 24] = v[:24]
        out["pv"] = pv
        out["cost"] = ((out["imp"] * M["buy"][prices]).sum() - (out["exp"] * M["sell"][prices]).sum()
                       + 12 * M["cfg"]["tariff"]["monthly"] * (1 + M["cfg"]["tariff"]["vat"]))
        runs.append(out)
    mean = {k: np.mean([r[k] for r in runs], axis=0) for k in runs[0]}
    used = mean["u"] - mean["exp"]
    month, hour, wk = M["month"], M["hour"], M["workday"]
    monthly = lambda v: [round(float(v[month == m].sum())) for m in range(1, 13)]
    prof = lambda v, m: [round(float(v[(month == m) & wk & (hour == h)].mean()), 2) for h in range(24)]
    r = dict(prices=prices, kwp=kwp, cap=cap, ev=ev_on, cost=round(float(mean["cost"]), 1),
             pv=round(float(mean["pv"].sum())), imp=round(float(mean["imp"].sum())), exp=round(float(mean["exp"].sum())),
             used=round(float(used.sum())), cycles=round(float(mean["dis"].sum() / cap)) if cap else 0,
             m_pv=monthly(mean["pv"]), m_used=monthly(used), m_imp=monthly(mean["imp"]), m_exp=monthly(mean["exp"]))
    for m, tag in ((6, "jun"), (1, "jan")):
        r[f"d_{tag}"] = {k: prof(mean[k], m) for k in ("pv", "imp", "exp", "ch", "dis", "evc")}
    return r


_M = None

def _init(cfg, data):
    global _M
    _M = build_model(cfg, data)

def _job(args):
    return simulate(_M, *args)


def grid(cfg, data, procs):
    import numpy as np
    M = build_model(cfg, data)
    print(f"load {round(M['L'].sum())} kWh/year, {M['measured_days']} measured days in the frame")
    g = cfg["grid"]
    jobs = [(str(p), k, c, e) for p in cfg["price_years"] for e in g["ev"] for c in g["battery_kwh"] for k in g["kwp"]]
    jobs.sort(key=lambda j: -(j[1] > 0) * (j[2] + 1))  # the slowest first
    with Pool(procs, initializer=_init, initargs=(cfg, data)) as pool:
        res = []
        for i, r in enumerate(pool.imap_unordered(_job, jobs), 1):
            res.append(r)
            print(f"\r{i}/{len(jobs)}", end="", flush=True)
    print()
    L, month, hour, wk = M["L"], M["month"], M["hour"], M["workday"]
    base = {"m_load": [round(float(L[month == m].sum()), 1) for m in range(1, 13)]}
    for m, tag in ((6, "jun"), (1, "jan")):
        base[f"d_{tag}_load"] = [round(float(L[(month == m) & wk & (hour == h)].mean()), 3) for h in range(24)]
    with open(os.path.join(data, "grid.json"), "w") as f:
        json.dump({"base": base, "grid": res}, f, separators=(",", ":"))


def summary(data):
    g = json.load(open(os.path.join(data, "grid.json")))["grid"]
    idx = {(r["prices"], r["kwp"], r["cap"], r["ev"]): r for r in g}
    print("savings EUR/year against no PV and no battery (battery at the upper bound)")
    print(f"{'prices':>6} {'EV':>3} {'kWp':>4} {'kWh':>4} {'saving':>7} {'used %':>7} {'cycles':>6}")
    for (p, k, c, e), r in sorted(idx.items()):
        if k not in (0, 4, 8, 12, 15) or (k, c) == (0, 0):
            continue
        b = idx[(p, 0, 0, e)]
        used = f"{100 * r['used'] / r['pv']:.0f}" if r["pv"] else "-"
        print(f"{p:>6} {e:>3} {k:>4} {c:>4} {b['cost'] - r['cost']:>7.0f} {used:>7} {r['cycles']:>6}")


def page(data, src, dst):
    with open(src, encoding="utf-8") as f:
        html = f.read()
    blob = open(os.path.join(data, "grid.json")).read()
    new, n = re.subn(r"^const DATA = .*;$", lambda _: f"const DATA = {blob};", html, count=1, flags=re.M)
    if n != 1:
        sys.exit(f"{src}: no `const DATA = ...;` line")
    with open(dst, "w", encoding="utf-8") as f:
        f.write(new)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cmd", choices=("fetch", "grid", "summary", "page"))
    ap.add_argument("config", nargs="?")
    ap.add_argument("--data", required=True)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--refresh-pv", action="store_true")
    ap.add_argument("--procs", type=int, default=os.cpu_count())
    ap.add_argument("--page-in")
    ap.add_argument("--page-out")
    a = ap.parse_args()
    if a.cmd in ("fetch", "grid") and not a.config:
        ap.error(f"{a.cmd} needs CONFIG")
    if a.cmd == "fetch":
        fetch(read_config(a.config), a.data, a.refresh, a.refresh_pv)
    elif a.cmd == "grid":
        grid(read_config(a.config), a.data, a.procs)
    elif a.cmd == "summary":
        summary(a.data)
    else:
        if not (a.page_in and a.page_out):
            ap.error("page needs --page-in and --page-out")
        page(a.data, a.page_in, a.page_out)


if __name__ == "__main__":
    main()
