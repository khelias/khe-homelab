#!/usr/bin/env python3
"""Place the house 3D model's devices and trees on a 2D plan, and write the result back.

Usage:  house3d-place.py serve MODEL [PORT]         serve the placement page on 127.0.0.1
        house3d-place.py apply MODEL CHANGES.json   write the page's changes into MODEL

serve answers services/home/homeassistant/house3d/place.html with the geometry, rooms and
private layers of MODEL (khe-meta house/house-model.md), family room names applied. The
model is served from memory, so the private layer never lands next to the page. Default
port 8731.

apply takes the JSON the page's "Kopeeri muudatused" button copies,
{"devices": {entity: {pos, look?, room}}, "trees": {id: {pos, height, crown}}}, each group
only when it has changes, from a file or from stdin with '-' (pbpaste | ... apply MODEL -).
It rewrites those devices' lines in the private block and those trees' lines in the
geometry block's "trees" list, one item per line as before, and writes the file once. Any
other shape, an unknown entity or tree, a changed device height, a tree size that is not a
positive number or a model that no longer validates stops it before writing.
"""
import functools, http.server, json, math, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import house3d_model  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "services/home/homeassistant/house3d"
PRIVATE = "```json house3d:private"
GEOMETRY = "```json house3d:geometry"
SHAPE = ('changes must be {"devices": {entity: {pos: [x, y, z], look?, room?}}, '
         '"trees": {id: {pos: [x, z], height, crown}}}, each group only when it has changes, '
         'as the page copies them')


def checked(layers):
    problems = house3d_model.validate(layers)
    if problems:
        sys.exit("model problems:\n" + "\n".join(problems))
    return layers


def serve(model_path, port=8731):
    layers = checked(house3d_model.read_layers(model_path))
    model = house3d_model.with_room_names(house3d_model.merge(layers, ("geometry", "rooms", "private")))
    body = json.dumps(model, ensure_ascii=False).encode("utf-8")

    class Handler(http.server.SimpleHTTPRequestHandler):
        def do_GET(self):
            if self.path.split("?")[0] != "/model.json":
                return super().do_GET()
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    with http.server.ThreadingHTTPServer(("127.0.0.1", port), functools.partial(Handler, directory=str(SRC))) as httpd:
        print(f"http://127.0.0.1:{port}/place.html  (Ctrl+C stops)", flush=True)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass
    return 0


def parse_changes(raw):
    """The page's changes, type-checked before anything compares them."""
    try:
        changes = json.loads(raw)
    except ValueError as e:
        sys.exit(f"changes are not JSON ({e}); {SHAPE}")
    if not (isinstance(changes, dict) and changes and set(changes) <= {"devices", "trees"}
            and all(isinstance(g, dict) for g in changes.values())):
        sys.exit(SHAPE)
    for entity, c in changes.get("devices", {}).items():
        if not (isinstance(c, dict) and house3d_model._point(c.get("pos"), 3)):
            sys.exit(f"device {entity}: pos is not [x, y, z]; {SHAPE}")
    for tid, c in changes.get("trees", {}).items():
        if not isinstance(c, dict):
            sys.exit(f"tree {tid}: not an object; {SHAPE}")
        if not house3d_model._point(c.get("pos")):
            sys.exit(f"tree {tid}: pos {c.get('pos')!r} is not two numbers [x, z]")
        for k in ("height", "crown"):
            if not (house3d_model._num(c.get(k)) and c[k] > 0):
                sys.exit(f"tree {tid}: {k} {c.get(k)!r} is not a positive number")
    return changes


def block(lines, fence, path):
    """The line numbers inside a fenced block."""
    start = next((i for i, line in enumerate(lines) if line.rstrip() == fence), None)
    if start is None:
        sys.exit(f"{path}: no {fence} block")
    end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("```")), len(lines))
    return range(start + 1, end)


def rewrite(lines, i, item):
    """Write item over line i, keeping its indent and trailing comma."""
    line = lines[i].rstrip()
    indent = line[: len(line) - len(line.lstrip())]
    lines[i] = indent + json.dumps(item, ensure_ascii=False, separators=(",", ":")) + ("," if line.endswith(",") else "")


def apply_devices(lines, changes, path, report):
    seen = set()
    for i in block(lines, PRIVATE, path):
        text = lines[i].strip()
        if not text.startswith('{"entity"'):
            continue
        try:
            device = json.loads(text.rstrip(","))
        except ValueError:
            sys.exit(f"{path}:{i + 1}: not a whole device; the private block keeps one device per line")
        new = changes.get(device["entity"])
        if new is None:
            continue
        if new["pos"][1] != device["pos"][1]:
            sys.exit(f"{device['entity']}: height {device['pos'][1]} would become {new['pos'][1]}; the page keeps heights")
        old = dict(device)
        device.update({k: new[k] for k in ("pos", "look", "room") if k in new})
        rewrite(lines, i, device)
        seen.add(device["entity"])
        moved = ((device["pos"][0] - old["pos"][0]) ** 2 + (device["pos"][2] - old["pos"][2]) ** 2) ** 0.5
        room = f", room {old['room']} -> {device['room']}" if old["room"] != device["room"] else ""
        report.append(f"{device['entity']}: moved {moved:.2f} m{room}")
    unknown = sorted(set(changes) - seen)
    if unknown:
        sys.exit("not in the private block, one device per line: " + ", ".join(unknown))
    return len(seen)


def apply_trees(lines, changes, path, report):
    rows = block(lines, GEOMETRY, path)
    start = next((i for i in rows if lines[i].strip() == '"trees": ['), None)
    if start is None:
        sys.exit(f'{path}: no line "trees": [ alone in the geometry block; apply needs the trees one per line')
    seen = set()
    for i in range(start + 1, rows.stop):
        text = lines[i].strip()
        if text in ("]", "],"):
            break
        try:
            tree = json.loads(text.rstrip(","))
        except ValueError:
            tree = None
        if not (isinstance(tree, dict) and isinstance(tree.get("id"), str)):
            sys.exit(f"{path}:{i + 1}: not a whole tree; the trees list keeps one tree per line")
        new = changes.get(tree["id"])
        if new is None:
            continue
        old = dict(tree)
        tree.update({k: new[k] for k in ("pos", "height", "crown")})
        rewrite(lines, i, tree)
        seen.add(tree["id"])
        moved = math.dist(old["pos"], tree["pos"])
        sizes = "".join(f", {k} {old[k]} -> {tree[k]}" for k in ("height", "crown") if old[k] != tree[k])
        report.append(f"tree {tree['id']}: moved {moved:.2f} m{sizes}")
    else:
        sys.exit(f"{path}: the trees list in the geometry block has no closing ] line")
    unknown = sorted(set(changes) - seen)
    if unknown:
        sys.exit("not in the geometry block's trees list: " + ", ".join(unknown))
    return len(seen)


def apply(model_path, changes_path):
    raw = sys.stdin.read() if changes_path == "-" else Path(changes_path).read_text(encoding="utf-8")
    changes = parse_changes(raw)
    path = Path(model_path)
    text = path.read_text(encoding="utf-8")
    # the old values feed the report, so they have to be valid too
    checked(house3d_model.parse_layers(text))
    lines, report = text.split("\n"), []
    devices = apply_devices(lines, changes["devices"], path, report) if "devices" in changes else 0
    trees = apply_trees(lines, changes["trees"], path, report) if "trees" in changes else 0
    text = "\n".join(lines)
    checked(house3d_model.parse_layers(text))
    path.write_text(text, encoding="utf-8")
    print("\n".join(report + [f"{devices} device(s) and {trees} tree(s) written to {path}"]))
    return 0


def main(argv):
    if len(argv) in (2, 3) and argv[0] == "serve":
        return serve(argv[1], *(int(p) for p in argv[2:]))
    if len(argv) == 3 and argv[0] == "apply":
        return apply(argv[1], argv[2])
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
