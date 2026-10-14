// The lot: decks, paving, the porch and the entrance steps, the play area (sandpit, swing,
// trampoline), the lot line, hedges, the mesh and bar fences, the outdoor units and the planters.
// The simple style draws each as a box or lines. The real style draws the solids as lit surfaces
// without outlines: the paving and porch in paving stones on metre UVs, a timber sandpit and
// A-frame swing with a nest seat and, with a slide, a tower, climbing wall and chute, a
// trampoline with its pad, mat, legs and a see-through net, the mesh fence as a wire texture on
// posts and the bar fence as bars between posts. Decks, paving, steps and sand take shadows;
// hedges, the play area, fences, planters and the outdoor units cast them. See-through things
// (the net, the mesh) do neither.
const FENCE_H = 1.2, POST_STEP = 2.5;

export default function build({ THREE, kit, C, model, style }) {
  const site = model.site || {};
  const { basic, lineMat, box, prism, edges, keep } = kit;
  const real = style === 'real';
  const group = new THREE.Group();
  const deckM = real ? kit.surface('deck') : basic({ color: C.teal, opacity: 0.04 });
  const deckE = lineMat({ color: C.teal, opacity: 0.45 });
  const plankM = real ? lineMat({ color: kit.REAL.fence, opacity: 0.5 }) : lineMat({ color: C.teal, opacity: 0.09 });
  const pathM = real ? kit.surface('paving', { map: kit.pavers() }) : basic({ color: C.lineSoft, opacity: 0.05 });
  const pathE = lineMat({ color: C.lineSoft, opacity: 0.45 });
  const shade = (m, cast) => {
    if (real) { m.castShadow = cast; m.receiveShadow = !cast; }
    return m;
  };
  // a deck or paving item is a rect [x0, z0, x1, z1] or an outline [[x, z], ...]
  const isOutline = v => Array.isArray(v[0]);
  const outlineOf = ([x0, z0, x1, z1]) => [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
  function slab(v, mat, emat, y) {
    if (!isOutline(v)) return real ? kit.solid(group, mat, v, y) : box(group, mat, emat, v, y);
    const geo = prism(v, y[0], y[1]);
    const m = new THREE.Mesh(geo, mat);
    if (!real) m.add(edges(geo, emat));
    group.add(m);
    return m;
  }
  // real style: paving stones run on metre UVs, which a prism has and a box has not
  const paved = v => (real && !isOutline(v) ? outlineOf(v) : v);
  // real style: a box from point p to point q ([x, y, z]), w wide along across (any direction
  // round the axis when not given) and d deep, its ends kept for the tests
  const up = new THREE.Vector3(0, 1, 0);
  function strut(p, q, w, d, mat, part, across) {
    const a = new THREE.Vector3(...p), b = new THREE.Vector3(...q), dir = b.clone().sub(a), len = dir.length();
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, len, d), mat);
    m.position.copy(a).add(b).multiplyScalar(0.5);
    dir.normalize();
    if (across) {
      const x = new THREE.Vector3(...across).addScaledVector(dir, -new THREE.Vector3(...across).dot(dir)).normalize();
      m.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, dir, x.clone().cross(dir)));
    } else m.quaternion.setFromUnitVectors(up, dir);
    m.userData = { part, ends: [p, q] };
    group.add(m);
    return m;
  }
  // an outline's planks run where each line z crosses it: an edge counts when its ends lie on
  // either side of z (one end exactly on z counts as below), so level edges never count and the
  // crossings pair up
  function outlinePlanks(v, pts) {
    const zs = v.map(p => p[1]), zMin = Math.min(...zs), zMax = Math.max(...zs);
    for (let i = 1; zMin + 0.4 * i < zMax; i++) {
      const z = zMin + 0.4 * i, xs = [];
      v.forEach(([xa, za], k) => {
        const [xb, zb] = v[(k + 1) % v.length];
        if ((za > z) !== (zb > z)) xs.push(xa + ((z - za) * (xb - xa)) / (zb - za));
      });
      xs.sort((p, q) => p - q);
      for (let k = 0; k + 1 < xs.length; k += 2) pts.push(new THREE.Vector3(xs[k], 0.125, z), new THREE.Vector3(xs[k + 1], 0.125, z));
    }
  }
  (site.decks || []).forEach(v => {
    shade(slab(v, deckM, deckE, [0, 0.12]), false);
    const pts = [];
    if (isOutline(v)) outlinePlanks(v, pts);
    else {
      const [x0, z0, x1, z1] = v;
      for (let z = z0 + 0.4; z < z1; z += 0.4) pts.push(new THREE.Vector3(x0, 0.125, z), new THREE.Vector3(x1, 0.125, z));
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), plankM));
  });
  (site.paving || []).forEach(v => shade(slab(paved(v), pathM, pathE, [0, 0.02]), false));
  if (site.porch) shade(slab(paved(site.porch), pathM, pathE, [0, 0.03]), false);
  if (site.sandpit) {
    if (real) sandpit(site.sandpit);
    else slab(site.sandpit.rect, pathM, pathE, [0, site.sandpit.height]);
  }
  if (site.swing) {
    if (real) swing(site.swing);
    else {
      const [x0, z0, x1, z1] = site.swing.rect, h = site.swing.height;
      [z0, z1].forEach(z => slab([x0, z - 0.05, x1, z + 0.05], pathM, pathE, [0, h]));
      slab([x0, z0, x1, z1], pathM, pathE, [h - 0.1, h]);
    }
  }
  if (site.lot) {
    const lotLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(site.lot.map(([x, z]) => new THREE.Vector3(x, 0.03, z))),
      keep(new THREE.LineDashedMaterial({ color: real ? kit.REAL.fence : C.roof, transparent: true, opacity: 0.6, dashSize: 0.6, gapSize: 0.4 })));
    lotLine.computeLineDistances();
    group.add(lotLine);
  }
  const hedgeM = real ? kit.surface('hedge') : basic({ color: C.hedge, opacity: 0.2 });
  const hedgeE = lineMat({ color: C.teal, opacity: 0.28 });
  (site.hedges || []).forEach(([[xa, za], [xb, zb]]) => {
    const geo = new THREE.BoxGeometry(Math.hypot(xb - xa, zb - za), 1.6, 0.8);
    const m = new THREE.Mesh(geo, hedgeM);
    m.position.set((xa + xb) / 2, 0.8, (za + zb) / 2);
    m.rotation.y = -Math.atan2(zb - za, xb - xa);
    if (!real) m.add(edges(geo, hedgeE));
    group.add(shade(m, true));
  });
  if (real) fences();
  else {
    const fenceE = lineMat({ color: C.lineSoft, opacity: 0.38 });
    [...(site.fences || []), ...(site.bar_fences || [])].forEach(([[xa, za], [xb, zb]]) => {
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 2.5)), pts = [];
      [0.05, FENCE_H].forEach(y => pts.push(new THREE.Vector3(xa, y, za), new THREE.Vector3(xb, y, zb)));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n, z = za + ((zb - za) * i) / n;
        pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, FENCE_H, z));
      }
      group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), fenceE));
    });
  }
  const frameM = real ? kit.surface('unit') : basic({ color: C.wall, opacity: 0.35 });
  const frameE = lineMat({ color: C.line, opacity: 0.75 });
  (site.outdoor_units || []).forEach(u => shade(slab(u.rect, frameM, frameE, u.y), true));
  if (real) {
    if (site.trampoline) trampoline(site.trampoline);
    const stoneM = kit.surface('stone');
    (site.steps || []).forEach(s => shade(kit.solid(group, stoneM, s.rect, [0, s.height]), false));
    planters();
  } else {
    // the newer items as plain boxes on the existing materials
    if (site.trampoline) box(group, pathM, pathE, site.trampoline.rect, [0, site.trampoline.height]);
    (site.steps || []).forEach(s => box(group, pathM, pathE, s.rect, [0, s.height]));
    (site.planters || []).forEach(p => box(group, frameM, frameE, p.rect, p.y));
  }
  return { id: 'site', group };

  // real style: a frame of four boards 0.05 thick, a 0.15 wide ledge on top, the sand inset
  // and 0.08 under the frame's top
  function sandpit({ rect: [x0, z0, x1, z1], height: h }) {
    const timber = kit.surface('timber'), T = 0.05, L = 0.15, LT = 0.03;
    [[x0, z0, x1, z0 + T], [x0, z1 - T, x1, z1], [x0, z0 + T, x0 + T, z1 - T], [x1 - T, z0 + T, x1, z1 - T]]
      .forEach(r => shade(kit.solid(group, timber, r, [0, h - LT]), true));
    [[x0, z0, x1, z0 + L], [x0, z1 - L, x1, z1], [x0, z0 + L, x0 + L, z1 - L], [x1 - L, z0 + L, x1, z1 - L]]
      .forEach(r => shade(kit.solid(group, timber, r, [h - LT, h]), true).userData.part = 'ledge');
    shade(kit.solid(group, kit.surface('sand'), [x0 + T, z0 + T, x1 - T, z1 - T], [0, h - 0.08]), false).userData.part = 'sand';
  }

  // real style: an A-frame swing along the rect's long axis with a nest seat; with slide, a tower
  // past the beam end nearer to it, with a climbing wall on its outer side and a chute to slide
  function swing({ rect: [x0, z0, x1, z1], height: h, slide }) {
    const timber = kit.surface('timber');
    const alongX = x1 - x0 >= z1 - z0;
    // plan points from (s along the beam from its first end, t across from its centre line)
    const c = alongX ? (z0 + z1) / 2 : (x0 + x1) / 2, [s0, s1] = alongX ? [x0, x1] : [z0, z1];
    const at = (s, t) => (alongX ? [s, c + t] : [c + t, s]);
    const p3 = (s, t, y) => { const [x, z] = at(s, t); return [x, y, z]; };
    const beam = h - 0.05;
    shade(strut(p3(s0, 0, beam), p3(s1, 0, beam), 0.1, 0.1, timber, 'beam'), true);
    const spread = 0.9, brace = 0.8, bt = spread * (1 - brace / beam);
    [s0, s1].forEach(s => {
      [-1, 1].forEach(k => shade(strut(p3(s, 0, beam), p3(s, k * spread, 0), 0.08, 0.08, timber, 'leg'), true));
      shade(strut(p3(s, -bt, brace), p3(s, bt, brace), 0.06, 0.06, timber, 'brace'), true);
    });
    // the tower end is the beam end nearer to the slide's foot
    const dist = s => { const [x, z] = at(s, 0); return slide ? Math.hypot(slide[0] - x, slide[1] - z) : 0; };
    const near = slide && dist(s0) < dist(s1) ? s0 : s1, far = near === s0 ? s1 : s0;
    const ns = far + (near - far) / 3, [nx, nz] = at(ns, 0), seatY = 0.55, R = 0.5;
    const nest = new THREE.Mesh(new THREE.TorusGeometry(R, 0.07, 8, 24), kit.surface('nest'));
    nest.rotation.x = Math.PI / 2;
    nest.position.set(nx, seatY, nz);
    nest.userData.part = 'nest';
    group.add(shade(nest, true));
    const ropes = [];
    [0, 1, 2, 3].forEach(i => {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      ropes.push(new THREE.Vector3(nx + R * Math.cos(a), seatY, nz + R * Math.sin(a)), new THREE.Vector3(...p3(ns + (i < 2 ? 0.1 : -0.1) * Math.sign(near - far || 1), 0, beam - 0.05)));
    });
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ropes), lineMat({ color: kit.REAL.mat, opacity: 0.9 })));
    if (!slide) return;
    // the platform stands just past the beam end, its posts at the corners
    const out = Math.sign(near - far), P = 0.9, PY = 1.2, ps = near + out * (spread * 0.1 + P / 2);
    const [px, pz] = at(ps, 0);
    shade(kit.solid(group, timber, [px - P / 2, pz - P / 2, px + P / 2, pz + P / 2], [PY - 0.05, PY]), true).userData.part = 'platform';
    [-1, 1].forEach(i => [-1, 1].forEach(k => shade(strut([px + (i * P) / 2.2, 0, pz + (k * P) / 2.2], [px + (i * P) / 2.2, PY + 0.6, pz + (k * P) / 2.2], 0.07, 0.07, timber, 'leg'), true)));
    // the climbing wall leans from the ground beyond the outer edge up to it
    shade(strut(p3(ps + out * (P / 2 + 0.6), 0, 0), p3(ps + out * (P / 2), 0, PY), P, 0.03, timber, 'wall', alongX ? [0, 0, 1] : [1, 0, 0]), true);
    // the chute from the platform's edge towards the foot, with a low side either way
    const dx = slide[0] - px, dz = slide[1] - pz, dl = Math.hypot(dx, dz) || 1, ux = dx / dl, uz = dz / dl;
    const top = [px + (ux * P) / 2, PY, pz + (uz * P) / 2], foot = [slide[0], 0.3, slide[1]], W = 0.45;
    const slideM = kit.surface('slide'), across = [-uz, 0, ux];
    shade(strut(top, foot, W, 0.03, slideM, 'chute', across), true);
    [-1, 1].forEach(k => {
      const o = [-uz * k * (W / 2), 0.08, ux * k * (W / 2)];
      shade(strut(top.map((v, i) => v + o[i]), foot.map((v, i) => v + o[i]), 0.03, 0.12, slideM, 'chute-side', across), true);
    });
  }

  // real style: a rounded rect (semicircular ends) on the rect's long axis, a pad ring at height,
  // the mat inside it, six legs and six net poles, and the net as a see-through ribbon
  function trampoline({ rect: [x0, z0, x1, z1], height: h }) {
    const alongX = x1 - x0 >= z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    const R = (alongX ? z1 - z0 : x1 - x0) / 2, straight = (alongX ? x1 - x0 : z1 - z0) / 2 - R;
    // each end a semicircle round (+-straight, 0) in (along, across), counter-clockwise
    // a square rect has no straight part: its two ends meet, so each end drops its last point
    const ring = inset => [1, -1].flatMap(e => Array.from({ length: straight > 1e-6 ? 13 : 12 }, (_, i) => {
      const r = Math.max(R * 0.2, R - inset), a = (e > 0 ? -Math.PI / 2 : Math.PI / 2) + (i * Math.PI) / 12, s = e * straight + r * Math.cos(a), t = r * Math.sin(a);
      return alongX ? [cx + s, cz + t] : [cx + t, cz + s];
    }));
    const outer = ring(0), inner = ring(0.3);
    const shape = new THREE.Shape(outer.map(([x, z]) => new THREE.Vector2(x, z)));
    shape.holes.push(new THREE.Path(inner.map(([x, z]) => new THREE.Vector2(x, z))));
    const padGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.05, bevelEnabled: false });
    padGeo.rotateX(Math.PI / 2);
    padGeo.translate(0, h, 0);
    const pad = new THREE.Mesh(padGeo, kit.surface('pad'));
    group.add(shade(pad, true));
    const matM = kit.surface('mat');
    const mat = new THREE.Mesh(kit.flatShape(inner), matM);
    mat.position.y = h - 0.03;
    group.add(shade(mat, true));
    const n = outer.length, posts = [0, 1, 2, 3, 4, 5].map(i => outer[Math.floor(((i + 0.5) * n) / 6)]);
    posts.forEach(([x, z]) => {
      shade(strut([x, 0, z], [x, h - 0.05, z], 0.05, 0.05, matM, 'leg'), true);
      shade(strut([x, h, z], [x, h + 1.7, z], 0.035, 0.035, matM, 'pole'), true);
    });
    const pos = [];
    outer.forEach(([xa, za], i) => {
      const [xb, zb] = outer[(i + 1) % n];
      pos.push(xa, h, za, xb, h, zb, xb, h + 1.7, zb, xa, h, za, xb, h + 1.7, zb, xa, h + 1.7, za);
    });
    const netGeo = new THREE.BufferGeometry();
    netGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    netGeo.computeVertexNormals();
    const net = new THREE.Mesh(netGeo, kit.surface('net', { transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false }));
    net.castShadow = net.receiveShadow = false;
    net.userData.part = 'net';
    group.add(net);
  }

  // real style: the mesh fence as posts and a wire plane per segment, the bar fence as posts and
  // bars per span; no post within 5 cm of a gate post (the gate draws its own) or of another post
  function fences() {
    const postM = kit.surface('fence');
    const meshM = kit.surface('mesh', { map: kit.wireMesh(), transparent: true, side: THREE.DoubleSide, depthWrite: false });
    const gatePosts = (site.gates || []).flatMap(g => [g.a, g.b]), posts = [];
    const post = ([x, z], w) => {
      if ([...gatePosts, ...posts].some(([px, pz]) => Math.hypot(px - x, pz - z) < 0.05)) return;
      posts.push([x, z]);
      shade(kit.solid(group, postM, [x - w / 2, z - w / 2, x + w / 2, z + w / 2], [0, FENCE_H + 0.05]), true).userData.part = 'post';
    };
    const spans = ([xa, za], [xb, zb], w) => {
      const n = Math.max(1, Math.ceil(Math.hypot(xb - xa, zb - za) / POST_STEP)), pts = [];
      for (let i = 0; i <= n; i++) pts.push([xa + ((xb - xa) * i) / n, za + ((zb - za) * i) / n]);
      pts.forEach(p => post(p, w));
      return pts;
    };
    (site.fences || []).forEach(([a, b]) => {
      spans(a, b, 0.05);
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]), geo = new THREE.PlaneGeometry(L, FENCE_H - 0.05);
      const uv = geo.attributes.uv;
      for (let k = 0; k < uv.count; k++) uv.setXY(k, uv.getX(k) * L, 0.05 + uv.getY(k) * (FENCE_H - 0.05));
      const m = new THREE.Mesh(geo, meshM);
      m.position.set((a[0] + b[0]) / 2, (0.05 + FENCE_H) / 2, (a[1] + b[1]) / 2);
      m.rotation.y = -Math.atan2(b[1] - a[1], b[0] - a[0]);
      m.castShadow = m.receiveShadow = false;
      m.userData.part = 'mesh';
      group.add(m);
    });
    (site.bar_fences || []).forEach(([a, b]) => {
      const pts = spans(a, b, 0.06);
      pts.slice(1).forEach(([xb, zb], i) => {
        const [xa, za] = pts[i], g = kit.bars(Math.hypot(xb - xa, zb - za), FENCE_H, postM);
        g.position.set(xa, 0, za);
        g.rotation.y = -Math.atan2(zb - za, xb - xa);
        g.userData.part = 'bars';
        group.add(g);
      });
    });
  }

  // real style: a planter is a box in the frame anthracite or the cladding, a thuja a column
  // above it, a low plant a box on it
  function planters() {
    const fin = { frame: kit.surface('frame'), cladding: kit.surface('cladding') };
    (site.planters || []).forEach(p => {
      const [x0, z0, x1, z1] = p.rect, top = p.y[1];
      shade(kit.solid(group, fin[p.finish || 'frame'], p.rect, p.y), true).userData.part = 'planter';
      if (p.plant === 'thuja') {
        const t = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 1.5, 12), hedgeM);
        t.position.set((x0 + x1) / 2, top + 0.75, (z0 + z1) / 2);
        group.add(shade(t, true));
      } else if (p.plant === 'low') shade(kit.solid(group, hedgeM, [x0 + 0.08, z0 + 0.08, x1 - 0.08, z1 - 0.08], [top, top + 0.25]), true);
    });
  }
}
