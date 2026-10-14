// The ground: a soft glow under the lot and the metre grid. The real style lays a lawn over the
// lot and a neutral plane round it, both taking shadows, and no grid.
export default function build({ THREE, kit, C, frame, model, style }) {
  const { ext, lotCx, lotCz } = frame;
  const group = new THREE.Group();
  if (style === 'real') {
    const lot = (model.site || {}).lot, [x0, z0, x1, z1] = frame.lotBox;
    const lawn = new THREE.Mesh(kit.flatShape(lot && lot.length >= 3 ? lot : [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]), kit.surface('lawn'));
    // under the floors and paving by enough not to flicker at a distance
    lawn.position.y = -0.02;
    const out = new THREE.Mesh(new THREE.PlaneGeometry(ext * 8, ext * 8).rotateX(-Math.PI / 2), kit.surface('outside'));
    out.position.set(lotCx, -0.1, lotCz);
    lawn.receiveShadow = out.receiveShadow = true;
    group.add(out, lawn);
    return { id: 'ground', group };
  }
  const tex = kit.canvasTexture(256, [[0, 'rgba(32,58,120,0.6)'], [0.45, 'rgba(16,30,68,0.4)'], [1, 'rgba(6,12,27,0)']]);
  const pl = new THREE.Mesh(new THREE.PlaneGeometry(ext * 2.7, ext * 2.7), kit.basic({ map: tex }));
  pl.rotation.x = -Math.PI / 2;
  pl.position.set(lotCx, -0.02, lotCz);
  group.add(pl);
  const n = Math.round(ext * 2);
  const grid = new THREE.GridHelper(n, n, C.gridMajor, C.gridMinor);
  grid.material.transparent = true;
  grid.material.opacity = 0.45;
  grid.position.set(Math.round(lotCx), -0.01, Math.round(lotCz));
  group.add(grid);
  return { id: 'ground', group };
}
