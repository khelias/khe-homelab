// The buildings: walls, room floors, furniture, roofs and roof steps, and the garage roof.
// Walls that run up to a roof are cut at the ceiling, and the part above goes in lift with the
// roofs, which rises and fades with the roof mode. The floors are the room tap targets and warm
// with a room's markers in state 'on'. The real style draws them as lit surfaces: exterior walls
// boarded outside and plain inside, interior walls plain, framed openings, floors in the room's
// finish that tint from their own colour, and the lift on materials of its own, so its fade never
// reaches the lower walls. Its exterior walls also carry anthracite opening trims with lined
// reveals and sill flashings, and corner boards on every outer and inner corner; the roofs have an
// anthracite edge, the carport roof an anthracite fascia and soffit.
const FRAME = 0.06, FRAME_D = 0.1; // real style: an opening's frame width and depth
const BASE_H = 0.12; // real style: the dark strip along an exterior wall's foot
// real style, read off photos: an opening's trim and a corner board, both standing PROUD off the
// face, and a sill's metal flashing
const TRIM = 0.1, CORNER = 0.12, PROUD = 0.025, REVEAL = 0.015;
const FLASH_T = 0.03, FLASH_OUT = 0.06, FLASH_PAST = 0.03;

/**
 * cornerBoards(faces, W, D) -> [{ wall, p, dir, from, to, filler? }]
 * The real style's corner boards on an outline of boarded walls. faces holds one entry per
 * wall, { i, a: [x, z], u: [ux, uz], n: [nx, nz], L, t }, n the plan outward normal; the outer
 * face is the centreline moved by n * t / 2. Each board lies on the outer face of wall `wall`,
 * from the outer faces' crossing p along the plan direction dir, between from and to. A convex
 * corner gives each wall a board that runs D past p, over the other's board edge; a concave one
 * a board on each wall from p. A convex corner needs p at an end of the other wall: where that
 * wall runs on past p, the first one only butts into it. A filler covers what is open between a wall's own face and a
 * convex p: the other wall's end cap, or a notch where both stop at the centreline crossing.
 */
export function cornerBoards(faces, W, D) {
  const dot = (p, q) => p[0] * q[0] + p[1] * q[1];
  const outer = f => [f.a[0] + (f.n[0] * f.t) / 2, f.a[1] + (f.n[1] * f.t) / 2];
  const out = [], seen = new Set();
  const add = c => {
    const key = [c.wall, ...c.p, ...c.dir].map(v => Math.round(v * 1000)).join(' ') + (c.filler ? ' f' : '');
    if (!seen.has(key)) seen.add(key), out.push(c);
  };
  faces.forEach(A => {
    const oA = outer(A);
    [[0, A.u], [A.L, [-A.u[0], -A.u[1]]]].forEach(([s, d]) => {
      const e = [oA[0] + A.u[0] * s, oA[1] + A.u[1] * s];
      faces.forEach(B => {
        if (B === A || Math.abs(dot(A.u, B.u)) >= 0.1) return;
        const oB = outer(B);
        // a wall that stops at the other's inner face ends up to tB short of the crossing
        const k = dot([oB[0] - e[0], oB[1] - e[1]], B.n) / dot(A.u, B.n);
        if (Math.abs(k) > Math.max(A.t, B.t) + 0.05) return;
        const p = [e[0] + A.u[0] * k, e[1] + A.u[1] * k];
        const q = dot([p[0] - oB[0], p[1] - oB[1]], B.u);
        if (q < -A.t - 0.05 || q > B.L + A.t + 0.05) return;
        if (dot(d, B.n) < 0) {
          if (q > A.t + 0.05 && q < B.L - A.t - 0.05) return;
          add({ wall: A.i, p, dir: d, from: -D, to: W });
          const g = dot([e[0] - p[0], e[1] - p[1]], d);
          if (g > 0.005) add({ wall: A.i, p, dir: d, from: 0, to: g, filler: true });
        } else {
          add({ wall: A.i, p, dir: d, from: 0, to: W });
          add({ wall: B.i, p, dir: A.n, from: 0, to: W });
        }
      });
    });
  });
  return out;
}

export default function build({ THREE, kit, C, model, roof, ceiling, state, style }) {
  const { basic, mats, edges, box, near } = kit;
  const real = style === 'real';
  const site = model.site || {};
  const rooms = model.rooms || [];
  const roomIds = new Set(rooms.map(r => r.id));
  const group = new THREE.Group(), lift = new THREE.Group();
  let mH, mR, wallMats;
  if (real) {
    // walls and roofs are DoubleSide: a roof's remapped extrusion faces inwards
    const two = { side: THREE.DoubleSide }, fades = { ...two, transparent: true };
    const [front, back] = kit.boards();
    const clad = o => ({ front: kit.surface('cladding', { ...o, map: front }), back: kit.surface('cladding', { ...o, map: back }), edge: kit.surface('cladding', o) });
    const inner = kit.surface('interior', two), glass = kit.surface('glass');
    const frame = kit.surface('frame'), panel = kit.surface('frame', two);
    const boarded = { ...clad(two), inner };
    mH = { furn: kit.surface('interior') };
    // the lift's inner faces are never seen, so they keep the cladding's colour without boards
    const lifted = clad(fades);
    mR = { boarded: { ...lifted, inner: lifted.edge }, roof: kit.surface('roof', fades), panel: kit.surface('frame', fades), frame: kit.surface('frame', fades) };
    // a panel (the carport's walls and posts) is anthracite; else exterior is thick or running up
    // to a roof, and only it gets the boards and the base strip
    wallMats = w => {
      if (w.finish === 'panel') return { wall: panel, glass, frame, base: false };
      const outside = w.t >= 0.3 || typeof w.top === 'string';
      return outside ? { boarded, glass, frame, base: true } : { wall: inner, glass, frame, base: false };
    };
  } else {
    mH = mats();
    mR = mats(C.roof);
    mR.wall.opacity = 0.28;
    mR.wall.color = C.roofFill;
    wallMats = () => mH;
  }

  // real style: the wall solid, glass in windows and glass doors, a leaf in doors, and a frame
  // round each opening; a boarded wall's openings also get a trim on the outer face, a lined
  // reveal and, under a window with a sill, a flashing
  function dressWall(g, geo, ops, m, w, L, top) {
    const side = outerSide(w, L);
    const mesh = new THREE.Mesh(geo, m.boarded ? faces(geo, m.boarded, side) : m.wall);
    mesh.castShadow = mesh.receiveShadow = true;
    g.add(mesh);
    const bar = (x0, x1, y0, y1, d = FRAME_D) => {
      const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, d), m.frame);
      b.position.set((x0 + x1) / 2, (y0 + y1) / 2, 0);
      b.castShadow = b.receiveShadow = true;
      g.add(b);
      return b;
    };
    // a box between local z0 and z1, tagged for the tests
    const piece = (part, x0, x1, y0, y1, z0, z1) => {
      if (x1 - x0 < 0.005 || y1 - y0 < 0.005) return;
      const b = bar(x0, x1, y0, y1, Math.abs(z1 - z0));
      b.position.z = (z0 + z1) / 2;
      b.userData.part = part;
    };
    const trims = !!(m.boarded && side);
    const face = side * (w.t / 2), proud = side * (w.t / 2 + PROUD);
    ops.forEach(o => {
      const x0 = o.c - o.w / 2, x1 = o.c + o.w / 2, y0 = o.sill || 0, y1 = y0 + o.h;
      if (o.kind === 'door') bar(x0 + FRAME, x1 - FRAME, 0, y1 - FRAME, 0.05);
      else {
        const p = new THREE.Mesh(new THREE.PlaneGeometry(o.w, o.h), m.glass);
        p.position.set(o.c, y0 + o.h / 2, 0);
        g.add(p);
        bar(x0 + FRAME, x1 - FRAME, y0, y0 + FRAME);
      }
      bar(x0, x0 + FRAME, y0, y1);
      bar(x1 - FRAME, x1, y0, y1);
      bar(x0 + FRAME, x1 - FRAME, y1 - FRAME, y1);
      if (o.kind === 'glassdoor') bar(o.c - FRAME / 2, o.c + FRAME / 2, y0 + FRAME, y1 - FRAME);
      if (!trims) return;
      const sill = o.kind === 'window' && o.sill > 0;
      // never through a cut or a roof
      const yt = Math.min(y1 + TRIM, top(x0 - TRIM), top(x1 + TRIM)), yb = sill ? Math.max(0, y0 - TRIM) : 0;
      piece('trim', x0 - TRIM, x0, yb, yt, face, proud);
      piece('trim', x1, x1 + TRIM, yb, yt, face, proud);
      piece('trim', x0 - TRIM, x1 + TRIM, y1, yt, face, proud);
      piece('reveal', x0, x0 + REVEAL, y0, y1, 0, face);
      piece('reveal', x1 - REVEAL, x1, y0, y1, 0, face);
      piece('reveal', x0, x1, y1 - REVEAL, y1, 0, face);
      if (!sill) return;
      piece('trim', x0 - TRIM, x1 + TRIM, y0 - TRIM, y0, face, proud);
      piece('sill', x0 - TRIM - FLASH_PAST, x1 + TRIM + FLASH_PAST, y0 - FLASH_T, y0, face, side * (w.t / 2 + FLASH_OUT + PROUD));
      piece('reveal', x0, x1, y0, y0 + REVEAL, 0, face);
    });
    if (!m.base || w.bot) return;
    // the base strip sits on the outer face, the side with no room just beyond it; when that
    // cannot be told, on both
    const d = side ? 0.02 : w.t + 0.02, zc = side * (w.t / 2 + 0.01);
    // it runs the wall's length and over its corner fillers, broken by every opening that
    // reaches the ground, and meets the opening's trims
    const pad = trims ? TRIM : 0, [lo, hi] = w.strip || [0, L];
    const gaps = ops.filter(o => (o.sill || 0) < BASE_H).map(o => [o.c - o.w / 2 - pad, o.c + o.w / 2 + pad]).sort((p, q) => p[0] - q[0]);
    let from = lo;
    [...gaps, [hi, hi]].forEach(([a, b]) => {
      if (a - from > 0.01) bar(from, a, 0, BASE_H, d).position.z = zc;
      from = Math.max(from, b);
    });
  }

  // an extruded wall's first group holds both faces, the -z one first, then the +z one; split it
  // so the outer face is boarded and the inner one plain (both boarded when side is 0)
  function faces(geo, b, side) {
    const [lids, sides] = geo.groups, half = lids.count / 2;
    geo.clearGroups();
    geo.addGroup(lids.start, half, 0);
    geo.addGroup(lids.start + half, half, 1);
    geo.addGroup(sides.start, sides.count, 2);
    return [side === 1 ? b.inner : b.back, side === -1 ? b.inner : b.front, b.edge];
  }

  // +1 or -1 for the wall group's local z that faces out, 0 when both or neither side has a room;
  // a paved room (the carport) is outdoors under a roof
  const cutOf = w => w.cut ?? (typeof w.top === 'string' ? ceiling : 0);
  const inRoom = (x, z) => rooms.some(r => r.floor !== 'paving' && r.rects.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1));
  // probed at the midpoint first, then at a quarter and three quarters, for a wall that is
  // exterior over part of its length only
  function outerSide(w, L) {
    const ux = (w.b[0] - w.a[0]) / L, uz = (w.b[1] - w.a[1]) / L, k = w.t / 2 + 0.3;
    for (const f of [0.5, 0.25, 0.75]) {
      const mx = w.a[0] + ux * L * f, mz = w.a[1] + uz * L * f;
      // the group's rotation turns local +z to (-uz, ux) on the plan
      const plus = inRoom(mx - uz * k, mz + ux * k), minus = inRoom(mx + uz * k, mz - ux * k);
      if (plus !== minus) return plus ? -1 : 1;
    }
    return 0;
  }

  function buildWall(parent, w, m) {
    const dx = w.b[0] - w.a[0], dz = w.b[1] - w.a[1];
    const L = Math.hypot(dx, dz), ux = dx / L, uz = dz / L;
    const top = u => w.top(w.a[0] + ux * u, w.a[1] + uz * u);
    const bot = u => (w.bot ? w.bot(w.a[0] + ux * u, w.a[1] + uz * u) : 0);
    const shape = new THREE.Shape();
    const ops = w.openings || [];
    const doors = ops.filter(o => o.kind !== 'window').sort((p, q) => p.c - q.c);
    const steps = Math.max(1, Math.ceil(L / 0.25));
    shape.moveTo(0, bot(0));
    if (w.bot) for (let i = 1; i < steps; i++) shape.lineTo((L * i) / steps, bot((L * i) / steps));
    doors.forEach(d => {
      shape.lineTo(d.c - d.w / 2, 0);
      shape.lineTo(d.c - d.w / 2, d.h);
      shape.lineTo(d.c + d.w / 2, d.h);
      shape.lineTo(d.c + d.w / 2, 0);
    });
    shape.lineTo(L, bot(L));
    for (let i = steps; i >= 0; i--) {
      const u = (L * i) / steps;
      shape.lineTo(u, top(u));
    }
    ops.filter(o => o.kind === 'window').forEach(o => {
      const h = new THREE.Path();
      h.moveTo(o.c - o.w / 2, o.sill);
      h.lineTo(o.c + o.w / 2, o.sill);
      h.lineTo(o.c + o.w / 2, o.sill + o.h);
      h.lineTo(o.c - o.w / 2, o.sill + o.h);
      h.lineTo(o.c - o.w / 2, o.sill);
      shape.holes.push(h);
    });
    const geo = new THREE.ExtrudeGeometry(shape, { depth: w.t, bevelEnabled: false });
    geo.translate(0, 0, -w.t / 2);
    const g = new THREE.Group();
    g.position.set(w.a[0], 0, w.a[1]);
    g.rotation.y = Math.atan2(-uz, ux);
    if (real) {
      dressWall(g, geo, ops, m, w, L, top);
      parent.add(g);
      return;
    }
    const mesh = new THREE.Mesh(geo, m.wall);
    mesh.renderOrder = 2;
    g.add(mesh, edges(geo, m.edge, 20));
    ops.filter(o => o.kind !== 'door').forEach(o => {
      const sill = o.sill || 0;
      const pg = new THREE.PlaneGeometry(o.w, o.h);
      const p = new THREE.Mesh(pg, m.glass);
      p.position.set(o.c, sill + o.h / 2, 0);
      p.renderOrder = 3;
      const pe = edges(pg, m.glassEdge);
      pe.position.copy(p.position);
      g.add(p, pe);
      if (o.kind === 'glassdoor') {
        const mull = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(o.c, 0, 0), new THREE.Vector3(o.c, o.h, 0)]);
        g.add(new THREE.LineSegments(mull, m.glassEdge));
      }
    });
    parent.add(g);
  }

  if (site.garage_roof) {
    (site.garage_roof.rects || [site.garage_roof.rect]).forEach(r => {
      if (!real) return box(lift, mR.wall, mR.edge, r, site.garage_roof.y);
      // an anthracite fascia and soffit, the roof grey on top only (BoxGeometry's +y face is third)
      const f = mR.frame, s = kit.solid(lift, [f, f, mR.roof, f, f, f], r, site.garage_roof.y);
      s.castShadow = s.receiveShadow = true;
    });
  }

  // real style: the boarded walls' corner boards, each as a span [lo, hi] along its wall, and how
  // far the fillers take each wall's base strip
  const corners = [], strips = new Map();
  if (real) {
    const list = [];
    (model.walls || []).forEach((w, i) => {
      if (!wallMats(w).boarded) return;
      const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]), u = [(w.b[0] - w.a[0]) / L, (w.b[1] - w.a[1]) / L];
      const side = outerSide(w, L);
      if (side) list.push({ i, a: w.a, u, n: [-u[1] * side, u[0] * side], L, t: w.t, side });
    });
    const byWall = new Map(list.map(f => [f.i, f]));
    cornerBoards(list, CORNER, PROUD).forEach(c => {
      const f = byWall.get(c.wall), s = c.dir[0] * f.u[0] + c.dir[1] * f.u[1] > 0 ? 1 : -1;
      const xp = (c.p[0] - f.a[0]) * f.u[0] + (c.p[1] - f.a[1]) * f.u[1];
      let [lo, hi] = s > 0 ? [xp + c.from, xp + c.to] : [xp - c.to, xp - c.from];
      if (c.filler) {
        const [a, b] = strips.get(c.wall) || [0, f.L];
        strips.set(c.wall, [Math.min(a, lo), Math.max(b, hi)]);
      } else {
        // a board runs from the corner up to the first opening in its way
        (model.walls[c.wall].openings || []).forEach(o => {
          const x0 = o.c - o.w / 2, x1 = o.c + o.w / 2;
          if (x0 >= hi || x1 <= lo) return;
          if (s > 0) hi = Math.min(hi, x0);
          else lo = Math.max(lo, x1);
        });
        if (hi - lo < 0.01) return;
      }
      corners.push({ ...c, f, lo, hi });
    });
  }

  (model.walls || []).forEach((w, i) => {
    const base = { ...w, top: roof.topFn(w.top), strip: strips.get(i) };
    const cut = cutOf(w);
    const mW = wallMats(w);
    if (!cut) return buildWall(group, base, mW);
    buildWall(group, { ...base, top: roof.flat(cut) }, mW);
    buildWall(lift, { ...base, openings: [], bot: roof.flat(cut) }, w.finish === 'panel' && mR.panel ? { wall: mR.panel } : mR);
  });

  // a board or filler is split at the wall's cut like the wall, the upper part in lift; a filler
  // is cladding with the wall face's metre UVs, so the boards run on from the face
  const cornerGroups = new Map();
  corners.forEach(c => {
    const w = model.walls[c.wall], { u, side, t } = c.f;
    const top = roof.topFn(w.top)(c.p[0], c.p[1]);
    const cut = cutOf(w);
    const mW = wallMats(w);
    const spans = cut ? [[group, 0, cut, mW.frame, mW.boarded], [lift, cut, top, mR.frame, mR.boarded]] : [[group, 0, top, mW.frame, mW.boarded]];
    spans.forEach(([parent, y0, y1, frame, boarded]) => {
      if (y1 - y0 < 0.01) return;
      const key = `${parent === lift} ${c.wall}`;
      let g = cornerGroups.get(key);
      if (!g) {
        g = new THREE.Group();
        g.position.set(w.a[0], 0, w.a[1]);
        g.rotation.y = Math.atan2(-u[1], u[0]);
        parent.add(g);
        cornerGroups.set(key, g);
      }
      const cx = (c.lo + c.hi) / 2, cy = (y0 + y1) / 2;
      let mesh;
      if (c.filler) {
        const geo = new THREE.PlaneGeometry(c.hi - c.lo, y1 - y0);
        if (side < 0) geo.rotateY(Math.PI);
        const pos = geo.attributes.position, uv = geo.attributes.uv;
        for (let k = 0; k < pos.count; k++) uv.setXY(k, cx + pos.getX(k), cy + pos.getY(k));
        mesh = new THREE.Mesh(geo, side > 0 ? boarded.front : boarded.back);
        mesh.position.set(cx, cy, side * (t / 2 + 0.001));
      } else {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(c.hi - c.lo, y1 - y0, PROUD), frame);
        mesh.position.set(cx, cy, side * (t / 2 + PROUD / 2));
      }
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.userData.part = 'corner';
      g.add(mesh);
    });
  });

  // a room can be several rectangles
  const floorMeshes = [];
  rooms.forEach(r => {
    r.rects.forEach(([x0, z0, x1, z1]) => {
      const mat = real ? kit.surface(r.floor || 'floor') : basic({ color: C.floor.clone(), opacity: 0.85, side: THREE.DoubleSide });
      const inset = 0.05;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - inset * 2, z1 - z0 - inset * 2), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
      mesh.renderOrder = 1;
      mesh.userData = { room: r.id, warm: 0, hover: 0, sel: 0, base: real ? mat.color.clone() : C.floor };
      mesh.receiveShadow = real;
      group.add(mesh);
      floorMeshes.push(mesh);
    });
  });

  // the real style's furniture casts and takes shadows like the walls, seen with the roof off
  (model.furniture || []).forEach(f => {
    if (f.rect) {
      if (!real) return box(group, mH.furn, mH.furnEdge, f.rect, f.y);
      const s = kit.solid(group, mH.furn, f.rect, f.y);
      s.castShadow = s.receiveShadow = true;
      return;
    }
    const [x, z, r] = f.circle;
    const cg = new THREE.CylinderGeometry(r, r, f.y[1] - f.y[0], 18);
    const c = new THREE.Mesh(cg, mH.furn);
    c.position.set(x, (f.y[0] + f.y[1]) / 2, z);
    if (!real) c.add(edges(cg, mH.furnEdge, 30));
    else c.castShadow = c.receiveShadow = true;
    group.add(c);
  });

  function shedRoof(points, h, thick) {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getY(i), d = p.getZ(i);
      p.setXYZ(i, x, h(x) - roof.gap + d, z);
    }
    geo.computeVertexNormals();
    if (real) {
      // the extrusion's first group is the top and underside, the second the edge band
      const mesh = new THREE.Mesh(geo, [mR.roof, mR.frame]);
      mesh.castShadow = mesh.receiveShadow = true;
      return lift.add(mesh);
    }
    const mesh = new THREE.Mesh(geo, mR.wall);
    mesh.renderOrder = 4;
    lift.add(mesh, edges(geo, mR.edge, 20));
  }
  for (const [id, r] of Object.entries(model.roofs || {})) shedRoof(r.outline, roof.fns[id], r.thick);
  (model.roof_steps || []).forEach(s => {
    const low = model.roofs[s.bot];
    buildWall(lift, { a: s.a, b: s.b, t: 0.2, top: roof.under(s.top), bot: x => roof.fns[s.bot](x) - roof.gap + low.thick }, mR);
  });

  // the real style's light floors tint lighter, towards amber
  const TINT = real ? [[C.amber, 0.5], [C.line, 0.3], [C.sel, 0.45]] : [[C.warm, 0.85], [C.hover, 0.6], [C.sel, 0.7]];
  let warm = new Set();
  return {
    id: 'building',
    group,
    lift,
    markers(list) {
      warm = new Set(list.filter(m => m.state === 'on' && m.warm !== false && roomIds.has(m.room)).map(m => m.room));
    },
    // the floors take taps only with the roof off
    hit(ray) {
      if (state.mode !== 'open') return null;
      const hits = ray.intersectObjects(floorMeshes, false);
      return hits.length ? { room: hits[0].object.userData.room, target: hits[0].object } : null;
    },
    update(dt, k) {
      let moving = false;
      floorMeshes.forEach(m => {
        const u = m.userData;
        const goals = [warm.has(u.room) ? 0.75 : 0, state.hovered === m ? 1 : 0, state.selection === u.room ? 1 : 0];
        ['warm', 'hover', 'sel'].forEach((key, i) => {
          if (near(u[key], goals[i])) u[key] = goals[i];
          else { u[key] += (goals[i] - u[key]) * k; moving = true; }
        });
        m.material.color.copy(u.base).lerp(TINT[0][0], u.warm * TINT[0][1]).lerp(TINT[1][0], u.hover * TINT[1][1]).lerp(TINT[2][0], u.sel * TINT[2][1]);
      });
      return moving;
    }
  };
}
