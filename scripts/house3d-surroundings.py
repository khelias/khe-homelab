#!/usr/bin/env python3
"""Neighbouring buildings and the street for the house 3D view, from Maa- ja Ruumiamet's ETAK.

Usage:  house3d-surroundings.py MODEL GPKG [--radius 30] [--write]

MODEL is khe-meta house/house-model.md, GPKG the whole-Estonia ETAK GeoPackage
(ETAK_EESTI_GPKG.zip from geoportaal.maaamet.ee, unpacked), read offline so the service
never learns the area. The window is the lot's bounding box in the model frame plus
--radius metres (default 30).

The script maps ETAK into the model frame with the geometry layer's georef, then checks the
mapping before it trusts it: the house's outer walls (the outbuilding's left out) must match
ETAK's house footprint within 1 m on every side, and the nearest street centre line must run
along the street front, in front of the fence. It stops on a failure.

Buildings: ETAK footprints of type 10, 20 and 50 within --radius of the lot outline, not on the
lot itself, as flat-topped boxes. The height is ETAK's korgus_m, or 6 m (type 10 and 50) or 3 m
(type 20) marked assumed. Roads: ETAK road areas (traffic area with its sidewalks, and
pedestrian areas) clipped to the window, or when there are none, the street and road centre
lines widened to their recorded width (3 m when it is missing).

The dry run prints the check residuals, counts and distances, never a coordinate. --write
puts the result into MODEL as the private surroundings layer, a fenced block after the private
block, one building or road per line, and validates the file before writing it. The script
itself holds no coordinates; the location lives only in MODEL.

Licence: Maa- ja Ruumiamet open data licence (01.01.2025). Credit licensor, dataset and date,
which the layer's source string carries and the HA card shows.
"""
import argparse, json, math, sqlite3, struct, sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import house3d_model  # noqa: E402

BUILDINGS, ROAD_AREAS, ROAD_LINES = "E_401_hoone_ka", "E_501_tee_a", "E_501_tee_j"
BUILDING_TYPES = {10: 6.0, 20: 3.0, 50: 6.0}  # ETAK building type -> assumed height when korgus_m is missing
ROAD_AREA_TYPES = (10, 60)  # traffic area including the sidewalks beside it, pedestrian area
STREET_TYPES = (50, 60)  # centre lines of streets and roads
DEFAULT_ROAD_WIDTH = 3.0
HOUSE_TOLERANCE = 1.0
STREET_ANGLE = 15.0
FENCE = "```json house3d:surroundings"


# ---------- GeoPackage geometry ----------

def _wkb(buf, at):
    """Parse one WKB geometry at offset at; return ([(kind, rings_or_points)], new offset).
    kind is 'polygon' (a list of rings) or 'line' (a list of points); Z and M are dropped."""
    order = "<" if buf[at] == 1 else ">"
    (code,) = struct.unpack_from(order + "I", buf, at + 1)
    at += 5
    dims = 2
    if code & 0xE0000000:  # EWKB flags
        dims += bool(code & 0x80000000) + bool(code & 0x40000000)
        if code & 0x20000000:
            at += 4
        code &= 0x0FFFFFFF
    else:
        dims += {0: 0, 1: 1, 2: 1, 3: 2}[code // 1000]
        code %= 1000

    def points(at):
        (n,) = struct.unpack_from(order + "I", buf, at)
        at += 4
        pts = [struct.unpack_from(order + "2d", buf, at + i * 8 * dims) for i in range(n)]
        return pts, at + n * 8 * dims

    if code == 1:
        return [], at + 8 * dims
    if code == 2:
        pts, at = points(at)
        return [("line", pts)], at
    if code == 3:
        (n,) = struct.unpack_from(order + "I", buf, at)
        at += 4
        rings = []
        for _ in range(n):
            ring, at = points(at)
            rings.append(ring)
        return [("polygon", rings)], at
    if code in (4, 5, 6, 7):
        (n,) = struct.unpack_from(order + "I", buf, at)
        at += 4
        out = []
        for _ in range(n):
            parts, at = _wkb(buf, at)
            out += parts
        return out, at
    raise ValueError(f"WKB geometry type {code} is not handled")


def parse_gpkg(blob):
    """A GeoPackage geometry blob -> [(kind, rings_or_points)]."""
    if blob is None or blob[:2] != b"GP":
        raise ValueError("not a GeoPackage geometry blob")
    flags = blob[3]
    if flags & 0x10:
        return []
    envelope = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}[(flags >> 1) & 7]
    return _wkb(blob, 8 + envelope)[0]


# ---------- plane geometry ----------

def area(ring):
    return abs(signed_area(ring))


def signed_area(ring):
    return sum(x0 * z1 - x1 * z0 for (x0, z0), (x1, z1) in zip(ring, ring[1:] + ring[:1])) / 2


def open_ring(ring):
    ring = [tuple(p) for p in ring]
    return ring[:-1] if len(ring) > 1 and ring[0] == ring[-1] else ring


def centroid(ring):
    a = signed_area(ring)
    if abs(a) < 1e-9:
        return sum(p[0] for p in ring) / len(ring), sum(p[1] for p in ring) / len(ring)
    cx = cz = 0.0
    for (x0, z0), (x1, z1) in zip(ring, ring[1:] + ring[:1]):
        c = x0 * z1 - x1 * z0
        cx += (x0 + x1) * c
        cz += (z0 + z1) * c
    return cx / (6 * a), cz / (6 * a)


def inside(p, ring):
    x, z = p
    hit = False
    for (x0, z0), (x1, z1) in zip(ring, ring[1:] + ring[:1]):
        if (z0 > z) != (z1 > z) and x < x0 + (z - z0) * (x1 - x0) / (z1 - z0):
            hit = not hit
    return hit


def seg_point(p, a, b):
    """The point of segment a-b nearest p."""
    dx, dz = b[0] - a[0], b[1] - a[1]
    L2 = dx * dx + dz * dz
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dz) / L2))
    return a[0] + t * dx, a[1] + t * dz


def seg_dist(a, b, c, d):
    if house3d_model._segments_cross(a, b, c, d):
        return 0.0
    return min(math.dist(a, seg_point(a, c, d)), math.dist(b, seg_point(b, c, d)),
               math.dist(c, seg_point(c, a, b)), math.dist(d, seg_point(d, a, b)))


def edges(ring):
    return list(zip(ring, ring[1:] + ring[:1]))


def ring_dist(r1, r2):
    """Distance between two closed outlines; 0 when one lies inside the other or they cross."""
    if inside(r1[0], r2) or inside(r2[0], r1):
        return 0.0
    return min(seg_dist(a, b, c, d) for a, b in edges(r1) for c, d in edges(r2))


def _box_cut(a, b, box):
    """Liang-Barsky: the part (t0, t1) of segment a-b inside box, or None."""
    t0, t1 = 0.0, 1.0
    dx, dz = b[0] - a[0], b[1] - a[1]
    for p, q in ((-dx, a[0] - box[0]), (dx, box[2] - a[0]), (-dz, a[1] - box[1]), (dz, box[3] - a[1])):
        if p == 0:
            if q < 0:
                return None
            continue
        t = q / p
        if p < 0:
            t0 = max(t0, t)
        else:
            t1 = min(t1, t)
        if t0 > t1:
            return None
    return t0, t1


def clip_polygon(rings, box):
    """A polygon (outer ring, then holes) clipped to the rectangle box [x0, z0, x1, z1], as a list
    of (outer, holes). Each ring is cut into the chains that run inside the box; the chains are
    joined along the box edge, the way that keeps the polygon on the left, so holes and concave
    outlines that leave and re-enter the box come out whole rather than bridged."""
    x0, z0, x1, z1 = box
    W, H = x1 - x0, z1 - z0
    P = 2 * (W + H)
    corners = [(W, (x1, z0)), (W + H, (x1, z1)), (2 * W + H, (x0, z1)), (P, (x0, z0))]

    def along(p):  # position on the box edge, counter-clockwise from (x0, z0)
        x, z = p
        dists = [abs(z - z0), abs(x - x1), abs(z - z1), abs(x - x0)]
        side = dists.index(min(dists))
        return [x - x0, W + z - z0, W + H + x1 - x, 2 * W + H + z1 - z][side] % P

    def inbox(p):
        return x0 < p[0] < x1 and z0 < p[1] < z1

    # the region lies left of every ring: outer counter-clockwise, holes clockwise
    rings = [r if (signed_area(r) > 0) == (i == 0) else r[::-1] for i, r in enumerate(rings)]
    chains, whole = [], []
    for ring in rings:
        if all(inbox(p) for p in ring):
            whole.append(ring)
            continue
        k = next((i for i, p in enumerate(ring) if not inbox(p)))
        ring = ring[k:] + ring[:k]
        cur = None
        for i, a in enumerate(ring):
            b = ring[(i + 1) % len(ring)]
            cut = _box_cut(a, b, box)
            if cut is None or cut[1] - cut[0] <= 1e-12:
                continue
            t0, t1 = cut
            pa = (a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0)
            pb = (a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1)
            if t0 > 0 or cur is None:
                cur = [pa]
            if t1 < 1:
                cur.append(pb)
                chains.append(cur)
                cur = None
            else:
                cur.append(b)
    pieces = []
    if chains:
        entry = [along(c[0]) for c in chains]
        done = set()
        for first in range(len(chains)):
            if first in done:
                continue
            out, i = [], first
            while True:
                done.add(i)
                out += chains[i]
                ex = along(chains[i][-1])
                nxt = min(range(len(chains)), key=lambda j: (entry[j] - ex) % P)
                gap = (entry[nxt] - ex) % P
                for at, corner in sorted(corners, key=lambda c: (c[0] - ex) % P):
                    if 0 < (at - ex) % P < gap:
                        out.append(corner)
                if nxt == first:
                    break
                if nxt in done:
                    raise ValueError("clip: chains do not close; the polygon is not simple")
                i = nxt
            pieces.append(out)
    elif inside(((x0 + x1) / 2, (z0 + z1) / 2), rings[0]) and not any(inside(((x0 + x1) / 2, (z0 + z1) / 2), h) for h in rings[1:]):
        pieces.append([(x0, z0), (x1, z0), (x1, z1), (x0, z1)])
    holes = []
    for r in whole:
        (pieces if signed_area(r) > 0 else holes).append(r)
    out = [(p, []) for p in pieces]
    for h in holes:
        home = next((o for o in out if inside(h[0], o[0])), None)
        if home is not None:
            home[1].append(h)
    return out


def tidy(ring):
    """Round to 2 decimals, drop repeated and collinear points; None when under 3 points or 1 m2."""
    pts = []
    for x, z in ring:
        p = (round(x, 2) + 0.0, round(z, 2) + 0.0)
        if not pts or p != pts[-1]:
            pts.append(p)
    while len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    changed = True
    while changed and len(pts) >= 3:
        changed = False
        for i in range(len(pts)):
            a, b, c = pts[i - 1], pts[i], pts[(i + 1) % len(pts)]
            if abs(house3d_model._cross(a, b, c)) <= 1e-3 * max(1e-9, math.dist(a, c)):
                del pts[i]
                changed = True
                break
    if len(pts) < 3 or area(pts) < 1:
        return None
    return [[x, z] for x, z in pts]


def buffer_line(pts, half):
    """A polyline widened by half on each side, as one outline per leg with square ends, overlapping
    at the joints."""
    out = []
    for a, b in zip(pts, pts[1:]):
        L = math.dist(a, b)
        if L == 0:
            continue
        ux, uz = (b[0] - a[0]) / L, (b[1] - a[1]) / L
        nx, nz = -uz * half, ux * half
        out.append([(a[0] + nx, a[1] + nz), (b[0] + nx, b[1] + nz), (b[0] - nx, b[1] - nz), (a[0] - nx, a[1] - nz)])
    return out


# ---------- frames ----------

class Frame:
    """L-EST97 <-> model frame. With theta the x axis bearing, dE = E - E0 and dN = N - N0:
    x = dE sin(theta) + dN cos(theta), z = dE cos(theta) - dN sin(theta); the matrix is its own
    inverse, so the same formula maps back."""

    def __init__(self, georef):
        if georef.get("scale", 1) != 1:
            raise SystemExit("georef: only scale 1 is handled")
        self.e0, self.n0 = georef["origin_E"], georef["origin_N"]
        t = math.radians(georef["x_axis_bearing_deg"])
        self.s, self.c = math.sin(t), math.cos(t)

    def to_model(self, p):
        de, dn = p[0] - self.e0, p[1] - self.n0
        return de * self.s + dn * self.c, de * self.c - dn * self.s

    def to_lest(self, p):
        x, z = p
        return self.e0 + x * self.s + z * self.c, self.n0 + x * self.c - z * self.s


def bbox(pts):
    xs, zs = [p[0] for p in pts], [p[1] for p in pts]
    return [min(xs), min(zs), max(xs), max(zs)]


def query(db, table, frame, window):
    """Rows (id, parts in the model frame, tyyp, extra) of table whose bbox meets the window."""
    corners = [frame.to_lest(p) for p in ((window[0], window[1]), (window[2], window[1]), (window[2], window[3]), (window[0], window[3]))]
    e0, n0, e1, n1 = bbox(corners)
    extra = {BUILDINGS: "t.korgus_m", ROAD_AREAS: "NULL", ROAD_LINES: "t.laius"}[table]
    rows = db.execute(f"SELECT t.id, t.geom, t.tyyp, {extra} FROM {table} t JOIN rtree_{table}_geom r ON r.id = t.id "
                      "WHERE r.maxx >= ? AND r.minx <= ? AND r.maxy >= ? AND r.miny <= ?", (e0, e1, n0, n1)).fetchall()
    out = []
    for fid, blob, tyyp, value in rows:
        parts = []
        for kind, geo in parse_gpkg(blob):
            if kind == "polygon":
                parts.append((kind, [open_ring([frame.to_model(p) for p in ring]) for ring in geo]))
            else:
                parts.append((kind, [frame.to_model(p) for p in geo]))
        out.append((fid, parts, tyyp, value))
    return out


# ---------- the check, the selection and the layer ----------

def house_box(geo):
    """Bounding box of the house's outer wall faces. The outbuilding is left out: its walls run up
    to a roof whose outline stands apart from the house's roofs (the house being the group of
    touching roofs with the largest area)."""
    roofs = geo["roofs"]
    boxes = {k: bbox(r["outline"]) for k, r in roofs.items()}
    touch = lambda a, b: a[0] <= b[2] + 0.5 and b[0] <= a[2] + 0.5 and a[1] <= b[3] + 0.5 and b[1] <= a[3] + 0.5
    groups = []
    for k in roofs:
        near = [g for g in groups if any(touch(boxes[k], boxes[j]) for j in g)]
        groups = [g for g in groups if g not in near] + [set().union({k}, *near)]
    house = max(groups, key=lambda g: sum(area(open_ring(roofs[k]["outline"])) for k in g))
    pts, skipped = [], 0
    for w in geo["walls"]:
        if isinstance(w["top"], str) and w["top"] not in house:
            skipped += 1
            continue
        (ax, az), (bx, bz) = w["a"], w["b"]
        L = math.dist(w["a"], w["b"])
        nx, nz = -(bz - az) / L * w["t"] / 2, (bx - ax) / L * w["t"] / 2
        pts += [(ax + nx, az + nz), (ax - nx, az - nz), (bx + nx, bz + nz), (bx - nx, bz - nz)]
    others = sorted(set(roofs) - house)
    return bbox(pts), sorted(house), others, skipped


def lot_front(lot, x):
    """The z of the lot outline's street-side edge at x (its smallest z there), or None."""
    zs = [a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0]) for a, b in edges(lot)
          if a[0] != b[0] and min(a[0], b[0]) <= x <= max(a[0], b[0])]
    return min(zs) if zs else None


def street_ahead(lines, x, z_front):
    """The first street centre line crossing in front of z_front at x: (distance, the crossed
    leg's angle to the x axis in degrees), or None."""
    best = None
    for pts in lines:
        for a, b in zip(pts, pts[1:]):
            if a[0] == b[0] or not min(a[0], b[0]) <= x <= max(a[0], b[0]):
                continue
            z = a[1] + (x - a[0]) * (b[1] - a[1]) / (b[0] - a[0])
            if z < z_front and (best is None or z_front - z < best[0]):
                ang = abs(math.degrees(math.atan2(b[1] - a[1], b[0] - a[0]))) % 180
                best = (z_front - z, min(ang, 180 - ang))
    return best


def street_check(lines, lot, reach):
    """Along the lot's street front, every 0.5 m: the first street centre line within reach in
    front of the fence. Return (share of the front with a street, median angle of the crossed legs).
    Swapped or mirrored axes put the street beside or behind the lot, or across the front. The
    median rather than the nearest leg, because a junction in front of the drive bends the line."""
    lb = bbox(lot)
    n = max(1, int((lb[2] - lb[0]) / 0.5))
    found, angles = 0, []
    for i in range(n + 1):
        x = lb[0] + (lb[2] - lb[0]) * i / n
        front = lot_front(lot, x)
        hit = street_ahead(lines, x, front) if front is not None else None
        if hit and hit[0] <= reach:
            found += 1
            angles.append(hit[1])
    angles.sort()
    return found / (n + 1), (angles[len(angles) // 2] if angles else None)


def surroundings(model, db, radius):
    """Return (layer, report lines); SystemExit when the self-check fails."""
    frame = Frame(model["georef"])
    lot = [tuple(p) for p in model["site"]["lot"]]
    lb = bbox(lot)
    window = [lb[0] - radius, lb[1] - radius, lb[2] + radius, lb[3] + radius]
    report = []
    say = report.append

    bld = query(db, BUILDINGS, frame, window)
    areas = query(db, ROAD_AREAS, frame, window)
    lines = query(db, ROAD_LINES, frame, window)
    for table, rows in ((BUILDINGS, bld), (ROAD_AREAS, areas), (ROAD_LINES, lines)):
        say(f"{table}: {len(rows)} in the window, tyyp " + ", ".join(f"{t}: {n}" for t, n in sorted(Counter(r[2] for r in rows).items())))

    # self-check: the house
    hb, house_roofs, other_roofs, skipped = house_box(model)
    say(f"house: roofs {', '.join(house_roofs)}; {skipped} walls under {', '.join(other_roofs) or 'no other roof'} left out")
    found = [ring for _, parts, _, _ in bld for kind, rings in parts if kind == "polygon"
             for ring in rings[:1] if (lambda c: hb[0] - 1 <= c[0] <= hb[2] + 1 and hb[1] - 1 <= c[1] <= hb[3] + 1)(centroid(ring))]
    failed = []
    if not found:
        failed.append("no ETAK footprint has its centroid on the house")
    else:
        eb = bbox([p for r in found for p in r])
        res = [eb[i] - hb[i] for i in range(4)]
        say(f"self-check house: {len(found)} footprint(s); residuals west {res[0]:+.2f}, north {res[1]:+.2f}, "
            f"east {res[2]:+.2f}, south {res[3]:+.2f} m (x0, z0, x1, z1; {HOUSE_TOLERANCE} m allowed)")
        if any(abs(r) > HOUSE_TOLERANCE for r in res):
            failed.append(f"the house footprint is off by more than {HOUSE_TOLERANCE} m")

    # self-check: a street runs along the front, in front of the fence
    streets = [pts for _, parts, t, _ in lines if t in STREET_TYPES for kind, pts in parts if kind == "line"]
    share, ang = street_check(streets, lot, radius)
    say(f"self-check street: a centre line within {radius:g} m in front of the fence along {share:.0%} of the lot's front, "
        + (f"median leg {ang:.1f} degrees off the x axis ({STREET_ANGLE} allowed)" if ang is not None else "no leg"))
    if share < 0.5:
        failed.append("no street along most of the lot's front (axes swapped or mirrored?)")
    elif ang > STREET_ANGLE:
        failed.append("the street in front does not run along the x axis (axes swapped or rotated?)")
    if failed:
        print("\n".join(report))
        raise SystemExit("self-check failed: " + "; ".join(failed))

    # buildings
    buildings = []
    for _, parts, t, h in bld:
        if t not in BUILDING_TYPES:
            continue
        for kind, rings in parts:
            if kind != "polygon" or inside(centroid(rings[0]), lot) or ring_dist(rings[0], lot) > radius:
                continue
            outline = tidy(rings[0])
            if outline is None:
                continue
            b = {"outline": outline, "height": float(h) if h and h > 0 else BUILDING_TYPES[t]}
            if not (h and h > 0):
                b["assumed"] = True
            buildings.append(b)

    # roads: the road areas, else the centre lines widened
    roads = []
    for fid, parts, t, _ in areas:
        if t not in ROAD_AREA_TYPES:
            continue
        for kind, rings in parts:
            if kind == "polygon":
                try:
                    roads += clip_polygon(rings, window)
                except ValueError as e:
                    raise SystemExit(f"{ROAD_AREAS} feature {fid}: {e}")
    source_kind = "road areas"
    if not roads:
        source_kind = "centre lines"
        for _, parts, t, w in lines:
            if t in STREET_TYPES:
                for kind, pts in parts:
                    for leg in buffer_line(pts, (w if w and w > 0 else DEFAULT_ROAD_WIDTH) / 2):
                        roads += clip_polygon([leg], window)
    road_out = []
    for outer, holes in roads:
        o = tidy(outer)
        if o is None:
            continue
        r = {"outline": o}
        hs = [h for h in map(tidy, holes) if h is not None]
        if hs:
            r["holes"] = hs
        road_out.append(r)

    when = max(row[0] for row in db.execute(
        "SELECT substr(last_change, 1, 10) FROM gpkg_contents WHERE lower(table_name) IN (?, ?, ?)",
        tuple(t.lower() for t in (BUILDINGS, ROAD_AREAS, ROAD_LINES))))
    layer = {"surroundings": {"source": f"ETAK, Maa- ja Ruumiamet, {when}", "buildings": buildings, "roads": road_out}}

    hs = [b["height"] for b in buildings]
    say(f"buildings: {len(buildings)}" + (f", height {min(hs):g}-{max(hs):g} m, {sum(1 for b in buildings if b.get('assumed'))} assumed" if hs else ""))
    say(f"roads: {len(road_out)} ring(s) from the {source_kind}, {sum(len(r.get('holes', [])) for r in road_out)} hole(s)")
    path = (model.get("car") or {}).get("path")
    x = path[0][0] if path else (lb[0] + lb[2]) / 2
    front = lot_front(lot, x)
    ahead = street_ahead(streets, x, front) if front is not None else None
    say(f"street centre line at x {x:g}: " + (f"{ahead[0]:.1f} m in front of the fence" if ahead else "does not cross that x"))
    say(f"source: {layer['surroundings']['source']}")
    return layer, report


def block_text(layer):
    s = layer["surroundings"]
    row = lambda v: json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    lines = [FENCE, '{"surroundings": {', f'  "source": {row(s["source"])},', '  "buildings": [']
    lines += [f"    {row(b)}" + ("," if i < len(s["buildings"]) - 1 else "") for i, b in enumerate(s["buildings"])]
    lines += ["  ],", '  "roads": [']
    lines += [f"    {row(r)}" + ("," if i < len(s["roads"]) - 1 else "") for i, r in enumerate(s["roads"])]
    lines += ["  ]", "}}", "```"]
    return "\n".join(lines)


def write(path, layer):
    text = Path(path).read_text(encoding="utf-8")
    lines = text.split("\n")
    new = block_text(layer).split("\n")

    def block_at(fence):
        start = next((i for i, l in enumerate(lines) if l.rstrip() == fence), None)
        if start is None:
            return None
        end = next((i for i in range(start + 1, len(lines)) if lines[i].startswith("```")), None)
        if end is None:
            raise SystemExit(f"{path}: the {fence} block is not closed")
        return start, end

    old = block_at(FENCE)
    if old:
        lines[old[0]:old[1] + 1] = new
    else:
        priv = block_at("```json house3d:private")
        if priv is None:
            raise SystemExit(f"{path}: no private block to put the surroundings after")
        lines[priv[1] + 1:priv[1] + 1] = [""] + new
    out = "\n".join(lines)
    problems = house3d_model.validate(house3d_model.parse_layers(out))
    if problems:
        raise SystemExit("the new model does not validate, nothing written:\n" + "\n".join(problems))
    Path(path).write_text(out, encoding="utf-8")
    return "replaced" if old else "added"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("model")
    ap.add_argument("gpkg")
    ap.add_argument("--radius", type=float, default=30.0)
    ap.add_argument("--write", action="store_true", help="put the surroundings layer into MODEL")
    a = ap.parse_args(argv)
    layers = house3d_model.read_layers(a.model)
    problems = house3d_model.validate(layers)
    if problems:
        raise SystemExit("model problems:\n" + "\n".join(problems))
    model = house3d_model.merge(layers, house3d_model.LAYERS)
    if "georef" not in model:
        raise SystemExit("the geometry layer has no georef")
    db = sqlite3.connect(f"file:{Path(a.gpkg).resolve()}?mode=ro", uri=True)
    layer, report = surroundings(model, db, a.radius)
    print("\n".join(report))
    if a.write:
        print(f"surroundings block {write(a.model, layer)} in {a.model}")
    else:
        print("dry run; --write puts the layer into the model")
    return 0


if __name__ == "__main__":
    sys.exit(main())
