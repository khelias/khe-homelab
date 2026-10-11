#!/usr/bin/env python3
"""Place the house 3D model's devices on a 2D plan, and write the result back.

Usage:  house3d-place.py serve MODEL [PORT]         serve the placement page on 127.0.0.1
        house3d-place.py apply MODEL CHANGES.json   write the page's changes into MODEL

serve answers services/home/homeassistant/house3d/place.html with the geometry, rooms and
private layers of MODEL (khe-meta house/house-model.md), family room names applied. The
model is served from memory, so the private layer never lands next to the page. Default
port 8731.

apply takes the JSON the page's "Kopeeri muudatused" button copies, {entity: {pos, look?,
room}}, from a file or from stdin with '-' (pbpaste | ... apply MODEL -), and rewrites
those devices' lines in the private block, one device per line as before. An unknown
entity, a changed height or a model that no longer validates stops it before writing.
"""
import functools, http.server, json, sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import house3d_model  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "services/home/homeassistant/house3d"
FENCE = "```json house3d:private"


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


def apply(model_path, changes_path):
    raw = sys.stdin.read() if changes_path == "-" else Path(changes_path).read_text(encoding="utf-8")
    changes = json.loads(raw)
    if not (isinstance(changes, dict) and all(isinstance(c, dict) and isinstance(c.get("pos"), list) and len(c["pos"]) == 3 for c in changes.values())):
        sys.exit("changes must be {entity: {pos: [x, y, z], look?, room?}}, as the page copies them")
    path = Path(model_path)
    lines = path.read_text(encoding="utf-8").split("\n")
    start = next((i for i, line in enumerate(lines) if line.rstrip() == FENCE), None)
    if start is None:
        sys.exit(f"{path}: no {FENCE} block")
    seen, report = set(), []
    for i in range(start + 1, len(lines)):
        if lines[i].startswith("```"):
            break
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
        indent = lines[i][: len(lines[i]) - len(text)]
        lines[i] = indent + json.dumps(device, ensure_ascii=False, separators=(",", ":")) + ("," if text.endswith(",") else "")
        seen.add(device["entity"])
        moved = ((device["pos"][0] - old["pos"][0]) ** 2 + (device["pos"][2] - old["pos"][2]) ** 2) ** 0.5
        room = f", room {old['room']} -> {device['room']}" if old["room"] != device["room"] else ""
        report.append(f"{device['entity']}: moved {moved:.2f} m{room}")
    unknown = sorted(set(changes) - seen)
    if unknown:
        sys.exit("not in the private block, one device per line: " + ", ".join(unknown))
    text = "\n".join(lines)
    checked(house3d_model.parse_layers(text))
    path.write_text(text, encoding="utf-8")
    print("\n".join(report + [f"{len(seen)} device(s) written to {path}"]))
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
