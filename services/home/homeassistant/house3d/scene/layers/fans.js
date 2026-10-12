// Camera view fans: a faint 60 degree wedge on the ground from each marker with a look
// direction, rebuilt when those markers change.
const D2R = Math.PI / 180;

export default function build({ THREE, kit, C }) {
  const group = new THREE.Group();
  let key = '', count = 0, fill = null, line = null;
  function markers(list) {
    const withLook = list.filter(m => m.look);
    const k = JSON.stringify(withLook.map(m => [m.pos, m.look]));
    if (k === key) return;
    key = k;
    count = withLook.length;
    group.children.slice().forEach(o => { group.remove(o); o.geometry.dispose(); });
    fill = fill || kit.basic({ color: C.line, opacity: 0.04, side: THREE.DoubleSide });
    line = line || kit.lineMat({ color: C.line, opacity: 0.25 });
    withLook.forEach(m => {
      const ang = Math.atan2(m.look[1], m.look[0]), half = 30 * D2R, R = 7;
      const pts = [new THREE.Vector2(0, 0)];
      for (let i = 0; i <= 12; i++) {
        const t = ang - half + (2 * half * i) / 12;
        pts.push(new THREE.Vector2(Math.cos(t) * R, Math.sin(t) * R));
      }
      const geo = new THREE.ShapeGeometry(new THREE.Shape(pts));
      geo.rotateX(Math.PI / 2);
      const fan = new THREE.Mesh(geo, fill);
      fan.position.set(m.pos[0], 0.04, m.pos[2]);
      const e = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map(p => new THREE.Vector3(p.x, 0, p.y))), line);
      e.position.copy(fan.position);
      group.add(fan, e);
    });
  }
  return { id: 'fans', group, markers, listed: () => count > 0 };
}
