#!/usr/bin/env python3
"""Import an Elektrilevi hourly consumption CSV into Home Assistant statistics.

Creates two external statistics the Energy dashboard can use as grid import:
  elektrilevi:grid_consumption  (kWh, cumulative)
  elektrilevi:grid_cost         (EUR incl. VAT, cumulative)
Cost per hour = kWh * ((spot + grid transfer + fees) * VAT + supplier margin),
spot from Elering's public API (15-min EE prices averaged per hour), grid
tariff from the CSV's own Päev/Öö column (Elektrilevi already applies
weekends and public holidays there). Constants mirror
services/home/homeassistant/config/packages/energy_price.yaml.

Idempotent: re-running overwrites the same hours. The cumulative sums start
at the first row of the file, so ALWAYS export from the same start date
(contract start 2026-08-12) up to today; a later export that starts mid-way
would restart the sum and corrupt the totals.

Usage:  import-elektrilevi.py <csv> [--dry-run]
Needs:  python3 with `websockets` (pip install websockets), a long-lived HA
        token in ~/.config/khe/ha-token, HA reachable at 192.168.0.11:8123.
"""
import asyncio, csv, json, os, sys, urllib.request
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

HA = "192.168.0.11:8123"
TZ = ZoneInfo("Europe/Tallinn")
GRID = {"Päev": 0.0369, "Öö": 0.021, "Tipp päev": 0.0369, "Tipp öö": 0.021}  # EUR/kWh excl. VAT
FEES = 0.0084 + 0.00758 + 0.0021 + 0.00373   # renewable + security of supply + excise + balancing
VAT = 1.24
MARGIN = 0.0047                               # Alexela, EUR/kWh incl. VAT

def read_csv(path):
    rows = []
    with open(path, encoding="utf-8-sig") as f:
        for line in f:
            parts = line.rstrip("\n").split(";")
            if len(parts) < 3: continue
            try:
                start = datetime.strptime(parts[0], "%d.%m.%Y %H:%M").replace(tzinfo=TZ)
            except ValueError:
                continue
            tariff, kwh = parts[1], float(parts[2].replace(",", "."))
            if tariff not in GRID: sys.exit(f"unknown tariff label {tariff!r} at {parts[0]}")
            rows.append((start.astimezone(timezone.utc), tariff, kwh))
    if not rows: sys.exit("no data rows found")
    return rows

def elering_hourly(start, end):
    url = (f"https://dashboard.elering.ee/api/nps/price?start={start.strftime('%Y-%m-%dT%H:%M:%S.000Z')}"
           f"&end={end.strftime('%Y-%m-%dT%H:%M:%S.000Z')}")
    data = json.load(urllib.request.urlopen(url, timeout=30))["data"]["ee"]
    buckets = {}
    for p in data:
        t = datetime.fromtimestamp(p["timestamp"], timezone.utc).replace(minute=0, second=0)
        buckets.setdefault(t, []).append(p["price"] / 1000.0)   # EUR/MWh -> EUR/kWh
    return {t: sum(v) / len(v) for t, v in buckets.items()}

def main():
    if len(sys.argv) < 2: sys.exit(__doc__)
    path, dry = sys.argv[1], "--dry-run" in sys.argv
    rows = read_csv(path)
    prices = elering_hourly(rows[0][0] - timedelta(hours=1), rows[-1][0] + timedelta(hours=2))
    cons, cost, cum_kwh, cum_eur, missing = [], [], 0.0, 0.0, 0
    for start, tariff, kwh in rows:
        spot = prices.get(start)
        if spot is None: missing += 1; spot = 0.0
        eur = kwh * ((spot + GRID[tariff] + FEES) * VAT + MARGIN)
        cum_kwh += kwh; cum_eur += eur
        iso = start.isoformat()
        cons.append({"start": iso, "state": round(cum_kwh, 3), "sum": round(cum_kwh, 3)})
        cost.append({"start": iso, "state": round(cum_eur, 4), "sum": round(cum_eur, 4)})
    print(f"{len(rows)} hours, {rows[0][0].astimezone(TZ):%d.%m.%Y} .. {rows[-1][0].astimezone(TZ):%d.%m.%Y %H:%M}")
    print(f"total {cum_kwh:.3f} kWh, variable cost {cum_eur:.2f} EUR incl. VAT (monthly fees excluded), hours without price: {missing}")
    if dry: return
    import websockets
    token = open(os.path.expanduser("~/.config/khe/ha-token")).read().strip()
    async def push():
        async with websockets.connect(f"ws://{HA}/api/websocket", max_size=2**26) as ws:
            await ws.recv(); await ws.send(json.dumps({"type": "auth", "access_token": token}))
            assert json.loads(await ws.recv())["type"] == "auth_ok"
            for i, (sid, name, unit, stats) in enumerate([
                ("elektrilevi:grid_consumption", "Võrgutarbimine (Elektrilevi)", "kWh", cons),
                ("elektrilevi:grid_cost", "Võrgutarbimise kulu (Elektrilevi)", "EUR", cost)], 1):
                await ws.send(json.dumps({"id": i, "type": "recorder/import_statistics",
                    "metadata": {"has_mean": False, "has_sum": True, "name": name, "source": "elektrilevi",
                                 "statistic_id": sid, "unit_of_measurement": unit},
                    "stats": stats}))
                r = json.loads(await ws.recv())
                print(sid, "imported" if r.get("success") else r.get("error"))
    asyncio.run(push())

if __name__ == "__main__":
    main()
