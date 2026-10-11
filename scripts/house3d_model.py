#!/usr/bin/env python3
"""Read and validate the house 3D model for the HA card and the standalone viewer.

The model lives in the private khe-meta repo (house/house-model.md) as four fenced
blocks with the info string `json house3d:<layer>`:

  geometry  walls, roofs, furniture, site            shareable
  rooms     rooms with neutral names                 shareable
  private   family room names, every HA device and   HA only, never published
            the car (profile and drive-in path)
  showcase  title, room texts, feature points        standalone viewer only

Each block is a JSON object; merging layers is a plain union of their keys. The car
is optional; when present, validation checks its profile and that its path ends with
the car parked straight inside its room.

Usage:  house3d_model.py --check FILE
        house3d_model.py --layers geometry,rooms,showcase FILE   (or --layers all)
Import: load(path, layers), validate(layers), private_strings(model)
"""
import argparse, json, math, re, sys

LAYERS = ("geometry", "rooms", "private", "showcase")
PUBLIC = ("geometry", "rooms", "showcase")
OUTDOOR = "oues"
BLOCK = re.compile(r"^```json house3d:(\w+)[ \t]*\n(.*?)^```[ \t]*$", re.M | re.S)


def read_layers(path):
    """Return {layer: dict} for every house3d block in the Markdown file."""
    text = open(path, encoding="utf-8").read()
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


def _num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _point(v, n=2):
    return isinstance(v, list) and len(v) == n and all(_num(x) for x in v)


def _rect(v):
    return _point(v, 4) and v[0] < v[2] and v[1] < v[3]


def validate(layers):
    """Return a list of problems, empty when the model is usable."""
    problems = []
    bad = problems.append
    for name in LAYERS:
        if name not in layers:
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
    for key in ("decks", "paving"):
        for i, r in enumerate(site.get(key, [])):
            rect(f"site.{key}[{i}]", r)
    for key in ("porch",):
        if key in site:
            rect(f"site.{key}", site[key])
    for key in ("sandpit", "swing", "garage_roof", "pergola"):
        if key in site:
            rect(f"site.{key}", site[key].get("rect"))
    for i, u in enumerate(site.get("outdoor_units", [])):
        rect(f"site.outdoor_units[{i}]", u.get("rect"))
        if not (_point(u.get("y")) and u["y"][0] < u["y"][1]):
            bad(f"site.outdoor_units[{i}]: y must be [y0, y1] with y0 < y1")

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

    if "car" in model:
        _validate_car(model["car"], {r.get("id"): r for r in rooms}, bad)

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
    names = LAYERS if a.layers == "all" else tuple(a.layers.split(","))
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
