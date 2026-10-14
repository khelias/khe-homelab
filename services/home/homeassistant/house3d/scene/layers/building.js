// The buildings: walls, room floors, furniture, roofs and roof steps, and the garage roof.
// Walls that run up to a roof are cut at the ceiling, and the part above goes in lift with the
// roofs, which rises and fades with the roof mode. The floors are the room tap targets and warm
// with a room's markers in state 'on'.
export default function build({ THREE, kit, C, model, roof, ceiling, state }) {
  const { basic, mats, edges, box, near } = kit;
  const site = model.site || {};
  const rooms = model.rooms || [];
  const roomIds = new Set(rooms.map(r => r.id));
  const group = new THREE.Group(), lift = new THREE.Group();
  const mH = mats(), mR = mats(C.roof);
  mR.wall.opacity = 0.28;
  mR.wall.color = C.roofFill;

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

  if (site.garage_roof) (site.garage_roof.rects || [site.garage_roof.rect]).forEach(r => box(lift, mR.wall, mR.edge, r, site.garage_roof.y));

  (model.walls || []).forEach(w => {
    const base = { ...w, top: roof.topFn(w.top) };
    const cut = w.cut ?? (typeof w.top === 'string' ? ceiling : 0);
    if (!cut) return buildWall(group, base, mH);
    buildWall(group, { ...base, top: roof.flat(cut) }, mH);
    buildWall(lift, { ...base, openings: [], bot: roof.flat(cut) }, mR);
  });

  // a room can be several rectangles
  const floorMeshes = [];
  rooms.forEach(r => {
    r.rects.forEach(([x0, z0, x1, z1]) => {
      const mat = basic({ color: C.floor.clone(), opacity: 0.85, side: THREE.DoubleSide });
      const inset = 0.05;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - inset * 2, z1 - z0 - inset * 2), mat);
      mesh.rotation.x = -Math.PI / 2;
      mesh.position.set((x0 + x1) / 2, 0.02, (z0 + z1) / 2);
      mesh.renderOrder = 1;
      mesh.userData = { room: r.id, warm: 0, hover: 0, sel: 0 };
      group.add(mesh);
      floorMeshes.push(mesh);
    });
  });

  (model.furniture || []).forEach(f => {
    if (f.rect) return box(group, mH.furn, mH.furnEdge, f.rect, f.y);
    const [x, z, r] = f.circle;
    const cg = new THREE.CylinderGeometry(r, r, f.y[1] - f.y[0], 18);
    const c = new THREE.Mesh(cg, mH.furn);
    c.position.set(x, (f.y[0] + f.y[1]) / 2, z);
    c.add(edges(cg, mH.furnEdge, 30));
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
    const mesh = new THREE.Mesh(geo, mR.wall);
    mesh.renderOrder = 4;
    lift.add(mesh, edges(geo, mR.edge, 20));
  }
  for (const [id, r] of Object.entries(model.roofs || {})) shedRoof(r.outline, roof.fns[id], r.thick);
  (model.roof_steps || []).forEach(s => {
    const low = model.roofs[s.bot];
    buildWall(lift, { a: s.a, b: s.b, t: 0.2, top: roof.under(s.top), bot: x => roof.fns[s.bot](x) - roof.gap + low.thick }, mR);
  });

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
        m.material.color.copy(C.floor).lerp(C.warm, u.warm * 0.85).lerp(C.hover, u.hover * 0.6).lerp(C.sel, u.sel * 0.7);
      });
      return moving;
    }
  };
}
