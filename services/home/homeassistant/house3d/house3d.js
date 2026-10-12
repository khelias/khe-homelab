// House 3D view engine: builds the scene from a house3d model (see scripts/house3d_model.py)
// and draws generic markers over it. The HA card and the standalone viewer are thin shells
// around mount(); neither the engine nor this directory carries any house data.
import * as THREE from './vendor/three-0.186.1/build/three.module.js';
import { OrbitControls } from './vendor/three-0.186.1/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from './vendor/three-0.186.1/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/OutputPass.js';

const D2R = Math.PI / 180;
const ROOF_GAP = 0.06; // walls stop just under the roof so the two outlines do not z-fight
const BLOOM_MIN_WIDTH = 720;

export const ICONS = {
  light: '<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.7.6 1.1 1.3 1.1 2.2h5c0-.9.4-1.6 1.1-2.2A6 6 0 0 0 12 3z"/>',
  climate: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M12 10v7"/>',
  sensor: '<path d="M14 14.8V5a2 2 0 1 0-4 0v9.8a4 4 0 1 0 4 0z"/><path d="M18 5h2M18 9h2"/>',
  camera: '<path d="M3 7.5h11.5v9H3z"/><path d="M14.5 10.5 21 7v10l-6.5-3.5"/>',
  motion: '<circle cx="13.5" cy="4.5" r="1.7"/><path d="m9 21 2.5-6 2.5 2.5V21M7 12.5l3-3.5 3.5.8 2.5 3.2M11.5 15l1.5-5.2"/>',
  smoke: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="2.2"/><path d="M12 3.5v2M12 18.5v2"/>',
  plug: '<path d="M9 2.5v4.5M15 2.5v4.5M6 7h12v3.5a6 6 0 0 1-12 0zM12 16.5v5"/>',
  door: '<path d="M6 21V3h12v18M3 21h18"/><circle cx="14.5" cy="12" r=".8" fill="currentColor"/>',
  cover: '<path d="M3 21V9.5L12 4l9 5.5V21"/><path d="M7 21v-8h10v8M7 15.5h10M7 18h10"/>',
  vent: '<circle cx="12" cy="12" r="1.6"/><path d="M12 10.4C12 6 13 3 15.8 3c3 0 3 4.2-2.4 7.6M13.6 12c4.4 0 7.4 1 7.4 3.8 0 3-4.2 3-7.6-2.4M12 13.6c0 4.4-1 7.4-3.8 7.4-3 0-3-4.2 2.4-7.6M10.4 12C6 12 3 11 3 8.2c0-3 4.2-3 7.6 2.4"/>',
  heatpump: '<rect x="3" y="5" width="18" height="14" rx="1.5"/><circle cx="9" cy="12" r="3.6"/><path d="M15.5 9h2.5M15.5 12h2.5M15.5 15h2.5"/>',
  alarm: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.3 7.5 9.5 4.3-1.2 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  room: '<path d="M4 4h16v16H4zM4 12h7v8M15 4v6"/>',
  reset: '<path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/>',
  tree: '<path d="M12 2.5a5 5 0 0 0-4.8 6.4A4.3 4.3 0 0 0 8.5 17.5h7a4.3 4.3 0 0 0 1.3-8.6A5 5 0 0 0 12 2.5z"/><path d="M12 21.5v-8M12 15.5l-2.5-2M12 14l2.2-1.8"/>',
  info: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5.5M12 7.5v.5"/>'
};
export const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.info}</svg>`;
export const roomArea = room => room.rects.reduce((a, q) => a + (q[2] - q[0]) * (q[3] - q[1]), 0);

const STYLE = `
.h3d { position: relative; width: 100%; height: 100%; overflow: hidden;
  --h3d-line: #6fe3ff; --h3d-ink: #e4ecff; --h3d-muted: #8a9bc2; --h3d-amber: #ffc56e; --h3d-alert: #ff8b7b;
  --h3d-mono: "IBM Plex Mono", ui-monospace, "SFMono-Regular", Menlo, monospace;
  background: radial-gradient(ellipse at 50% 55%, #0c1631 0%, #060c1b 70%) #060c1b; }
.h3d-stage { position: absolute; inset: 0; }
.h3d-stage canvas { display: block; width: 100%; height: 100%; touch-action: none; }
.h3d-overlay { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.h3d-marker { position: absolute; left: 0; top: 0; pointer-events: auto;
  display: flex; align-items: center; justify-content: center; gap: 5px;
  height: 32px; min-width: 32px; padding: 0 7px; box-sizing: border-box; border-radius: 16px;
  border: 1px solid rgba(111, 227, 255, 0.35); background: rgba(8, 16, 36, 0.88); color: var(--h3d-line);
  font: 500 12px/1 var(--h3d-mono); font-variant-numeric: tabular-nums; cursor: pointer;
  box-shadow: 0 0 14px rgba(111, 227, 255, 0.18);
  transition: background-color .2s, color .2s, box-shadow .2s, border-color .2s, opacity .2s; will-change: transform; }
.h3d-marker svg { width: 16px; height: 16px; flex: none; }
.h3d-marker.round { width: 32px; padding: 0; }
.h3d-marker.on { color: #1c1406; background: var(--h3d-amber); border-color: var(--h3d-amber); box-shadow: 0 0 22px rgba(255, 197, 110, 0.55); }
.h3d-marker.alert { color: #200806; background: var(--h3d-alert); border-color: var(--h3d-alert); box-shadow: 0 0 22px rgba(255, 139, 123, 0.6); }
.h3d-marker.off { filter: grayscale(1); border-style: dashed; box-shadow: none; }
.h3d-marker.sel { outline: 2px solid var(--h3d-ink); outline-offset: 2px; }
.h3d-marker.pulse::after { content: ""; position: absolute; inset: -6px; border-radius: 22px;
  border: 1px solid var(--h3d-amber); animation: h3d-ring 1.2s ease-out infinite; }
.h3d-marker.alert.pulse::after { border-color: var(--h3d-alert); }
.h3d-marker:focus-visible { outline: 2px solid var(--h3d-amber); outline-offset: 2px; }
@keyframes h3d-ring { from { opacity: .9; transform: scale(.85); } to { opacity: 0; transform: scale(1.35); } }
@media (hover: hover) and (pointer: fine) { .h3d-marker:hover { border-color: var(--h3d-ink); } }
@media (prefers-reduced-motion: reduce) { .h3d-marker.pulse::after { animation: none; opacity: .6; } }
.h3d-label { position: absolute; left: 0; top: 0; font: 500 10px/1 var(--h3d-mono); letter-spacing: 0.16em;
  text-transform: uppercase; color: var(--h3d-muted); white-space: nowrap; pointer-events: none; will-change: transform; }
.h3d.h3d-narrow .h3d-label { display: none !important; }
.h3d-fallback { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px;
  color: var(--h3d-muted); text-align: center; font: 14px/1.45 system-ui, sans-serif; }
`;

const COLORS = {
  bg: '#060c1b', line: '#6fe3ff', lineSoft: '#5d86d8', roof: '#9aa6ff', roofFill: '#252f6e', wall: '#1b2c5e',
  glass: '#5fd8ff', floor: '#0e1a3c', warm: '#6b4a1c', hover: '#24407f', sel: '#2b5aa0', amber: '#ffc56e',
  teal: '#47d9c4', hedge: '#123b45', furniture: '#7f9bff', gridMajor: '#2a4685', gridMinor: '#172a55',
  ink: '#e4ecff', alert: '#ff8b7b'
};

/**
 * mount(element, model, options) -> { setMarkers, setMode, setSelection, setCar, reset, resize, dispose,
 *                                     mode, carState, carScreen }
 *
 * model: geometry + rooms layers (private and showcase are ignored).
 * options:
 *   onMarker(id)     a marker was tapped
 *   onRoom(id|null)  a room floor was tapped with the roof off; null for empty space
 *   onMode(mode)     the mode changed ('roof' | 'open'), also after the reveal
 *   onCar()          the car's body was tapped (either mode, while it shows); no room tap follows
 *   bloom            default true; always off below 720 px width
 *   mode             the starting mode, 'roof' (default) or 'open'
 *   reveal           start with the roof on and lift it after load. With a car, the lift waits
 *                    for the first setCar (2.5 s at most) and, after an 'arrive', for it to park
 *   labels(roomId)   room label text; the room's own name when it returns nothing
 *   car              { profile, path }: a vehicle drawn from profile, built hidden. profile is in
 *                    metres in the car's frame (origin on the ground at its centre, +x forward,
 *                    y up): length, width, height, side and glass outlines [[x, y], ...],
 *                    wheels { r, x: [rear, front], track }, lights { front, rear } as lists of
 *                    [[x, y, z], [x, y, z]] segments. path is [[x, z], ...]; the car drives a
 *                    smooth curve through it and parks at the last point, facing along the last leg.
 * setCar('away' | 'parked' | 'arrive'): 'arrive' drives the whole path (3-6 s, restarts if it is
 *   already driving; 'parked' under reduced motion), 'parked' stands it at the path's end, 'away'
 *   fades it out. carState is 'away' | 'driving' | 'parked'; carScreen is the car's projected
 *   centre { x, y } in CSS pixels relative to the element, or null when it is away or behind.
 * markers: { id, pos: [x, y, z], icon, state: 'idle'|'on'|'alert'|'off', value?, label?,
 *            room?, look?: [dx, dz], role?, level?: 0..1, pulse?, warm? }
 *   A marker whose room is a house room shows only with the roof off, unless its state is
 *   'alert'; state 'on' warms that room's floor unless warm is false. role 'pergola-light' drives the pergola's LED glow.
 */
export function mount(element, model, options = {}) {
  const root = document.createElement('div');
  root.className = 'h3d';
  const style = document.createElement('style');
  style.textContent = STYLE;
  const stage = document.createElement('div');
  stage.className = 'h3d-stage';
  const overlay = document.createElement('div');
  overlay.className = 'h3d-overlay';
  root.append(style, stage, overlay);
  element.appendChild(root);

  const mq = q => (typeof matchMedia === 'function' ? matchMedia(q).matches : false);
  const reduceMotion = mq('(prefers-reduced-motion: reduce)');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  } catch (e) {
    const msg = document.createElement('div');
    msg.className = 'h3d-fallback';
    msg.textContent = 'See seade ei toeta WebGL-i, mistõttu 3D-vaadet ei saa näidata.';
    stage.appendChild(msg);
    const noop = () => {};
    return { failed: true, setMarkers: noop, setMode: noop, setSelection: noop, setCar: noop, reset: noop, resize: noop,
      dispose: () => root.remove(), mode: 'roof', carState: 'away', carScreen: null };
  }
  const PR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(PR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  const C = Object.fromEntries(Object.entries(COLORS).map(([k, v]) => [k, new THREE.Color(v)]));
  const scene = new THREE.Scene();
  scene.background = C.bg;
  scene.fog = new THREE.Fog(C.bg, 34, 78);

  /* ---------- model ---------- */
  const ceiling = model.ceiling;
  const rooms = model.rooms || [];
  const roomById = Object.fromEntries(rooms.map(r => [r.id, r]));
  const site = model.site || {};
  const roofFns = {};
  for (const [id, r] of Object.entries(model.roofs || {})) {
    const slope = r.slope ?? Math.tan(r.pitch_deg * D2R);
    const sign = r.falls === 'west' ? -1 : 1;
    roofFns[id] = x => r.high_y - sign * (x - r.high_x) * slope;
  }
  const flat = h => () => h;
  const under = id => x => roofFns[id](x) - ROOF_GAP;
  const topFn = top => (typeof top === 'string' ? under(top) : flat(top));

  // framing follows the lot, the buildings set the orbit target
  const bbox = pts => pts.reduce((b, [x, z]) => [Math.min(b[0], x), Math.min(b[1], z), Math.max(b[2], x), Math.max(b[3], z)], [Infinity, Infinity, -Infinity, -Infinity]);
  const lotBox = bbox(site.lot && site.lot.length ? site.lot : (model.walls || []).flatMap(w => [w.a, w.b]));
  const wallBox = bbox((model.walls || []).flatMap(w => [w.a, w.b]));
  const lotCx = (lotBox[0] + lotBox[2]) / 2, lotCz = (lotBox[1] + lotBox[3]) / 2;
  const ext = Math.max(lotBox[2] - lotBox[0], lotBox[3] - lotBox[1]);
  const E = ext / 41; // the prototype's framing was tuned on a 41 m lot
  // the model's z runs away from the street, so the home view looks in from -z, the street side,
  // 25 degrees round to the west, low like a passer-by (40 degrees up on a portrait screen, where a
  // lower view crops the house's sides); the target leans towards the street to centre the house
  const viewDir = (azDeg, elDeg) => {
    const az = azDeg * D2R, el = elDeg * D2R;
    return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el));
  };
  const HOME_DIR = viewDir(25, 27);
  const PORTRAIT_DIR = viewDir(25, 40);
  const HOME_TARGET = new THREE.Vector3((wallBox[0] + wallBox[2]) / 2, 0.3, (wallBox[1] + wallBox[3]) / 2 - 0.07 * ext);

  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 300 * E);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 8 * E;
  controls.maxDistance = 130 * E;
  controls.maxPolarAngle = 1.38;
  controls.screenSpacePanning = false;

  /* ---------- materials ---------- */
  const disposables = [];
  const keep = x => (disposables.push(x), x);
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

  function buildWall(group, w, m) {
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
    group.add(g);
  }

  function box(group, mat, emat, [x0, z0, x1, z1], [y0, y1]) {
    const geo = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
    mesh.add(edges(geo, emat));
    group.add(mesh);
    return mesh;
  }

  /* ---------- build ---------- */
  const siteG = new THREE.Group();
  const house = new THREE.Group();
  const roof = new THREE.Group();
  const fans = new THREE.Group();
  scene.add(siteG, house, roof, fans);
  const mH = mats(), mR = mats(C.roof);
  mR.wall.opacity = 0.28;
  mR.wall.color = C.roofFill;

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

  {
    const tex = canvasTexture(256, [[0, 'rgba(32,58,120,0.6)'], [0.45, 'rgba(16,30,68,0.4)'], [1, 'rgba(6,12,27,0)']]);
    const pl = new THREE.Mesh(new THREE.PlaneGeometry(ext * 2.7, ext * 2.7), basic({ map: tex }));
    pl.rotation.x = -Math.PI / 2;
    pl.position.set(lotCx, -0.02, lotCz);
    siteG.add(pl);
    const n = Math.round(ext * 2);
    const grid = new THREE.GridHelper(n, n, C.gridMajor, C.gridMinor);
    grid.material.transparent = true;
    grid.material.opacity = 0.45;
    grid.position.set(Math.round(lotCx), -0.01, Math.round(lotCz));
    siteG.add(grid);
  }

  {
    const deckM = basic({ color: C.teal, opacity: 0.04 });
    const deckE = lineMat({ color: C.teal, opacity: 0.45 });
    const plankM = lineMat({ color: C.teal, opacity: 0.09 });
    const pathM = basic({ color: C.lineSoft, opacity: 0.05 });
    const pathE = lineMat({ color: C.lineSoft, opacity: 0.45 });
    (site.decks || []).forEach(r => {
      box(siteG, deckM, deckE, r, [0, 0.12]);
      const [x0, z0, x1, z1] = r, pts = [];
      for (let z = z0 + 0.4; z < z1; z += 0.4) pts.push(new THREE.Vector3(x0, 0.125, z), new THREE.Vector3(x1, 0.125, z));
      siteG.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), plankM));
    });
    (site.paving || []).forEach(r => box(siteG, pathM, pathE, r, [0, 0.02]));
    if (site.porch) box(siteG, pathM, pathE, site.porch, [0, 0.03]);
    if (site.sandpit) box(siteG, pathM, pathE, site.sandpit.rect, [0, site.sandpit.height]);
    if (site.swing) {
      const [x0, z0, x1, z1] = site.swing.rect, h = site.swing.height;
      [z0, z1].forEach(z => box(siteG, pathM, pathE, [x0, z - 0.05, x1, z + 0.05], [0, h]));
      box(siteG, pathM, pathE, [x0, z0, x1, z1], [h - 0.1, h]);
    }
    if (site.lot) {
      const lotLine = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(site.lot.map(([x, z]) => new THREE.Vector3(x, 0.03, z))),
        keep(new THREE.LineDashedMaterial({ color: C.roof, transparent: true, opacity: 0.6, dashSize: 0.6, gapSize: 0.4 })));
      lotLine.computeLineDistances();
      siteG.add(lotLine);
    }
    const hedgeM = basic({ color: C.hedge, opacity: 0.2 });
    const hedgeE = lineMat({ color: C.teal, opacity: 0.28 });
    (site.hedges || []).forEach(([[xa, za], [xb, zb]]) => {
      const geo = new THREE.BoxGeometry(Math.hypot(xb - xa, zb - za), 1.6, 0.8);
      const m = new THREE.Mesh(geo, hedgeM);
      m.position.set((xa + xb) / 2, 0.8, (za + zb) / 2);
      m.rotation.y = -Math.atan2(zb - za, xb - xa);
      m.add(edges(geo, hedgeE));
      siteG.add(m);
    });
    const trunkE = lineMat({ color: C.lineSoft, opacity: 0.5 });
    const TRUNK = { apple: 0.3, birch: 0.4, maple: 0.3 };
    // the size goes on scale, the outline comes from the unscaled shape: its 18-22.5 degree edges
    // all clear EdgesGeometry's 15 degree cut, a geometry squashed to a birch's shape loses some
    const crownGeo = new THREE.IcosahedronGeometry(1, 1), crownEdges = new THREE.EdgesGeometry(crownGeo, 15);
    (site.trees || []).forEach(({ kind, pos: [x, z], height, crown }) => {
      const top = height * (TRUNK[kind] || 0.3), w = Math.min(Math.max(height * 0.025, 0.1), 0.35);
      box(siteG, hedgeM, trunkE, [x - w / 2, z - w / 2, x + w / 2, z + w / 2], [0, top]);
      const m = new THREE.Mesh(crownGeo, hedgeM);
      m.position.set(x, (top + height) / 2, z);
      m.scale.set(crown / 2, (height - top) / 2, crown / 2);
      m.add(new THREE.LineSegments(crownEdges, hedgeE));
      siteG.add(m);
    });
    const fenceE = lineMat({ color: C.lineSoft, opacity: 0.38 });
    (site.fences || []).forEach(([[xa, za], [xb, zb]]) => {
      const n = Math.max(1, Math.round(Math.hypot(xb - xa, zb - za) / 2.5)), pts = [];
      [0.05, 1.2].forEach(y => pts.push(new THREE.Vector3(xa, y, za), new THREE.Vector3(xb, y, zb)));
      for (let i = 0; i <= n; i++) {
        const x = xa + ((xb - xa) * i) / n, z = za + ((zb - za) * i) / n;
        pts.push(new THREE.Vector3(x, 0, z), new THREE.Vector3(x, 1.2, z));
      }
      siteG.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), fenceE));
    });
  }
  const frameM = basic({ color: C.wall, opacity: 0.35 });
  const frameE = lineMat({ color: C.line, opacity: 0.75 });
  (site.outdoor_units || []).forEach(u => box(siteG, frameM, frameE, u.rect, u.y));
  if (site.garage_roof) box(roof, mR.wall, mR.edge, site.garage_roof.rect, site.garage_roof.y);

  // pergola: wall beam on the rect's north edge, posts on the south edge. The louvres keep a
  // fixed angle because the pergola reports no position.
  const ledMat = lineMat({ color: C.amber, opacity: 0 });
  const glowSprites = [];
  if (site.pergola) {
    const [x0, z0, x1, z1] = site.pergola.rect, Hp = site.pergola.height, n = site.pergola.modules || 1;
    const W = (x1 - x0) / n, D = z1 - z0;
    const slatM = basic({ color: C.wall, opacity: 0.3, side: THREE.DoubleSide });
    const slatE = lineMat({ color: C.lineSoft, opacity: 0.6 });
    const posts = Array.from({ length: n + 1 }, (_, i) => x0 + i * W);
    posts.forEach(x => box(siteG, frameM, frameE, [x - 0.08, z1 - 0.16, x + 0.08, z1], [0, Hp]));
    box(siteG, frameM, frameE, [x0 - 0.08, z1 - 0.16, x1 + 0.08, z1], [Hp - 0.22, Hp]);
    box(siteG, frameM, frameE, [x0 - 0.08, z0, x1 + 0.08, z0 + 0.12], [Hp - 0.22, Hp]);
    posts.forEach(x => box(siteG, frameM, frameE, [x - 0.08, z0, x + 0.08, z1], [Hp - 0.22, Hp]));
    const slats = Math.floor((D - 0.35) / 0.2) + 1;
    const glowTex = canvasTexture(128, [[0, 'rgba(255,214,150,1)'], [0.25, 'rgba(255,190,110,0.5)'], [1, 'rgba(255,170,80,0)']]);
    for (let u = 0; u < n; u++) {
      for (let i = 0; i < slats; i++) {
        const geo = new THREE.BoxGeometry(W - 0.18, 0.025, 0.19);
        const s = new THREE.Mesh(geo, slatM);
        s.position.set(x0 + u * W + W / 2, Hp - 0.1, z0 + 0.25 + i * 0.2);
        s.rotation.x = 0.6;
        s.add(edges(geo, slatE));
        siteG.add(s);
      }
      const lx0 = x0 + u * W + 0.12, lx1 = x0 + (u + 1) * W - 0.12, y = Hp - 0.23, a = z0 + 0.18, b = z1 - 0.2;
      const pts = [[lx0, a], [lx1, a], [lx1, a], [lx1, b], [lx1, b], [lx0, b], [lx0, b], [lx0, a]].map(([x, z]) => new THREE.Vector3(x, y, z));
      siteG.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), ledMat));
      const sp = new THREE.Sprite(keep(new THREE.SpriteMaterial({ map: glowTex, color: C.amber, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending })));
      sp.position.set(x0 + (u + 0.5) * W, Hp - 0.25, (z0 + z1) / 2);
      sp.scale.set(3.6, 3.6, 1);
      siteG.add(sp);
      glowSprites.push(sp);
    }
  }

  // walls that run up to a roof are cut at the ceiling: the part above lifts off with the roof
  (model.walls || []).forEach(w => {
    const base = { ...w, top: topFn(w.top) };
    const cut = w.cut ?? (typeof w.top === 'string' ? ceiling : 0);
    if (!cut) return buildWall(house, base, mH);
    buildWall(house, { ...base, top: flat(cut) }, mH);
    buildWall(roof, { ...base, openings: [], bot: flat(cut) }, mR);
  });

  // room floors, also the tap targets; a room can be several rectangles
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
      house.add(mesh);
      floorMeshes.push(mesh);
    });
  });

  (model.furniture || []).forEach(f => {
    if (f.rect) return box(house, mH.furn, mH.furnEdge, f.rect, f.y);
    const [x, z, r] = f.circle;
    const cg = new THREE.CylinderGeometry(r, r, f.y[1] - f.y[0], 18);
    const c = new THREE.Mesh(cg, mH.furn);
    c.position.set(x, (f.y[0] + f.y[1]) / 2, z);
    c.add(edges(cg, mH.furnEdge, 30));
    house.add(c);
  });

  function shedRoof(points, h, thick) {
    const shape = new THREE.Shape(points.map(([x, z]) => new THREE.Vector2(x, z)));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: thick, bevelEnabled: false });
    const p = geo.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getY(i), d = p.getZ(i);
      p.setXYZ(i, x, h(x) - ROOF_GAP + d, z);
    }
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mR.wall);
    mesh.renderOrder = 4;
    roof.add(mesh, edges(geo, mR.edge, 20));
  }
  for (const [id, r] of Object.entries(model.roofs || {})) shedRoof(r.outline, roofFns[id], r.thick);
  (model.roof_steps || []).forEach(s => {
    const low = model.roofs[s.bot];
    buildWall(roof, { a: s.a, b: s.b, t: 0.2, top: under(s.top), bot: x => roofFns[s.bot](x) - ROOF_GAP + low.thick }, mR);
  });

  // the car sits outside the roof group, so it shows in both modes, and has its own materials, so
  // fading it never fades the house
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
    scene.add(g);
    return { g, body, wheels, sprites, curve, length: curve.getLength(), r, centreY: p.height / 2 };
  }
  const carOpt = options.car;
  const car = carOpt && carOpt.profile && Array.isArray(carOpt.path) && carOpt.path.length >= 2 ? buildCar(carOpt.profile, carOpt.path) : null;
  let carState = 'away', drive = null, carFadeShown = -1;
  const carFade = { cur: 0, to: 0 };
  function placeCar(u) {
    const at = car.curve.getPointAt(u), tan = car.curve.getTangentAt(u);
    car.g.position.set(at.x, 0, at.z);
    car.g.rotation.y = Math.atan2(-tan.z, tan.x);
    const turn = -(u * car.length) / car.r;
    car.wheels.forEach(w => { w.rotation.z = turn; });
  }

  /* ---------- post-processing, created on first use ---------- */
  let composer = null;
  function getComposer() {
    if (composer) return composer;
    const rt = new THREE.WebGLRenderTarget(2, 2, { samples: 4, type: THREE.HalfFloatType });
    composer = new EffectComposer(renderer, rt);
    composer.setPixelRatio(PR);
    composer.addPass(new RenderPass(scene, camera));
    composer.addPass(new UnrealBloomPass(new THREE.Vector2(2, 2), 0.45, 0.4, 0.4));
    composer.addPass(new OutputPass());
    composer.setSize(width, height);
    return composer;
  }
  const bloomOn = () => options.bloom !== false && width >= BLOOM_MIN_WIDTH;

  /* ---------- labels and markers ---------- */
  const labels = rooms.map(r => {
    const el = document.createElement('div');
    el.className = 'h3d-label';
    el.textContent = (options.labels && options.labels(r.id)) || r.name;
    overlay.appendChild(el);
    const [x0, z0, x1, z1] = r.rects[0];
    const [lx, lz] = r.label || [(x0 + x1) / 2, (z0 + z1) / 2];
    return { el, pos: new THREE.Vector3(lx, 0.05, lz) };
  });

  const markers = new Map(); // id -> { data, el }
  let sel = null;
  let fanKey = '';
  const isIndoor = m => !!(m.room && roomById[m.room]);

  function markerClass(m) {
    const c = ['h3d-marker'];
    if (m.value === undefined || m.value === null || m.value === '') c.push('round');
    if (m.state === 'on' || m.state === 'alert' || m.state === 'off') c.push(m.state);
    if (m.pulse) c.push('pulse');
    if (sel === m.id) c.push('sel');
    return c.join(' ');
  }
  function renderMarker(rec) {
    const m = rec.data;
    rec.el.className = markerClass(m);
    const html = icon(m.icon) + (m.value !== undefined && m.value !== null && m.value !== '' ? `<span>${String(m.value).replace(/[&<>"]/g, ch => `&#${ch.charCodeAt(0)};`)}</span>` : '');
    if (rec.html !== html) { rec.el.innerHTML = html; rec.html = html; }
    const label = m.label || m.id;
    rec.el.setAttribute('aria-label', label);
    rec.el.title = label;
  }

  function rebuildFans(list) {
    const withLook = list.filter(m => m.look);
    const key = JSON.stringify(withLook.map(m => [m.pos, m.look]));
    if (key === fanKey) return;
    fanKey = key;
    fans.children.slice().forEach(o => { fans.remove(o); o.geometry.dispose(); });
    const fill = fans.userData.fill || (fans.userData.fill = basic({ color: C.line, opacity: 0.04, side: THREE.DoubleSide }));
    const line = fans.userData.line || (fans.userData.line = lineMat({ color: C.line, opacity: 0.25 }));
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
      fans.add(fan, e);
    });
  }

  let warmRooms = new Set();
  let pergolaLight = 0;
  function setMarkers(list) {
    const seen = new Set();
    list.forEach(m => {
      seen.add(m.id);
      let rec = markers.get(m.id);
      if (!rec) {
        const el = document.createElement('button');
        el.type = 'button';
        el.addEventListener('click', ev => { ev.stopPropagation(); if (options.onMarker) options.onMarker(m.id); });
        overlay.appendChild(el);
        rec = { el, html: '' };
        markers.set(m.id, rec);
      }
      rec.data = m;
      renderMarker(rec);
    });
    for (const [id, rec] of markers) if (!seen.has(id)) { rec.el.remove(); markers.delete(id); }
    warmRooms = new Set(list.filter(m => m.state === 'on' && m.warm !== false && isIndoor(m)).map(m => m.room));
    const led = list.find(m => m.role === 'pergola-light');
    pergolaLight = led && led.state === 'on' ? (led.level ?? 1) : 0;
    rebuildFans(list);
    invalidate();
  }

  /* ---------- modes and selection ---------- */
  let mode = 'roof';
  const fade = { cur: 1, to: 1 };
  function setMode(m, instant) {
    mode = m === 'open' ? 'open' : 'roof';
    fade.to = mode === 'roof' ? 1 : 0;
    if (instant || reduceMotion) fade.cur = fade.to;
    invalidate();
    if (options.onMode) options.onMode(mode);
  }
  function setSelection(id) {
    sel = id || null;
    markers.forEach(renderMarker);
    invalidate();
  }
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

  /* ---------- picking ---------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let hovered = null, downAt = null;
  function aim(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  // both tests read the ray that aim() set
  function pick() {
    if (mode !== 'open') return null;
    const hits = ray.intersectObjects(floorMeshes, false);
    return hits.length ? hits[0].object : null;
  }
  // the body mesh, not a bounding box, which would cover the carport floor
  function carHit() {
    if (!car || carState === 'away' || !car.g.visible) return false;
    return ray.intersectObject(car.body, false).length > 0;
  }
  const onMove = ev => {
    if (ev.pointerType !== 'mouse') return;
    aim(ev);
    const overCar = carHit();
    const h = overCar ? null : pick();
    if (h !== hovered) { hovered = h; invalidate(); }
    renderer.domElement.style.cursor = overCar || h ? 'pointer' : '';
  };
  const onDown = ev => { downAt = [ev.clientX, ev.clientY]; };
  const onUp = ev => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
    aim(ev);
    if (carHit()) { if (options.onCar) options.onCar(); return; }
    const h = pick();
    if (options.onRoom) options.onRoom(h ? h.userData.room : null);
  };
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerdown', onDown);
  renderer.domElement.addEventListener('pointerup', onUp);
  controls.addEventListener('change', () => invalidate());
  controls.addEventListener('start', () => invalidate());

  /* ---------- framing and size ---------- */
  let width = 1, height = 1, framed = false;
  function homeDistance() {
    const a = camera.aspect;
    return (a >= 1 ? Math.max(46, 58 / a) : 42 / Math.pow(a, 1.05)) * E;
  }
  function reset() {
    controls.target.copy(HOME_TARGET);
    scene.fog.near = homeDistance() * 0.95;
    scene.fog.far = homeDistance() * 2.2;
    camera.position.copy(HOME_TARGET).addScaledVector(camera.aspect < 1 ? PORTRAIT_DIR : HOME_DIR, homeDistance());
    controls.update();
    invalidate();
  }
  function resize() {
    const w = Math.max(1, root.clientWidth), h = Math.max(1, root.clientHeight);
    if (w === width && h === height) return;
    width = w; height = h;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h, false);
    if (composer) composer.setSize(w, h);
    root.classList.toggle('h3d-narrow', w < BLOOM_MIN_WIDTH);
    // frame once, at the first real size: a later hide and show keeps the user's orbit
    if (!framed && w > 1 && h > 1) { framed = true; reset(); }
    invalidate();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => resize()) : null;
  if (ro) ro.observe(root);
  let visible = true;
  const io = typeof IntersectionObserver === 'function' ? new IntersectionObserver(es => { visible = es[es.length - 1].isIntersecting; invalidate(); }) : null;
  if (io) io.observe(root);

  /* ---------- loop: runs only while something moves, a change restarts it ---------- */
  let dirty = true, raf = 0, last = 0, disposed = false;
  const v = new THREE.Vector3();
  const near = (a, b) => Math.abs(a - b) < 0.002;
  function invalidate() {
    dirty = true;
    if (!raf && !disposed && visible) { last = performance.now(); raf = requestAnimationFrame(frame); }
  }
  // raf keeps this callback's id while it runs, so an invalidate() from inside it (controls.update
  // fires 'change') cannot schedule a second chain; it is cleared only where the loop stops
  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (!visible) { raf = 0; return; }
    const k = reduceMotion ? 1 : 1 - Math.exp(-dt * 4.2);
    let moving = controls.update();
    if (!near(fade.cur, fade.to)) { fade.cur += (fade.to - fade.cur) * k; moving = true; } else fade.cur = fade.to;
    roof.position.y = (1 - fade.cur) * 4.5;
    applyFade(roof, Math.max(0, fade.cur * 1.25 - 0.25));

    floorMeshes.forEach(m => {
      const u = m.userData;
      const goals = [warmRooms.has(u.room) ? 0.75 : 0, hovered === m ? 1 : 0, sel === u.room ? 1 : 0];
      ['warm', 'hover', 'sel'].forEach((key, i) => {
        if (near(u[key], goals[i])) u[key] = goals[i];
        else { u[key] += (goals[i] - u[key]) * k; moving = true; }
      });
      m.material.color.copy(C.floor).lerp(C.warm, u.warm * 0.85).lerp(C.hover, u.hover * 0.6).lerp(C.sel, u.sel * 0.7);
    });
    const led = pergolaLight ? 0.35 + 0.65 * pergolaLight : 0;
    if (!near(ledMat.opacity, led)) { ledMat.opacity += (led - ledMat.opacity) * k; moving = true; }
    const glow = pergolaLight ? 0.25 + 0.4 * pergolaLight : 0;
    glowSprites.forEach(sp => {
      if (!near(sp.material.opacity, glow)) { sp.material.opacity += (glow - sp.material.opacity) * k; moving = true; }
    });
    if (car) {
      if (drive) {
        // frame time, not the clock: a drive started while the page is hidden waits to be seen
        drive.elapsed += Math.max(0, dt);
        const t = Math.min(1, drive.elapsed / drive.dur);
        placeCar(1 - (1 - t) * (1 - t));
        moving = true;
        if (t >= 1) { drive = null; carState = 'parked'; carSettled(); }
      }
      if (!near(carFade.cur, carFade.to)) { carFade.cur += (carFade.to - carFade.cur) * k; moving = true; } else carFade.cur = carFade.to;
      if (carFade.cur !== carFadeShown) {
        carFadeShown = carFade.cur;
        applyFade(car.g, carFade.cur);
        car.sprites.forEach(sm => { sm.opacity = sm.userData.base * carFade.cur; });
      }
    }
    if (!moving && !dirty) { raf = 0; return; }
    dirty = false;
    raf = requestAnimationFrame(frame);

    const reveal = Math.max(0, 1 - fade.cur * 1.6);
    for (const rec of markers.values()) {
      // an alert indoors shows through the roof, so a closed view never hides it
      const m = rec.data, el = rec.el, covered = isIndoor(m) && m.state !== 'alert';
      v.set(m.pos[0], m.pos[1], m.pos[2]).project(camera);
      if ((covered && reveal <= 0.02) || v.z >= 1) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.opacity = (covered ? reveal : 1).toFixed(2);
      el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -50%)`;
    }
    labels.forEach(l => {
      if (reveal < 0.02) { l.el.style.display = 'none'; return; }
      v.copy(l.pos).project(camera);
      l.el.style.display = v.z < 1 ? '' : 'none';
      l.el.style.opacity = (reveal * 0.8).toFixed(2);
      l.el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -50%)`;
    });
    if (bloomOn()) getComposer().render();
    else renderer.render(scene, camera);
  }

  resize();
  // with a car, the reveal waits for its first state (2.5 s at most) and for a drive-in to park,
  // so the roof lifts once rather than during the drive
  const mountedAt = performance.now();
  let revealTimer = 0, revealWait = false, revealAfterPark = false;
  function revealIn(ms) {
    clearTimeout(revealTimer);
    revealTimer = setTimeout(() => { revealTimer = 0; revealWait = revealAfterPark = false; setMode('open'); }, reduceMotion ? 0 : Math.max(0, ms));
  }
  if (options.reveal) {
    setMode('roof', true);
    revealWait = !!car;
    revealIn(car ? 2500 : 1100);
  } else setMode(options.mode === 'open' ? 'open' : 'roof', true);
  // a mode chosen by the user before the reveal fires wins over it
  const userMode = (m, instant) => { clearTimeout(revealTimer); revealTimer = 0; revealWait = revealAfterPark = false; setMode(m, instant); };
  function carSettled() {
    if (revealAfterPark) { revealAfterPark = false; revealIn(0); }
  }

  function setCar(state) {
    if (!car) return;
    if (state === 'arrive' && reduceMotion) state = 'parked';
    if (state === 'arrive') {
      drive = { elapsed: 0, dur: Math.min(6, Math.max(3, car.length / 3.2)) };
      placeCar(0);
      carState = 'driving';
      carFade.to = 1;
    } else if (state === 'parked') {
      drive = null;
      placeCar(1);
      carState = 'parked';
      carFade.to = 1;
    } else {
      drive = null;
      carState = 'away';
      carFade.to = 0;
    }
    if (revealWait) {
      revealWait = false;
      if (carState === 'driving') { clearTimeout(revealTimer); revealTimer = 0; revealAfterPark = true; }
      else revealIn(1100 - (performance.now() - mountedAt));
    } else if (carState !== 'driving') carSettled();
    invalidate();
  }
  const carScreenV = new THREE.Vector3();
  invalidate();

  function dispose() {
    disposed = true;
    clearTimeout(revealTimer);
    cancelAnimationFrame(raf);
    raf = 0;
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    controls.dispose();
    scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose(); });
    disposables.forEach(d => d.dispose());
    if (composer) composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    root.remove();
  }

  return {
    setMarkers, setMode: userMode, setSelection, setCar, reset, resize, dispose,
    get mode() { return mode; },
    get carState() { return carState; },
    get carScreen() {
      if (!car || carState === 'away') return null;
      carScreenV.set(car.g.position.x, car.centreY, car.g.position.z).project(camera);
      if (carScreenV.z >= 1) return null;
      return { x: ((carScreenV.x + 1) / 2) * width, y: ((1 - carScreenV.y) / 2) * height };
    }
  };
}
