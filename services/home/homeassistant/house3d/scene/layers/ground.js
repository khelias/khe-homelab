// The ground: a soft glow under the lot and the metre grid.
export default function build({ THREE, kit, C, frame }) {
  const { ext, lotCx, lotCz } = frame;
  const group = new THREE.Group();
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
