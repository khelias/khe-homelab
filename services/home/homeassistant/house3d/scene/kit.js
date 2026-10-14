// The drawing kit of one mount: colours, materials, geometry helpers and the list of what
// dispose() frees. createKit() runs once per mount, so two mounts never share a material or a
// texture, and disposing one never frees the other's.
const COLORS = {
  bg: '#060c1b', line: '#6fe3ff', lineSoft: '#5d86d8', roof: '#9aa6ff', roofFill: '#252f6e', wall: '#1b2c5e',
  glass: '#5fd8ff', floor: '#0e1a3c', warm: '#6b4a1c', hover: '#24407f', sel: '#2b5aa0', amber: '#ffc56e',
  teal: '#47d9c4', hedge: '#123b45', furniture: '#7f9bff', gridMajor: '#2a4685', gridMinor: '#172a55',
  ink: '#e4ecff', alert: '#ff8b7b'
};

// The real style's surfaces, from photos of the house (2026-10-14) where they differ from the
// drawings' specification (A-101/A-102, AR-5): the cladding is the light grey glaze, roofs and
// flashing RR23, and every frame, door, trim, the wall's base strip, the carport's panels and
// the pergola one anthracite, about RAL 7016 (the drawings' RR25 yellow frames were not built).
// The deck is dark composite, the paving warm concrete pavers, the outdoor units white. The car
// and surroundings are plain stand-ins; outside is the neutral ground beyond the lot.
const REAL = {
  cladding: '#c9ccc8', roof: '#3e4245', frame: '#383e42', unit: '#e4e4e0',
  glass: '#9fb8c4', interior: '#eceae4', floor: '#cdb48e', deck: '#4d4540', paving: '#b3a38c',
  lawn: '#5f7f45', outside: '#8e9088', hedge: '#355a32', crown: '#4f7a3a', trunk: '#5b4636',
  fence: '#4a4d50', car: '#2f3336', neighbour: '#b9b6ae', road: '#6b6b68'
};
const GLASS_OPACITY = 0.35;

export function createKit(THREE, style = 'simple') {
  const C = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, new THREE.Color(v)]));
  const disposables = [];
  const keep = x => (disposables.push(x), x);
  // real style only: a new lit material on every call, so a floor tints alone and a fade on
  // one group never reaches another's surfaces; o overrides, e.g. { transparent: true } for
  // what fades (the lift, the car)
  const surface = style === 'real'
    ? (name, o = {}) => keep(new THREE.MeshStandardMaterial({
      color: new THREE.Color(REAL[name]), roughness: 0.85, metalness: 0,
      ...(name === 'glass' ? { transparent: true, opacity: GLASS_OPACITY, roughness: 0.15, side: THREE.DoubleSide } : {}), ...o
    }))
    : undefined;
  const basic = o => keep(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, ...o }));
  const lineMat = o => keep(new THREE.LineBasicMaterial({ transparent: true, ...o }));
  function mats(tint) {
    return {
      wall: basic({ color: C.wall, opacity: 0.13, side: THREE.DoubleSide }),
      edge: lineMat({ color: tint || C.line, opacity: 0.75 }),
      glass: basic({ color: C.glass, opacity: 0.06, side: THREE.DoubleSide }),
      glassEdge: lineMat({ color: C.glass, opacity: 0.6 }),
      furn: basic({ color: C.wall, opacity: 0.2 }),
      furnEdge: lineMat({ color: C.furniture, opacity: 0.45 })
    };
  }
  const edges = (geo, mat, thresh) => new THREE.LineSegments(new THREE.EdgesGeometry(geo, thresh || 15), mat);

  function box(group, mat, emat, [x0, z0, x1, z1], [y0, y1]) {
    const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.add(edges(geo, emat));
    group.add(mesh);
    return mesh;
  }

  // an upright prism on an outline [[x, z], ...], from y0 to y1
  function prism(pts, y0, y1) {
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, z))), { depth: y1 - y0, bevelEnabled: false });
    // shape y becomes world z, the extrusion runs down from y1
    geo.rotateX(Math.PI / 2);
    geo.translate(0, y1, 0);
    return geo;
  }

  function canvasTexture(size, stops) {
    const cv = document.createElement('canvas');
    cv.width = cv.height = size;
    const x = cv.getContext('2d');
    const gr = x.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    stops.forEach(([at, c]) => gr.addColorStop(at, c));
    x.fillStyle = gr;
    x.fillRect(0, 0, size, size);
    const tex = keep(new THREE.CanvasTexture(cv));
    tex.colorSpace = THREE.SRGBColorSpace;
    return tex;
  }

  // real style: box() without the outline
  function solid(group, mat, [x0, z0, x1, z1], [y0, y1]) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0), mat);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    group.add(mesh);
    return mesh;
  }

  // real style: a level outline [[x, z], ...] with holes at height 0, facing up (shape y is -z,
  // so the turn onto the ground keeps the face up)
  function flatShape(pts, holes = []) {
    const shape = new THREE.Shape(pts.map(([x, z]) => new THREE.Vector2(x, -z)));
    holes.forEach(h => shape.holes.push(new THREE.Path(h.map(([x, z]) => new THREE.Vector2(x, -z)))));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);
    return geo;
  }

  // scales every material's opacity under group from its first-seen value; sprites are left out
  function applyFade(group, f) {
    group.traverse(o => {
      if (!o.material || o.isSprite) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(mt => {
        if (mt.userData.base === undefined) mt.userData.base = mt.opacity;
        mt.opacity = mt.userData.base * f;
      });
    });
    group.visible = f > 0.01;
  }

  const near = (a, b) => Math.abs(a - b) < 0.002;

  return { C, style, REAL, disposables, keep, basic, lineMat, mats, edges, box, prism, canvasTexture, applyFade, near, surface, solid, flatShape };
}
