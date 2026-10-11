#!/usr/bin/env python3
"""Build the standalone house 3D viewer, and scan files for private house data.

Usage:  house3d-build.py MODEL OUTDIR           build, then scan OUTDIR
        house3d-build.py --scan MODEL PATH...   scan files or trees, exit 1 on any hit

The build writes OUTDIR/index.html (viewer.html), house3d.js, vendor/ and model.json from
the geometry, rooms and showcase layers of MODEL (khe-meta house/house-model.md). The
private layer never goes in. Publishing the folder is a separate decision.

The scan reads the private layer of MODEL and fails on every occurrence of an entity id,
a device name or a family room name (house3d_model.private_strings), of a `devices` key,
and of a device's coordinates written out as text: its [x, y, z] position, its ground
[x, z] pair and a camera's look direction (integer-only directions such as [0, 1] carry
no location and are skipped). Run it over services/home/homeassistant/house3d/ before
every khe-homelab commit that touches it.
"""
import json, os, re, shutil, sys
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import house3d_model  # noqa: E402

SRC = Path(__file__).resolve().parent.parent / "services/home/homeassistant/house3d"
DEVICES_KEY = re.compile(r"""["']?\bdevices["']?\s*:""")


def _num(v):
    """Regex for a number as JS or JSON might write it: 5 matches 5 and 5.0, 1.3 matches 1.30."""
    # the shortest exact decimal, without exponent or rounding; -0.0 is written 0
    whole, _, frac = format(Decimal(repr(abs(float(v)) if v == 0 else float(v))), "f").partition(".")
    frac = frac.rstrip("0")
    body = re.escape(whole) + (r"\." + frac + "0*" if frac else r"(?:\.0+)?")
    return r"(?<![\d.])" + body + r"(?![\d])"


def _seq(values):
    return re.compile(r"\s*,\s*".join(_num(v) for v in values))


def patterns(model):
    """(label, regex) pairs for everything a public file must not contain."""
    out = [(f"private string {s!r}", re.compile(r"(?<!\w)" + re.escape(s) + r"(?!\w)")) for s in house3d_model.private_strings(model)]
    out.append(("a devices key", DEVICES_KEY))
    for d in model.get("devices", []):
        x, y, z = d["pos"]
        out.append((f"position of {d['entity']}", _seq([x, y, z])))
        out.append((f"ground position of {d['entity']}", _seq([x, z])))
        look = d.get("look")
        if look and not all(float(v).is_integer() for v in look):
            out.append((f"view direction of {d['entity']}", _seq(look)))
    return out


def scan(model, paths):
    pats = patterns(model)
    hits = []
    files = []
    for p in map(Path, paths):
        if not p.exists():
            # a mistyped path must not pass as a clean scan
            raise SystemExit(f"scan: {p} does not exist")
        files.extend(sorted(f for f in p.rglob("*") if f.is_file()) if p.is_dir() else [p])
    for f in files:
        try:
            text = f.read_text(encoding="utf-8")
        except (UnicodeDecodeError, OSError):
            continue
        for label, rx in pats:
            for m in rx.finditer(text):
                line = text.count("\n", 0, m.start()) + 1
                hits.append(f"{f}:{line}: {label}")
    return hits, len(files)


def full_model(path):
    layers = house3d_model.read_layers(path)
    problems = house3d_model.validate(layers)
    if problems:
        sys.exit("model problems:\n" + "\n".join(problems))
    return layers


def run_scan(model, paths):
    hits, n = scan(model, paths)
    for h in hits:
        print(h)
    print(f"scan: {len(hits)} hit(s) in {n} file(s)")
    return 1 if hits else 0


def build(model_path, outdir):
    layers = full_model(model_path)
    public = house3d_model.merge(layers, house3d_model.PUBLIC)
    public.pop("georef", None)  # the viewer does not use it, and a public page should not pin the house
    out = Path(outdir)
    out.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(SRC / "viewer.html", out / "index.html")
    shutil.copyfile(SRC / "house3d.js", out / "house3d.js")
    shutil.copytree(SRC / "vendor", out / "vendor", dirs_exist_ok=True)
    (out / "model.json").write_text(json.dumps(public, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"built {out}")
    return run_scan(house3d_model.merge(layers, house3d_model.LAYERS), [out])


def main(argv):
    if len(argv) >= 3 and argv[0] == "--scan":
        layers = full_model(argv[1])
        return run_scan(house3d_model.merge(layers, house3d_model.LAYERS), argv[2:])
    if len(argv) == 2 and not argv[0].startswith("-"):
        return build(*argv)
    print(__doc__.split("\n\n")[1], file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
