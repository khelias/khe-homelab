#!/usr/bin/env python3
"""Read and validate the house 3D model for the HA card and the standalone viewer.

The model lives in the private khe-meta repo (house/house-model.md) as four fenced
blocks plus the optional surroundings, each with the info string `json house3d:<layer>`:

  geometry      walls, roofs, furniture, site            shareable
  rooms         rooms with neutral names                 shareable
  private       family room names, every HA device and   HA only, never published
                the car (profile and drive-in path)
  showcase      title, room texts, feature points        standalone viewer only
  surroundings  neighbouring buildings and the street,   HA only, never published
                machine-written by house3d-surroundings.py

Each block is a JSON object; merging layers is a plain union of their keys. The car
is optional; when present, validation checks its profile and that its path ends with
the car parked straight inside its room. With site.gates, the gate the car's path
crosses is the drive gate, and the path has to start far enough out for the car to
clear it while it opens.

Usage:  house3d_model.py --check FILE
        house3d_model.py --layers geometry,rooms,showcase FILE   (or --layers all)
Import: load(path, layers), validate(layers), private_strings(model)
"""
import argparse, json, math, re, sys

REQUIRED = ("geometry", "rooms", "private", "showcase")
LAYERS = REQUIRED + ("surroundings",)
PUBLIC = ("geometry", "rooms", "showcase")
OUTDOOR = "oues"
GATE_KINDS = ("sliding", "swing1", "swing2")
SLIDE_OFFSET = 0.12  # a sliding leaf runs this far to the lot side of the fence line, past its rails
CAR_CLEARANCE = 0.3  # between the car and a gate leaf's sweep
BLOCK = re.compile(r"^```json house3d:(\w+)[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)


def read_layers(path):
    """Return {layer: dict} for every house3d block in the Markdown file."""
    with open(path, encoding="utf-8") as f:
        return parse_layers(f.read())


def parse_layers(text):
    """read_layers for Markdown already in memory."""
    layers = {}
    for name, body in BLOCK.findall(text):
        if name in layers:
            raise ValueError(f"layer {name} appears twice")
        layers[name] = json.loads(body)
    return layers


def merge(layers, names):
    out = {}
    for name in names:
        for key, value in layers.get(name, {}).items():
            if key in out:
                raise ValueError(f"key {key} is in more than one layer")
            out[key] = value
    return out


def load(path, names=LAYERS):
    return merge(read_layers(path), names)


def with_room_names(model):
    """A merged model that includes the private layer, with the family room names in place
    of the neutral ones and room_names removed."""
    names = model.pop("room_names", {})
    # new room dicts: merge() shares them with the layers, and the rooms layer is shareable
    model["rooms"] = [dict(r, name=names.get(r["id"], r["name"])) for r in model["rooms"]]
    return model


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _point(v, n=2):
    return isinstance(v, list) and len(v) == n and all(_num(x) for x in v)


def _rect(v):
    return _point(v, 4) and v[0] < v[2] and v[1] < v[3]


def _area(ring):
    return abs(sum(x0 * z1 - x1 * z0 for (x0, z0), (x1, z1) in zip(ring, ring[1:] + ring[:1]))) / 2


def _cross(o, a, b):
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])


def _segments_cross(p, q, a, b):
    """True when segment p-q meets segment a-b (touching counts)."""
    d1, d2, d3, d4 = _cross(a, b, p), _cross(a, b, q), _cross(p, q, a), _cross(p, q, b)
    if ((d1 > 0) != (d2 > 0) or d1 == 0 or d2 == 0) and ((d3 > 0) != (d4 > 0) or d3 == 0 or d4 == 0):
        return min(p[0], q[0]) <= max(a[0], b[0]) and min(a[0], b[0]) <= max(p[0], q[0]) and \
            min(p[1], q[1]) <= max(a[1], b[1]) and min(a[1], b[1]) <= max(p[1], q[1])
    return False


def _crossing(ring):
    """The first pair of non-adjacent edges (indexes) of a closed ring that meet, or None."""
    edges = list(zip(ring, ring[1:] + ring[:1]))
    n = len(edges)
    for i in range(n):
        for j in range(i + 2, n):
            if (i, j) != (0, n - 1) and _segments_cross(*edges[i], *edges[j]):
                return i, j
    return None


def gate_sweep(gate):
    """(out, in): how far a gate's leaves reach to the street side and to the lot side of its line."""
    w = math.dist(gate["a"], gate["b"])
    if gate["kind"] == "sliding":
        return 0.0, SLIDE_OFFSET
    reach = w if gate["kind"] == "swing1" else w / 2
    return (reach, 0.0) if gate["opens"] == "out" else (0.0, reach)


def gate_inward(gate, lot):
    """The unit normal of a gate's line that points into the lot (towards the lot's bbox centre,
    as the engine does)."""
    (ax, az), (bx, bz) = gate["a"], gate["b"]
    w = math.dist(gate["a"], gate["b"])
    nx, nz = -(bz - az) / w, (bx - ax) / w
    cx = (min(p[0] for p in lot) + max(p[0] for p in lot)) / 2
    cz = (min(p[1] for p in lot) + max(p[1] for p in lot)) / 2
    return (nx, nz) if (cx - ax) * nx + (cz - az) * nz >= 0 else (-nx, -nz)


def drive_gates(model):
    """Indexes of the gates in site.gates that the car's path, as straight legs, crosses."""
    path = (model.get("car") or {}).get("path") or []
    gates = (model.get("site") or {}).get("gates") or []
    return [i for i, g in enumerate(gates) if isinstance(g, dict) and _point(g.get("a")) and _point(g.get("b"))
            and any(_segments_cross(p, q, g["a"], g["b"]) for p, q in zip(path, path[1:]))]


def validate(layers):
    """Return a list of problems, empty when the model is usable."""
    problems = []
    bad = problems.append
    for name in LAYERS:
        if name not in layers:
            if name in REQUIRED:
                bad(f"layer {name} is missing")
        elif not isinstance(layers[name], dict):
            bad(f"layer {name} is not a JSON object")
    if problems:
        return problems
    try:
        model = merge(layers, LAYERS)
    except ValueError as e:
        return [str(e)]

    def rect(where, v):
        if not _rect(v):
            bad(f"{where}: rect {v} is not [x0, z0, x1, z1] with x0 < x1 and z0 < z1")

    def ids(where, values):
        seen = set()
        for v in values:
            if v in seen:
                bad(f"{where}: id {v!r} is not unique")
            seen.add(v)

    roofs = model.get("roofs", {})
    if not isinstance(roofs, dict) or not roofs:
        bad("geometry: roofs missing")
        roofs = {}
    for rid, roof in roofs.items():
        if not all(_point(p) for p in roof.get("outline", [])) or len(roof.get("outline", [])) < 3:
            bad(f"roof {rid}: outline needs three or more [x, z] points")
        if not (_num(roof.get("pitch_deg")) or _num(roof.get("slope"))):
            bad(f"roof {rid}: needs pitch_deg or slope")
        for k in ("high_x", "high_y", "thick"):
            if not _num(roof.get(k)):
                bad(f"roof {rid}: {k} is not a number")
        if roof.get("falls") not in ("east", "west"):
            bad(f"roof {rid}: falls must be east or west (heights run along x)")
    for i, s in enumerate(model.get("roof_steps", [])):
        if not (_point(s.get("a")) and _point(s.get("b"))):
            bad(f"roof_steps[{i}]: a and b must be [x, z]")
        for k in ("top", "bot"):
            if s.get(k) not in roofs:
                bad(f"roof_steps[{i}]: {k} {s.get(k)!r} is not a roof")
    if not _num(model.get("ceiling")):
        bad("geometry: ceiling is not a number")

    for i, w in enumerate(model.get("walls", [])):
        where = f"walls[{i}]"
        if not (_point(w.get("a")) and _point(w.get("b"))):
            bad(f"{where}: a and b must be [x, z]")
            continue
        if not _num(w.get("t")) or w["t"] <= 0:
            bad(f"{where}: t is not a positive number")
        top = w.get("top")
        if not (_num(top) or top in roofs):
            bad(f"{where}: top {top!r} is neither a height nor a roof id")
        if "cut" in w and not _num(w["cut"]):
            bad(f"{where}: cut is not a number")
        if "finish" in w and w["finish"] != "panel":
            bad(f"{where}: finish {w['finish']!r} is not panel")
        length = math.dist(w["a"], w["b"])
        for j, o in enumerate(w.get("openings", [])):
            if not all(_num(o.get(k)) for k in ("c", "w", "h")):
                bad(f"{where}.openings[{j}]: c, w and h must be numbers")
                continue
            if o.get("kind") not in ("window", "door", "glassdoor"):
                bad(f"{where}.openings[{j}]: kind {o.get('kind')!r} is not window, door or glassdoor")
            if o.get("kind") == "window" and not _num(o.get("sill")):
                bad(f"{where}.openings[{j}]: a window needs a sill")
            if o["c"] - o["w"] / 2 < -1e-6 or o["c"] + o["w"] / 2 > length + 1e-6:
                bad(f"{where}.openings[{j}]: span {o['c'] - o['w'] / 2:.3f}..{o['c'] + o['w'] / 2:.3f} "
                    f"is outside the wall (length {length:.3f})")

    for i, f in enumerate(model.get("furniture", [])):
        where = f"furniture[{i}]"
        if "rect" in f:
            rect(where, f["rect"])
        elif not (_point(f.get("circle"), 3) and f["circle"][2] > 0):
            bad(f"{where}: needs rect [x0, z0, x1, z1] or circle [x, z, r]")
        if not (_point(f.get("y")) and f["y"][0] < f["y"][1]):
            bad(f"{where}: y must be [y0, y1] with y0 < y1")

    site = model.get("site", {})
    if not (isinstance(site.get("lot"), list) and len(site["lot"]) >= 3 and all(_point(p) for p in site["lot"])):
        bad("site: lot needs three or more [x, z] points")
    for key in ("hedges", "fences"):
        for i, seg in enumerate(site.get(key, [])):
            if not (isinstance(seg, list) and len(seg) == 2 and all(_point(p) for p in seg)):
                bad(f"site.{key}[{i}]: must be [[x, z], [x, z]]")
    # an item is a rect [x0, z0, x1, z1] or an outline [[x, z], ...]; one problem per item
    for key in ("decks", "paving"):
        for i, v in enumerate(site.get(key, [])):
            where = f"site.{key}[{i}]"
            if not (isinstance(v, list) and v and isinstance(v[0], list)):
                rect(where, v)
            elif not (len(v) >= 3 and all(_point(p) for p in v)):
                bad(f"{where}: an outline needs three or more [x, z] points")
            elif _area(v) < 1:
                bad(f"{where}: outline area {_area(v):.2f} m2 is under 1 m2")
            elif any(p == q for p, q in zip(v, v[1:] + v[:1])):
                bad(f"{where}: outline repeats a point (it closes by itself, do not repeat the first point)")
            elif (c := _crossing(v)):
                bad(f"{where}: outline edges {c[0]} and {c[1]} cross")
    for key in ("porch",):
        if key in site:
            rect(f"site.{key}", site[key])
    for key in ("sandpit", "swing", "pergola"):
        if key in site:
            rect(f"site.{key}", site[key].get("rect"))
    if "garage_roof" in site:
        gr = site["garage_roof"]
        if ("rect" in gr) == ("rects" in gr):
            bad("site.garage_roof: needs either rect or rects")
        elif "rect" in gr:
            rect("site.garage_roof", gr["rect"])
        elif not (isinstance(gr["rects"], list) and gr["rects"]):
            bad("site.garage_roof.rects: not a non-empty list")
        else:
            for i, r in enumerate(gr["rects"]):
                rect(f"site.garage_roof.rects[{i}]", r)
        if not (_point(gr.get("y")) and gr["y"][0] < gr["y"][1]):
            bad("site.garage_roof: y must be [y0, y1] with y0 < y1")
    for i, u in enumerate(site.get("outdoor_units", [])):
        rect(f"site.outdoor_units[{i}]", u.get("rect"))
        if not (_point(u.get("y")) and u["y"][0] < u["y"][1]):
            bad(f"site.outdoor_units[{i}]: y must be [y0, y1] with y0 < y1")
    good_gates = _validate_gates(site.get("gates", []), bad)
    trees = site.get("trees", [])
    if not isinstance(trees, list):
        bad("site.trees: not a list")
        trees = []
    ids("site.trees", [t["id"] for t in trees if isinstance(t, dict) and isinstance(t.get("id"), str)])
    for i, t in enumerate(trees):
        if not isinstance(t, dict):
            bad(f"site.trees[{i}]: not a JSON object")
            continue
        if isinstance(t.get("id"), str) and t["id"]:
            where = f"tree {t['id']}"
        else:
            where = f"site.trees[{i}]"
            bad(f"{where}: id is not a non-empty string")
        if not (isinstance(t.get("kind"), str) and t["kind"]):
            bad(f"{where}: kind missing")
        if not _point(t.get("pos")):
            bad(f"{where}: pos must be [x, z]")
        for k in ("height", "crown"):
            if not (_num(t.get(k)) and t[k] > 0):
                bad(f"{where}: {k} is not a positive number")

    rooms = model.get("rooms", [])
    room_ids = [r.get("id") for r in rooms]
    ids("rooms", room_ids)
    if OUTDOOR in room_ids:
        bad(f"rooms: {OUTDOOR!r} is reserved for outdoor devices")
    for r in rooms:
        where = f"room {r.get('id')}"
        if not (isinstance(r.get("name"), str) and r["name"]):
            bad(f"{where}: name missing")
        if not r.get("rects"):
            bad(f"{where}: rects missing")
        for q in r.get("rects", []):
            rect(where, q)
        if "label" in r and not _point(r["label"]):
            bad(f"{where}: label must be [x, z]")

    known = set(room_ids)
    for rid in model.get("room_names", {}):
        if rid not in known:
            bad(f"private.room_names: {rid!r} is not a room")
    devices = model.get("devices", [])
    ids("devices", [d.get("entity") for d in devices])
    for d in devices:
        where = f"device {d.get('entity')}"
        if not (isinstance(d.get("entity"), str) and "." in d["entity"]):
            bad(f"{where}: entity is not an entity id")
        if not (isinstance(d.get("name"), str) and d["name"]):
            bad(f"{where}: name missing")
        if d.get("room") != OUTDOOR and d.get("room") not in known:
            bad(f"{where}: room {d.get('room')!r} does not exist")
        if not _point(d.get("pos"), 3):
            bad(f"{where}: pos must be [x, y, z]")
        if "look" in d and not _point(d["look"]):
            bad(f"{where}: look must be [dx, dz]")

    car_ok = False
    if "car" in model:
        n = len(problems)
        _validate_car(model["car"], {r.get("id"): r for r in rooms}, bad)
        car_ok = len(problems) == n
    lot = site.get("lot")
    if car_ok and site.get("gates") and isinstance(lot, list) and len(lot) >= 3 and all(_point(p) for p in lot):
        _validate_drive(model, good_gates, bad)
    if "surroundings" in layers:
        _validate_surroundings(layers["surroundings"], bad)

    show = model.get("showcase", {})
    for rid in show.get("rooms", {}):
        if rid not in known:
            bad(f"showcase.rooms: {rid!r} is not a room")
    features = show.get("features", [])
    ids("showcase.features", [f.get("id") for f in features])
    for f in features:
        if not _point(f.get("pos"), 3):
            bad(f"showcase feature {f.get('id')}: pos must be [x, y, z]")
    return problems


def _validate_gates(gates, bad):
    """Check site.gates; return the indexes of the gates that are whole."""
    if not isinstance(gates, list):
        bad("site.gates: not a list")
        return set()
    good, placed = set(), []
    for i, g in enumerate(gates):
        where = f"site.gates[{i}]"
        if not isinstance(g, dict):
            bad(f"{where}: not a JSON object")
            continue
        if isinstance(g.get("name"), str) and g["name"]:
            where = f"gate {g['name']}"
        elif "name" in g:
            bad(f"{where}: name is not a non-empty string")
        n = 0
        if _point(g.get("a")) and _point(g.get("b")) and math.dist(g["a"], g["b"]) > 0:
            placed.append(i)
        else:
            bad(f"{where}: a and b must be two distinct [x, z] points")
            n += 1
        if not (_num(g.get("height")) and g["height"] > 0):
            bad(f"{where}: height is not a positive number")
            n += 1
        kind = g.get("kind")
        if kind not in GATE_KINDS:
            bad(f"{where}: kind {kind!r} is not {', '.join(GATE_KINDS[:-1])} or {GATE_KINDS[-1]}")
            n += 1
        elif kind == "sliding" and g.get("slide") not in ("a", "b"):
            bad(f"{where}: a sliding gate needs slide a or b, the end its leaf slides past")
            n += 1
        elif kind != "sliding" and g.get("opens") not in ("in", "out"):
            bad(f"{where}: a swing gate needs opens in or out")
            n += 1
        if not n:
            good.add(i)
    # two gates on one line may share a post, not a stretch of the line
    for i in placed:
        g = gates[i]
        w = math.dist(g["a"], g["b"])
        ux, uz = (g["b"][0] - g["a"][0]) / w, (g["b"][1] - g["a"][1]) / w
        for j in (j for j in placed if j > i):
            h = gates[j]
            if any(abs(_cross(g["a"], g["b"], p)) / w > 0.01 for p in (h["a"], h["b"])):
                continue
            along = lambda p: (p[0] - g["a"][0]) * ux + (p[1] - g["a"][1]) * uz
            lo, hi = sorted((along(h["a"]), along(h["b"])))
            if min(w, hi) - max(0, lo) > 1e-6:
                bad(f"site.gates[{i}] and site.gates[{j}] overlap along their line")
    return good


def _validate_drive(model, good, bad):
    """The car must stand wholly outside the drive gate, clear of its leaves, before it opens."""
    gates = model["site"]["gates"]
    crossed = drive_gates(model)
    if len(crossed) > 1:
        return bad(f"car: path crosses {len(crossed)} gates (site.gates {crossed}); at most one may be the drive gate")
    if not crossed or crossed[0] not in good:
        return
    g = gates[crossed[0]]
    nx, nz = gate_inward(g, model["site"]["lot"])
    start = model["car"]["path"][0]
    before = -((start[0] - g["a"][0]) * nx + (start[1] - g["a"][1]) * nz)
    out = gate_sweep(g)[0]
    need = model["car"]["profile"]["length"] / 2 + out + CAR_CLEARANCE
    if before < need - 1e-6:
        bad(f"car: path starts {before:.2f} m before the drive gate's line, needs {need:.2f} m "
            f"(half the car, the leaves' outward sweep {out:.2f} m and {CAR_CLEARANCE} m)")


def _ring(where, ring, bad):
    if not (isinstance(ring, list) and len(ring) >= 3 and all(_point(p) for p in ring)):
        return bad(f"{where}: needs three or more [x, z] points")
    if _area(ring) < 1:
        bad(f"{where}: area {_area(ring):.2f} m2 is under 1 m2")


def _validate_surroundings(layer, bad):
    if set(layer) != {"surroundings"}:
        return bad(f"layer surroundings: holds {sorted(layer)}, only the key surroundings belongs there")
    s = layer["surroundings"]
    if not isinstance(s, dict):
        return bad("surroundings: not a JSON object")
    if not (isinstance(s.get("source"), str) and s["source"].strip()):
        bad("surroundings: source is not a non-empty string")
    for key in ("buildings", "roads"):
        if not isinstance(s.get(key), list):
            bad(f"surroundings: {key} is not a list")
    for i, b in enumerate(s.get("buildings") if isinstance(s.get("buildings"), list) else []):
        where = f"surroundings.buildings[{i}]"
        if not isinstance(b, dict):
            bad(f"{where}: not a JSON object")
            continue
        _ring(f"{where}.outline", b.get("outline"), bad)
        if not (_num(b.get("height")) and 0 < b["height"] <= 100):
            bad(f"{where}: height {b.get('height')!r} is not in (0, 100]")
        if "assumed" in b and not isinstance(b["assumed"], bool):
            bad(f"{where}: assumed is not true or false")
    for i, r in enumerate(s.get("roads") if isinstance(s.get("roads"), list) else []):
        where = f"surroundings.roads[{i}]"
        if not isinstance(r, dict):
            bad(f"{where}: not a JSON object")
            continue
        _ring(f"{where}.outline", r.get("outline"), bad)
        holes = r.get("holes", [])
        if not isinstance(holes, list):
            bad(f"{where}: holes is not a list")
            continue
        for j, h in enumerate(holes):
            _ring(f"{where}.holes[{j}]", h, bad)


def _validate_car(car, rooms, bad):
    if not isinstance(car, dict):
        return bad("car: not a JSON object")
    if "entity" in car and not (isinstance(car["entity"], str) and "." in car["entity"]):
        bad("car: entity is not an entity id")
    if not (isinstance(car.get("name"), str) and car["name"]):
        bad("car: name missing")
    room = rooms.get(car.get("room")) if isinstance(car.get("room"), str) else None
    if not room:
        bad(f"car: room {car.get('room')!r} does not exist")

    prof = car.get("profile")
    if not isinstance(prof, dict):
        return bad("car: profile is not a JSON object")
    dims_ok = True
    for k in ("length", "width", "height"):
        if not (_num(prof.get(k)) and prof[k] > 0):
            bad(f"car.profile: {k} is not a positive number")
            dims_ok = False
    for k in ("side", "glass"):
        pts = prof.get(k)
        if not (isinstance(pts, list) and len(pts) >= 3 and all(_point(p) for p in pts)):
            bad(f"car.profile: {k} needs three or more [x, y] points")
    wheels = prof.get("wheels")
    if not (isinstance(wheels, dict) and _num(wheels.get("r")) and wheels["r"] > 0
            and _point(wheels.get("x")) and _num(wheels.get("track")) and wheels["track"] > 0):
        bad("car.profile: wheels needs r > 0, x [rear, front] and a positive track")
    lights = prof.get("lights")
    if not isinstance(lights, dict):
        bad("car.profile: lights is not a JSON object")
    else:
        for k in ("front", "rear"):
            segs = lights.get(k, [])
            if not (isinstance(segs, list) and all(isinstance(s, list) and len(s) == 2 and all(_point(p, 3) for p in s) for s in segs)):
                bad(f"car.profile.lights: {k} must be a list of [[x, y, z], [x, y, z]] segments")

    path = car.get("path")
    if not (isinstance(path, list) and len(path) >= 3 and all(_point(p) for p in path)):
        return bad("car: path needs three or more [x, z] points")
    a, b, c = path[-3:]
    if math.dist(a, c) == 0 or math.dist(b, c) == 0:
        return bad("car: path's last three points do not set a direction")
    # distance of the middle point from the line through the outer two
    off = abs((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / math.dist(a, c)
    if off > 0.01:
        bad(f"car: path's last three points are {off:.3f} m off a straight line (1 cm allowed)")
    if not (room and dims_ok):
        return
    # the parked footprint, turned along the last segment, must fit one of the room's rects
    b, c = path[-2:]
    ux, uz = (c[0] - b[0]) / math.dist(b, c), (c[1] - b[1]) / math.dist(b, c)
    hl, hw = prof["length"] / 2, prof["width"] / 2
    corners = [(c[0] + ux * s * hl - uz * t * hw, c[1] + uz * s * hl + ux * t * hw) for s in (-1, 1) for t in (-1, 1)]
    inside = lambda q: all(q[0] - 1e-6 <= x <= q[2] + 1e-6 and q[1] - 1e-6 <= z <= q[3] + 1e-6 for x, z in corners)
    if not any(_rect(q) and inside(q) for q in room.get("rects", [])):
        span = ", ".join(f"[{x:.2f}, {z:.2f}]" for x, z in corners)
        bad(f"car: path ends with the car outside room {car['room']} (corners {span})")


def private_strings(model):
    """Every string a public output must not contain: entity ids, device names,
    family room names and the car's entity and name. Pass a model that includes the
    private layer."""
    out = set()
    for d in model.get("devices", []):
        out.update(s for s in (d.get("entity"), d.get("name")) if s)
    out.update(model.get("room_names", {}).values())
    car = model.get("car") or {}
    out.update(s for s in (car.get("entity"), car.get("name")) if isinstance(s, str) and s)
    return sorted(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--check", action="store_true", help="validate and print one line per problem")
    g.add_argument("--layers", help="comma-separated layers to merge and print as JSON, or 'all'")
    ap.add_argument("file")
    a = ap.parse_args(argv)
    try:
        layers = read_layers(a.file)
    except (OSError, ValueError) as e:
        print(f"{a.file}: {e}")
        return 1
    if a.check:
        problems = validate(layers)
        for p in problems:
            print(p)
        if not problems:
            print(f"{a.file}: ok ({', '.join(sorted(layers))})")
        return 1 if problems else 0
    # all: the required layers, and the optional ones the file has
    names = tuple(n for n in LAYERS if n in REQUIRED or n in layers) if a.layers == "all" else tuple(a.layers.split(","))
    unknown = [n for n in names if n not in LAYERS]
    if unknown:
        print(f"unknown layer(s): {', '.join(unknown)}")
        return 2
    missing = [n for n in names if n not in layers]
    if missing:
        print(f"{a.file}: layer(s) not in the file: {', '.join(missing)}")
        return 1
    json.dump(merge(layers, names), sys.stdout, ensure_ascii=False, indent=1)
    print()
    return 0


if __name__ == "__main__":
    sys.exit(main())
