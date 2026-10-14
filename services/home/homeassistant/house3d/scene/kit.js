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
// drawings' specification (A-101/A-102, AR-5): the cladding is grey-glazed diagonal boarding
// (its boards come from boards()), roofs and flashing a mid grey standing seam, and every frame,
// door, trim, corner board, roof edge, the wall's base strip, the carport's panels and the
// pergola one anthracite, about RAL 7016 (the drawings' RR25 yellow frames were not built).
// Inside, the walls are light grey, the living floors oak and the wet rooms a dark wood-look
// tile. The deck is dark composite, the paving light grey-beige concrete pavers with sandy
// joints (their stones come from pavers()), the entrance step dark grey, the outdoor units white.
// The bar fence and the gates are black bars (bars()), the other fences a dark wire mesh
// (wireMesh()). The play area is stained timber with a sand box, a mint slide and a dark nest
// seat; the trampoline a green edge pad on a black mat with a black net.
// The car and surroundings are plain stand-ins; outside is the neutral ground beyond the lot.
const REAL = {
  cladding: '#bebeb8', roof: '#7b8083', frame: '#383e42', unit: '#e4e4e0',
  glass: '#9fb8c4', interior: '#dddcd8', floor: '#c39566', tile: '#5e4a3c', deck: '#4d4540', paving: '#b8b1a3',
  lawn: '#5f7f45', outside: '#8e9088', hedge: '#355a32', crown: '#4f7a3a', trunk: '#5b4636',
  fence: '#4a4d50', car: '#2f3336', neighbour: '#b9b6ae', road: '#6b6b68',
  timber: '#8a6a4c', sand: '#d6c6a0', slide: '#9ed8c2', nest: '#3d4a5c', pad: '#3f8a4b', mat: '#202325',
  net: '#151719', mesh: '#2c2f31', stone: '#56595b'
};
// the cladding's boards: about 12 cm wide, rising to the right at 45 degrees, only their grooves
// drawn, on a 2 m tile of the walls' metre UVs
const BOARD_TILE = 2, BOARDS = 12, BOARD_PX = 512, GROOVE = 0.045;
const GLASS_OPACITY = 0.35;
// the paving's stones: running-bond rows ROW deep of stones STONE long, the long joints waving
// WAVE either way, on a PAVER_TILE m tile that holds whole rows and stones
const PAVER_TILE = 0.9, STONE = 0.225, ROW = 0.1125, WAVE = 0.012, JOINT = 0.005, PAVER_PX = 512;
// the mesh fence: vertical wires every 5 cm, horizontal ones every 20 cm, 4 mm thick, on a 0.2 m
// tile; a faint veil between them so the mipmapped fence still reads from far off
const MESH_TILE = 0.2, MESH_X = 0.05, WIRE = 0.004, MESH_PX = 256, MESH_VEIL = 26;
const BAR_STEP = 0.12, BAR = 0.02, RAIL = 0.04;

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

  // real style: [front, back], the board texture as seen on a wall's local +z face and its
  // mirror for the -z face, so the boards rise to the right on both; one pair per mount. A
  // DataTexture, not a canvas: the engine tests run without a DOM
  let boardPair;
  function boards() {
    if (boardPair) return boardPair;
    const S = BOARD_PX;
    // i - j counts across the boards and wraps with the tile; one shade, a thin groove between
    const front = tileTexture(S, BOARD_TILE, (i, j) => {
      const t = ((i - j + S) * BOARDS) / S, v = (t - Math.floor(t) < GROOVE ? 0.72 : 1) * 255;
      return [v, v, v, 255];
    });
    const back = keep(front.clone());
    back.repeat.x = -1 / BOARD_TILE;
    back.needsUpdate = true;
    return (boardPair = [front, back]);
  }

  // a repeating DataTexture of S x S pixels filled by px(i, j) -> [r, g, b, a], on a tile metres
  // wide of metre UVs
  function tileTexture(S, tile, px) {
    const data = new Uint8Array(S * S * 4);
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) data.set(px(i, j), (j * S + i) * 4);
    const tex = keep(new THREE.DataTexture(data, S, S));
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.anisotropy = 8;
    tex.repeat.set(1 / tile, 1 / tile);
    tex.needsUpdate = true;
    return tex;
  }

  // real style: the paving's stones, one texture per mount
  let paverTex;
  function pavers() {
    if (paverTex) return paverTex;
    const S = PAVER_PX, m = PAVER_TILE / S, rows = Math.round(PAVER_TILE / ROW), cols = Math.round(PAVER_TILE / STONE);
    const inJoint = (t, step) => Math.min(t % step, step - (t % step)) < JOINT / 2;
    paverTex = tileTexture(S, PAVER_TILE, (i, j) => {
      const u = i * m, v = j * m;
      // the wave runs ROW long along u, so the tile's edges meet
      const rv = (v + WAVE * Math.sin((2 * Math.PI * u) / ROW) + PAVER_TILE) % PAVER_TILE, r = Math.floor(rv / ROW);
      const ou = (u + (r % 2) * (STONE / 2)) % PAVER_TILE, c = Math.floor(ou / STONE) % cols;
      if (inJoint(rv, ROW) || inJoint(ou, STONE)) return [255, 255, 255, 255];
      // a stone's shade from its row and column, the same on every tile
      const h = Math.sin((r % rows) * 12.9898 + c * 78.233) * 43758.5453, k = 0.88 * (1 + 0.08 * (h - Math.floor(h) - 0.5));
      const g = Math.round(k * 255);
      return [g, g, g, 255];
    });
    return paverTex;
  }

  // real style: the mesh fence's wires, white where a wire is, alpha MESH_VEIL between
  let meshTex;
  function wireMesh() {
    if (meshTex) return meshTex;
    const S = MESH_PX, m = MESH_TILE / S;
    const on = (t, step) => Math.min(t % step, step - (t % step)) < WIRE / 2;
    meshTex = tileTexture(S, MESH_TILE, (i, j) => [255, 255, 255, on((i + 0.5) * m, MESH_X) || on((j + 0.5) * m, MESH_TILE) ? 255 : MESH_VEIL]);
    return meshTex;
  }

  // real style: a bar fence span or gate leaf len long and h high along local +x, from the
  // ground up: two rails and a bar every BAR_STEP, ends included; casts, takes no shadow
  function bars(len, h, mat) {
    const g = new THREE.Group();
    [0.05, h].forEach(y => {
      const r = new THREE.Mesh(new THREE.BoxGeometry(len, RAIL, RAIL), mat);
      r.position.set(len / 2, y, 0);
      g.add(r);
    });
    const n = Math.max(1, Math.round(len / BAR_STEP)), im = new THREE.InstancedMesh(new THREE.BoxGeometry(BAR, h - 0.05, BAR), mat, n + 1);
    const at = new THREE.Matrix4();
    for (let i = 0; i <= n; i++) im.setMatrixAt(i, at.makeTranslation((len * i) / n, (0.05 + h) / 2, 0));
    im.instanceMatrix.needsUpdate = true;
    im.computeBoundingSphere();
    g.add(im);
    g.children.forEach(o => { o.castShadow = true; o.receiveShadow = false; });
    return g;
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

  return { C, style, REAL, disposables, keep, basic, lineMat, mats, edges, box, prism, canvasTexture, applyFade, near, surface, solid, flatShape, boards, pavers, wireMesh, bars };
}
