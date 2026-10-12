// The lot: decks, paving, the porch, the sandpit and the swing, the lot line, hedges, fences
// and the outdoor units.
export default function build({ THREE, kit, C, model }) {
  const site = model.site || {};
  const { basic, lineMat, box, prism, edges, keep } = kit;
  const group = new THREE.Group();
  const deckM = basic({ color: C.teal, opacity: 0.04 });
  const deckE = lineMat({ color: C.teal, opacity: 0.45 });
  const plankM = lineMat({ color: C.teal, opacity: 0.09 });
  const pathM = basic({ color: C.lineSoft, opacity: 0.05 });
  const pathE = lineMat({ color: C.lineSoft, opacity: 0.45 });
  // a deck or paving item is a rect [x0, z0, x1, z1] or an outline [[x, z], ...]
  const isOutline = v => Array.isArray(v[0]);
  function slab(v, mat, emat, y) {
    if (!isOutline(v)) return box(group, mat, emat, v, y);
    const geo = prism(v, y[0], y[1]);
    const m = new THREE.Mesh(geo, mat);
    m.add(edges(geo, emat));
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
    slab(v, deckM, deckE, [0, 0.12]);
    const pts = [];
    if (isOutline(v)) outlinePlanks(v, pts);
    else {
      const [x0, z0, x1, z1] = v;
      for (let z = z0 + 0.4; z < z1; z += 0.4) pts.push(new THREE.Vector3(x0, 0.125, z), new THREE.Vector3(x1, 0.125, z));
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), plankM));
  });
  (site.paving || []).forEach(v => slab(v, pathM, pathE, [0, 0.02]));
  if (site.porch) box(group, pathM, pathE, site.porch, [0, 0.03]);
  if (site.sandpit) box(group, pathM, pathE, site.sandpit.rect, [0, site.sandpit.height]);
  if (site.swing) {
    const [x0, z0, x1, z1] = site.swing.rect, h = site.swing.height;
    [z0, z1].forEach(z => box(group, pathM, pathE, [x0, z - 0.05, x1, z + 0.05], [0, h]));
    box(group, pathM, pathE, [x0, z0, x1, z1], [h - 0.1, h]);
  }
  if (site.lot) {
    const lotLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(site.lot.map(([x, z]) => new THREE.Vector3(x, 0.03, z))),
      keep(new THREE.LineDashedMaterial({ color: C.roof, transparent: true, opacity: 0.6, dashSize: 0.6, gapSize: 0.4 })));
    lotLine.computeLineDistances();
    group.add(lotLine);
  }
  const hedgeM = basic({ color: C.hedge, opacity: 0.2 });
  const hedgeE = lineMat({ color: C.teal, opacity: 0.28 });
  (site.hedges || []).forEach(([[xa, za], [xb, zb]]) => {
    const geo = new THREE.BoxGeometry(Math.hypot(xb - xa, zb - za), 1.6, 0.8);
    const m = new THREE.Mesh(geo, hedgeM);
    m.position.set((xa + xb) / 2, 0.8, (za + zb) / 2);
    m.rotation.y = -Math.atan2(zb - za, xb - xa);
    m.add(edges(geo, hedgeE));
    group.add(m);
  });
  const fenceE = lineMat({ color: C.lineSoft, opacity: 0.38 });
  (site.fences || []).forEach(([[xa, za], [xb, zb]]) => {
    const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 2.5)), pts = [];
    [0.05, 1.2].forEach(y => pts.push(new THREE.Vector3(xa, y, za), new THREE.Vector3(xb, y, zb)));
    for (let i = 0; i <= n; i++) {
      const x = xa + ((xb - xa) * i) / n, z = za + ((zb - za) * i) / n;
      pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 1.2, z));
    }
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), fenceE));
  });
  const frameM = basic({ color: C.wall, opacity: 0.35 });
  const frameE = lineMat({ color: C.line, opacity: 0.75 });
  (site.outdoor_units || []).forEach(u => box(group, frameM, frameE, u.rect, u.y));
  return { id: 'site', group };
}
