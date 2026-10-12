// The car: drawn from options.car's profile and built hidden. It stands at the path's end or
// drives the path in after the drive gate, if any, has opened. It sits outside the building's
// lift, so it shows in both modes, and has its own materials, so fading it never fades the house.
const GATE_S = 1.2; // the drive gate's opening and closing time
const CAR_CLEARANCE = 0.3; // the car's tail clears the gate leaves' sweep by this before the gate closes

export default function build({ THREE, kit, C, options, reduceMotion, layer, screen, invalidate }) {
  const carOpt = options.car;
  if (!(carOpt && carOpt.profile && Array.isArray(carOpt.path) && carOpt.path.length >= 2)) return null;
  const { keep, lineMat, mats, edges, canvasTexture, applyFade, near } = kit;

  function buildCar(p, path) {
    const g = new THREE.Group();
    const m = mats();
    m.wall.opacity = 0.22;
    const belt = Math.min(...p.glass.map(q => q[1]));
    // the greenhouse narrows above the beltline, which reads as a car rather than a box
    const narrow = y => 1 - 0.16 * Math.min(1, Math.max(0, (y - belt) / Math.max(0.01, p.height - belt)));
    const geo = keep(new THREE.ExtrudeGeometry(new THREE.Shape(p.side.map(([x, y]) => new THREE.Vector2(x, y))), { depth: p.width, bevelEnabled: false }));
    geo.translate(0, 0, -p.width / 2);
    const pa = geo.attributes.position;
    for (let i = 0; i < pa.count; i++) pa.setZ(i, pa.getZ(i) * narrow(pa.getY(i)));
    const body = new THREE.Mesh(geo, m.wall);
    body.renderOrder = 2;
    g.add(body, edges(geo, m.edge, 25));

    const glassShape = new THREE.Shape(p.glass.map(([x, y]) => new THREE.Vector2(x, y)));
    [-1, 1].forEach(s => {
      const z = y => s * ((p.width / 2) * narrow(y) + 0.004);
      g.add(new THREE.LineLoop(keep(new THREE.BufferGeometry().setFromPoints(p.glass.map(([x, y]) => new THREE.Vector3(x, y, z(y))))), m.glassEdge));
      const fill = keep(new THREE.ShapeGeometry(glassShape));
      const fa = fill.attributes.position;
      for (let i = 0; i < fa.count; i++) fa.setZ(i, z(fa.getY(i)));
      const pane = new THREE.Mesh(fill, m.glass);
      pane.renderOrder = 3;
      g.add(pane);
    });

    // wheels: a tyre with a rim and spokes on its outer face, so the turning shows
    const { r, track } = p.wheels, tw = Math.min(0.25, track / 6);
    const tyre = keep(new THREE.CylinderGeometry(r, r, tw, 20));
    tyre.rotateX(Math.PI / 2);
    const tyreEdges = keep(new THREE.EdgesGeometry(tyre, 30));
    const hubs = [-1, 1].map(s => {
      const pts = [], zf = s * (tw / 2 + 0.003);
      for (let i = 0; i < 20; i++) {
        const a = (i / 20) * Math.PI * 2, b = ((i + 1) / 20) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68, zf), new THREE.Vector3(Math.cos(b) * r * 0.68, Math.sin(b) * r * 0.68, zf));
      }
      for (let i = 0; i < 5; i++) {
        const a = (i / 5) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * r * 0.12, Math.sin(a) * r * 0.12, zf), new THREE.Vector3(Math.cos(a) * r * 0.68, Math.sin(a) * r * 0.68, zf));
      }
      return keep(new THREE.BufferGeometry().setFromPoints(pts));
    });
    const wheels = [];
    p.wheels.x.forEach(x => [-1, 1].forEach((s, i) => {
      const w = new THREE.Group();
      w.position.set(x, r, (s * track) / 2);
      w.add(new THREE.Mesh(tyre, m.furn), new THREE.LineSegments(tyreEdges, m.edge), new THREE.LineSegments(hubs[i], m.furnEdge));
      g.add(w);
      wheels.push(w);
    }));

    // sprites are not faded by applyFade, so their materials are kept for the car's own fade
    const glowTex = canvasTexture(64, [[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.4)'], [1, 'rgba(255,255,255,0)']]);
    const sprites = [];
    [['front', C.ink], ['rear', C.alert]].forEach(([k, color]) => {
      const segs = (p.lights && p.lights[k]) || [];
      if (!segs.length) return;
      const pts = segs.flat().map(([x, y, z]) => new THREE.Vector3(x, y, z));
      g.add(new THREE.LineSegments(keep(new THREE.BufferGeometry().setFromPoints(pts)), lineMat({ color, opacity: 0.95 })));
      const sm = keep(new THREE.SpriteMaterial({ map: glowTex, color, transparent: true, opacity: 0.6, depthWrite: false, blending: THREE.AdditiveBlending }));
      sm.userData.base = sm.opacity;
      sprites.push(sm);
      segs.forEach(([a, b]) => {
        const sp = new THREE.Sprite(sm);
        sp.position.set((a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2);
        sp.scale.set(0.75, 0.75, 1);
        g.add(sp);
      });
    });

    const curve = new THREE.CatmullRomCurve3(path.map(([x, z]) => new THREE.Vector3(x, 0, z)), false, 'centripetal');
    g.visible = false;
    return { g, body, wheels, sprites, curve, length: curve.getLength(), r, centreY: p.height / 2 };
  }
  const car = buildCar(carOpt.profile, carOpt.path);
  let carState = 'away', drive = null, carFadeShown = -1;
  const carFade = { cur: 0, to: 0 };
  function placeCar(u) {
    const at = car.curve.getPointAt(u), tan = car.curve.getTangentAt(u);
    car.g.position.set(at.x, 0, at.z);
    car.g.rotation.y = Math.atan2(-tan.z, tan.x);
    const turn = -(u * car.length) / car.r;
    car.wheels.forEach(w => { w.rotation.z = turn; });
  }

  // the drive gate is the one the car's path crosses; it opens before the drive-in and closes
  // once the car is through
  const gates = layer('gates');
  const driveGate = gates ? gates.api.driveGate(carOpt.path) : null;
  let gateF = 0, gateRun = null;
  function gateTo(to) {
    if (driveGate) gateRun = { from: gateF, to, elapsed: 0 };
  }
  function gateNow(f) {
    gateRun = null;
    gateF = f;
    if (driveGate) gates.api.setGate(driveGate, f);
  }
  // the car's tail is past the gate line by the leaves' inward sweep and a margin
  function carThrough() {
    const hl = carOpt.profile.length / 2, yaw = car.g.rotation.y;
    const tx = car.g.position.x - Math.cos(yaw) * hl, tz = car.g.position.z + Math.sin(yaw) * hl;
    return (tx - driveGate.g.a[0]) * driveGate.nx + (tz - driveGate.g.a[1]) * driveGate.nz >= driveGate.sweepIn + CAR_CLEARANCE;
  }

  function update(dt, k) {
    let moving = false;
    if (drive) {
      // frame time, not the clock: a drive started while the page is hidden waits to be seen.
      // The car stands at the start while the gate opens, then drives.
      let step = Math.max(0, dt);
      if (drive.wait > 0) {
        const w = Math.min(drive.wait, step);
        drive.wait -= w;
        step -= w;
      }
      drive.elapsed += step;
      const t = Math.min(1, drive.elapsed / drive.dur);
      placeCar(1 - (1 - t) * (1 - t));
      moving = true;
      // the close runs on its own clock from here, so the end of the drive does not cut it short
      if (driveGate && !drive.closing && (t >= 1 || carThrough())) { drive.closing = true; gateTo(0); }
      if (t >= 1) { drive = null; carState = 'parked'; }
    }
    if (gateRun) {
      gateRun.elapsed += Math.max(0, dt);
      const s = Math.min(1, gateRun.elapsed / GATE_S);
      gateF = gateRun.from + (gateRun.to - gateRun.from) * s * s * (3 - 2 * s);
      gates.api.setGate(driveGate, gateF);
      moving = true;
      if (s >= 1) gateRun = null;
    }
    if (!near(carFade.cur, carFade.to)) { carFade.cur += (carFade.to - carFade.cur) * k; moving = true; } else carFade.cur = carFade.to;
    if (carFade.cur !== carFadeShown) {
      carFadeShown = carFade.cur;
      applyFade(car.g, carFade.cur);
      car.sprites.forEach(sm => { sm.opacity = sm.userData.base * carFade.cur; });
    }
    return moving;
  }

  function setCar(state) {
    if (state === 'arrive' && reduceMotion) state = 'parked';
    if (state === 'arrive') {
      drive = { elapsed: 0, dur: Math.min(6, Math.max(3, car.length / 3.2)), wait: driveGate ? GATE_S : 0, closing: false };
      gateTo(1);
      placeCar(0);
      carState = 'driving';
      carFade.to = 1;
    } else if (state === 'parked') {
      drive = null;
      gateNow(0);
      placeCar(1);
      carState = 'parked';
      carFade.to = 1;
    } else {
      drive = null;
      gateNow(0);
      carState = 'away';
      carFade.to = 0;
    }
    invalidate();
  }

  return {
    id: 'car',
    group: car.g,
    update,
    // the body mesh, not a bounding box, which would cover the carport floor
    hit: ray => (carState !== 'away' && car.g.visible && ray.intersectObject(car.body, false).length ? { car: true } : null),
    api: {
      setCar,
      get carState() { return carState; },
      get carScreen() { return carState === 'away' ? null : screen(car.g.position.x, car.centreY, car.g.position.z); }
    }
  };
}
