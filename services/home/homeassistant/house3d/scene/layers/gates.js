// Gates in the fence line, drawn like the fence. Each leaf hangs on a pivot so the drive gate
// can open for the car; a post two gates share is drawn once.
const SLIDE_OFFSET = 0.12; // a sliding leaf runs this far to the lot side of the fence line, past its rails
const yawOf = (dx, dz) => Math.atan2(-dz, dx); // rotation.y that turns local +x along (dx, dz)

// segment crossing, for the drive gate: the path's waypoints taken as straight legs, as the
// model validator takes them
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
const between = (p, q, a, b) => Math.min(p[0], q[0]) <= Math.max(a[0], b[0]) && Math.min(a[0], b[0]) <= Math.max(p[0], q[0])
  && Math.min(p[1], q[1]) <= Math.max(a[1], b[1]) && Math.min(a[1], b[1]) <= Math.max(p[1], q[1]);
const meets = (p, q, a, b) => {
  const d1 = cross(a, b, p), d2 = cross(a, b, q), d3 = cross(p, q, a), d4 = cross(p, q, b);
  return (d1 * d2 <= 0) && (d3 * d4 <= 0) && between(p, q, a, b);
};

export default function build({ THREE, kit, C, model, frame }) {
  const list = (model.site || {}).gates || [];
  if (!list.length) return null;
  const { lotCx, lotCz } = frame;
  const group = new THREE.Group();
  const gateE = kit.lineMat({ color: C.lineSoft, opacity: 0.5 });
  const postM = kit.basic({ color: C.wall, opacity: 0.35 });
  const postE = kit.lineMat({ color: C.lineSoft, opacity: 0.6 });
  const gatePosts = new Set();
  function leafGeo(len, h) {
    const n = Math.max(1, Math.round(len / 0.12)), pts = [];
    [0.05, h].forEach(y => pts.push(new THREE.Vector3(0, y, 0), new THREE.Vector3(len, y, 0)));
    for (let i = 0; i <= n; i++) pts.push(new THREE.Vector3((len * i) / n, 0.05, 0), new THREE.Vector3((len * i) / n, h, 0));
    return new THREE.BufferGeometry().setFromPoints(pts);
  }
  function buildGate(g) {
    const [ax, az] = g.a, [bx, bz] = g.b, w = Math.hypot(bx - ax, bz - az), ux = (bx - ax) / w, uz = (bz - az) / w;
    // the lot side, as the model validator's gate_inward() takes it
    let nx = -uz, nz = ux;
    if ((lotCx - ax) * nx + (lotCz - az) * nz < 0) { nx = -nx; nz = -nz; }
    [g.a, g.b].forEach(([x, z]) => {
      const key = `${x.toFixed(2)},${z.toFixed(2)}`;
      if (gatePosts.has(key)) return;
      gatePosts.add(key);
      kit.box(group, postM, postE, [x - 0.05, z - 0.05, x + 0.05, z + 0.05], [0, g.height + 0.1]);
    });
    const side = g.opens === 'out' ? -1 : 1, leaves = [];
    const leaf = (x, z, dx, dz, len) => {
      const pivot = new THREE.Object3D();
      pivot.position.set(x, 0, z);
      pivot.rotation.y = yawOf(dx, dz);
      pivot.add(new THREE.LineSegments(leafGeo(len, g.height), gateE));
      group.add(pivot);
      const turn = yawOf(side * nx, side * nz) - pivot.rotation.y;
      leaves.push({ pivot, x, z, closed: pivot.rotation.y, turn: Math.atan2(Math.sin(turn), Math.cos(turn)) });
    };
    let sweepIn = 0;
    if (g.kind === 'sliding') {
      leaf(ax + nx * SLIDE_OFFSET, az + nz * SLIDE_OFFSET, ux, uz, w);
      sweepIn = SLIDE_OFFSET;
    } else if (g.kind === 'swing2') {
      leaf(ax, az, ux, uz, w / 2);
      leaf(bx, bz, -ux, -uz, w / 2);
      sweepIn = side > 0 ? w / 2 : 0;
    } else {
      leaf(ax, az, ux, uz, w);
      sweepIn = side > 0 ? w : 0;
    }
    const s = g.slide === 'a' ? -1 : 1;
    return { g, w, nx, nz, leaves, sweepIn, slide: [s * ux, s * uz] };
  }
  const gates = list.map(buildGate);
  // f from 0 (closed) to 1: a sliding leaf moves f times its width past its slide end, a swing leaf
  // turns f times a quarter towards its opens side
  function setGate(gate, f) {
    gate.leaves.forEach(l => {
      if (gate.g.kind === 'sliding') l.pivot.position.set(l.x + gate.slide[0] * f * gate.w, 0, l.z + gate.slide[1] * f * gate.w);
      else l.pivot.rotation.y = l.closed + l.turn * f;
    });
  }
  return {
    id: 'gates',
    group,
    api: {
      setGate,
      // the gate a path [[x, z], ...] crosses, or null
      driveGate: path => gates.find(gt => path.some((p, i) => i > 0 && meets(path[i - 1], p, gt.g.a, gt.g.b))) || null
    }
  };
}
