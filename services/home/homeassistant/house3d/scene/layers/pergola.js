// The pergola: wall beam on the rect's north edge, posts on the south edge. The louvres keep a
// fixed angle because the pergola reports no position. Its LED glows with the marker whose role
// is 'pergola-light'.
export default function build({ THREE, kit, C, model }) {
  const p = (model.site || {}).pergola;
  if (!p) return null;
  const { basic, lineMat, box, edges, near } = kit;
  const group = new THREE.Group();
  const frameM = basic({ color: C.wall, opacity: 0.35 });
  const frameE = lineMat({ color: C.line, opacity: 0.75 });
  const ledMat = lineMat({ color: C.amber, opacity: 0 });
  const glowSprites = [];
  const [x0, z0, x1, z1] = p.rect, Hp = p.height, n = p.modules || 1;
  const W = (x1 - x0) / n, D = z1 - z0;
  const slatM = basic({ color: C.wall, opacity: 0.3, side: THREE.DoubleSide });
  const slatE = lineMat({ color: C.lineSoft, opacity: 0.6 });
  const posts = Array.from({ length: n + 1 }, (_, i) => x0 + i * W);
  posts.forEach(x => box(group, frameM, frameE, [x - 0.08, z1 - 0.16, x + 0.08, z1], [0, Hp]));
  box(group, frameM, frameE, [x0 - 0.08, z1 - 0.16, x1 + 0.08, z1], [Hp - 0.22, Hp]);
  box(group, frameM, frameE, [x0 - 0.08, z0, x1 + 0.08, z0 + 0.12], [Hp - 0.22, Hp]);
  posts.forEach(x => box(group, frameM, frameE, [x - 0.08, z0, x + 0.08, z1], [Hp - 0.22, Hp]));
  const slats = Math.floor((D - 0.35) / 0.2) + 1;
  const glowTex = kit.canvasTexture(128, [[0, 'rgba(255,214,150,1)'], [0.25, 'rgba(255,190,110,0.5)'], [1, 'rgba(255,170,80,0)']]);
  for (let u = 0; u < n; u++) {
    for (let i = 0; i < slats; i++) {
      const geo = new THREE.BoxGeometry(W - 0.18, 0.025, 0.19);
      const s = new THREE.Mesh(geo, slatM);
      s.position.set(x0 + u * W + W / 2, Hp - 0.1, z0 + 0.25 + i * 0.2);
      s.rotation.x = 0.6;
      s.add(edges(geo, slatE));
      group.add(s);
    }
    const lx0 = x0 + u * W + 0.12, lx1 = x0 + (u + 1) * W - 0.12, y = Hp - 0.23, a = z0 + 0.18, b = z1 - 0.2;
    const pts = [[lx0, a], [lx1, a], [lx1, a], [lx1, b], [lx1, b], [lx0, b], [lx0, b], [lx0, a]].map(([x, z]) => new THREE.Vector3(x, y, z));
    group.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), ledMat));
    const sp = new THREE.Sprite(kit.keep(new THREE.SpriteMaterial({ map: glowTex, color: C.amber, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })));
    sp.position.set(x0 + (u + 0.5) * W, Hp - 0.25, (z0 + z1) / 2);
    sp.scale.set(3.6, 3.6, 1);
    group.add(sp);
    glowSprites.push(sp);
  }

  let light = 0;
  return {
    id: 'pergola',
    group,
    markers(list) {
      const led = list.find(m => m.role === 'pergola-light');
      light = led && led.state === 'on' ? (led.level ?? 1) : 0;
    },
    update(dt, k) {
      let moving = false;
      const led = light ? 0.35 + 0.65 * light : 0;
      if (!near(ledMat.opacity, led)) { ledMat.opacity += (led - ledMat.opacity) * k; moving = true; }
      const glow = light ? 0.25 + 0.4 * light : 0;
      glowSprites.forEach(sp => {
        if (!near(sp.material.opacity, glow)) { sp.material.opacity += (glow - sp.material.opacity) * k; moving = true; }
      });
      return moving;
    }
  };
}
