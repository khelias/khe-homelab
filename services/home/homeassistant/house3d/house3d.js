// House 3D view engine: builds the scene from a house3d model (see scripts/house3d_model.py)
// and draws generic markers over it. The HA card and the standalone viewer are thin shells
// around mount(); neither the engine nor this directory carries any house data.
//
// This file is the core: renderer and bloom, camera, controls and framing, the marker and label
// overlay, roof mode, taps and hover, the frame loop, resize and dispose, and the layer
// registry. It builds no scene geometry. scene/kit.js makes each mount's colours, materials and
// geometry helpers; scene/layers/ holds one module per scene layer, listed in LAYERS below in
// build order. A new scene layer is a module there and its line in LAYERS.
//
// Modules under scene/ load nothing themselves: no import of any kind and no re-export. They get
// THREE, the kit and everything else through ctx. The core loads them with its own URL's query,
// so house3d.js?v=N loads scene/kit.js?v=N and every layer at that version. HA's /local and the
// phone app cache hard and only the URL the card builds carries ?v=, so a module loaded without
// it could stay stale. Module scope under scene/ holds constants only: a module runs once per
// URL, so mutable state there would be shared by a remount or a second card.
//
// Layer contract: a layer module's default export is build(ctx), which returns null when the
// model has nothing for it, otherwise:
//   id, group       the layer's name and its objects
//   lift?           a group that rises and fades with the roof mode (the building's upper part)
//   toggle?         true for a switchable layer; listed()? says whether view.layers shows it now
//   update(dt, k)?  per frame, dt in seconds and k the easing step; true while still animating
//   markers(list)?  every setMarkers list
//   hit(ray)?       the tap and hover test on the raycaster: null, { car: true } or
//                   { room, target }. Layers are tried in reverse build order, so the car wins
//                   over the floors, and a layer that is off is skipped
//   setOn(on)?      the layer was switched, also before the first frame (no invalidate there)
//   api?            what the core re-exports (setCar, carState, carScreen) or another layer
//                   calls through ctx.layer(id)
//   dispose()?      frees what the kit's list and the scene traversal do not
// ctx: THREE, kit, C (kit.C), model, options, frame { lotBox, wallBox, ext, E, lotCx, lotCz },
//   roof { fns, flat, under, topFn, gap }, ceiling, reduceMotion, state (read-only: mode,
//   roofFade, hovered, selection), layer(id), screen(x, y, z) -> { x, y } | null, invalidate().
// The core puts each layer's group and lift under a wrapper group, and switching a layer sets
// only the wrapper's visible. Nothing leaves the scene, so dispose() still reaches every object.
import * as THREE from './vendor/three-0.186.1/build/three.module.js';
import { OrbitControls } from './vendor/three-0.186.1/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from './vendor/three-0.186.1/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from './vendor/three-0.186.1/examples/jsm/postprocessing/OutputPass.js';

const LAYERS = ['ground', 'site', 'trees', 'gates', 'surroundings', 'pergola', 'building', 'car', 'fans'];
const QUERY = new URL(import.meta.url).search;
const [{ createKit }, ...BUILDERS] = await Promise.all(['kit', ...LAYERS.map(id => `layers/${id}`)].map(p => import(`./scene/${p}.js${QUERY}`)));

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

/**
 * mount(element, model, options) -> { setMarkers, setMode, setSelection, setCar, setLayer, reset, resize,
 *                                     dispose, mode, carState, carScreen, layers }
 *
 * model: geometry + rooms layers (private and showcase are ignored). site.decks and site.paving:
 *   items that are rects [x0, z0, x1, z1] or outlines [[x, z], ...]. site.gates: [{ a, b, kind,
 *   height, opens?, slide?, name? }], drawn closed in the fence line; kind 'sliding' (one leaf, set
 *   to the lot side, sliding past the end named by slide, 'a' or 'b'), 'swing1' (one leaf hinged
 *   at a) or 'swing2' (two leaves hinged at a and b), a swing gate opening 'in' (to the lot) or
 *   'out'. With a car, the gate its path crosses is the drive gate, and only it moves.
 * options:
 *   onMarker(id)     a marker was tapped
 *   onRoom(id|null)  a room floor was tapped with the roof off; null for empty space
 *   onMode(mode)     the mode changed ('roof' | 'open')
 *   onCar()          the car's body was tapped (either mode, while it shows); no room tap follows
 *   bloom            default true; always off below 720 px width
 *   mode             the starting mode, 'roof' (default) or 'open'
 *   labels(roomId)   room label text; the room's own name when it returns nothing
 *   layers           { id: bool }: the starting state of the switchable layers, default on
 *   car              { profile, path }: a vehicle drawn from profile, built hidden. profile is in
 *                    metres in the car's frame (origin on the ground at its centre, +x forward,
 *                    y up): length, width, height, side and glass outlines [[x, y], ...],
 *                    wheels { r, x: [rear, front], track }, lights { front, rear } as lists of
 *                    [[x, y, z], [x, y, z]] segments. path is [[x, z], ...]; the car drives a
 *                    smooth curve through it and parks at the last point, facing along the last leg.
 *   surroundings     { buildings: [{ outline: [[x, z], ...], height }], roads: [{ outline, holes? }] }:
 *                    the neighbouring buildings as flat-topped boxes and the street as a flat
 *                    surface, faint, never tapped
 * setCar('away' | 'parked' | 'arrive'): 'arrive' drives the whole path (3-6 s, restarts if it is
 *   already driving; 'parked' under reduced motion), after the drive gate, if any, has opened
 *   (1.2 s); the gate closes once the car is through. 'parked' stands it at the path's end, 'away'
 *   fades it out; both close the gate at once. carState is 'away' | 'driving' | 'parked'; carScreen
 *   is the car's projected centre { x, y } in CSS pixels relative to the element, or null when it
 *   is away or behind. Without a car, setCar does nothing, carState is 'away', carScreen null.
 * layers: [{ id, on }] for the switchable layers present and listed now; setLayer(id, on) switches
 *   one and ignores an unknown id.
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
    return { failed: true, setMarkers: noop, setMode: noop, setSelection: noop, setCar: noop, setLayer: noop, reset: noop, resize: noop,
      dispose: () => root.remove(), mode: 'roof', carState: 'away', carScreen: null, layers: [] };
  }
  const PR = Math.min(window.devicePixelRatio || 1, 2);
  renderer.setPixelRatio(PR);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  const kit = createKit(THREE), C = kit.C;
  const scene = new THREE.Scene();
  scene.background = C.bg;
  scene.fog = new THREE.Fog(C.bg, 34, 78);

  /* ---------- model ---------- */
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

  /* ---------- layers ---------- */
  let mode = 'roof', sel = null, hovered = null;
  const fade = { cur: 1, to: 1 };
  const state = {
    get mode() { return mode; },
    get roofFade() { return fade.cur; },
    get hovered() { return hovered; },
    get selection() { return sel; }
  };
  const screenV = new THREE.Vector3();
  function screen(x, y, z) {
    screenV.set(x, y, z).project(camera);
    if (screenV.z >= 1) return null;
    return { x: ((screenV.x + 1) / 2) * width, y: ((1 - screenV.y) / 2) * height };
  }
  const byId = {};
  const ctx = {
    THREE, kit, C, model, options, reduceMotion, state, screen,
    frame: { lotBox, wallBox, ext, E, lotCx, lotCz },
    roof: { fns: roofFns, flat, under, topFn, gap: ROOF_GAP },
    ceiling: model.ceiling,
    layer: id => byId[id] || null,
    invalidate: () => invalidate()
  };
  const layers = [];
  BUILDERS.forEach(mod => {
    const L = mod.default(ctx);
    if (!L) return;
    const wrap = new THREE.Group();
    wrap.add(L.group);
    if (L.lift) wrap.add(L.lift);
    scene.add(wrap);
    byId[L.id] = L;
    layers.push({ L, wrap, on: true });
  });
  function switchLayer(e, on) {
    e.on = on;
    e.wrap.visible = on;
    if (e.L.setOn) e.L.setOn(on);
  }
  function setLayer(id, on) {
    const e = layers.find(x => x.L.toggle && x.L.id === id);
    if (!e || e.on === !!on) return;
    switchLayer(e, !!on);
    invalidate();
  }
  // a stored choice applies before the first frame, also to a layer not listed yet
  const start = options.layers || {};
  layers.forEach(e => { if (e.L.toggle && start[e.L.id] === false) switchLayer(e, false); });

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
    layers.forEach(({ L }) => { if (L.markers) L.markers(list); });
    invalidate();
  }

  /* ---------- modes and selection ---------- */
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

  /* ---------- picking ---------- */
  const ray = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  let downAt = null;
  function aim(ev) {
    const rect = renderer.domElement.getBoundingClientRect();
    ndc.set(((ev.clientX - rect.left) / rect.width) * 2 - 1, -((ev.clientY - rect.top) / rect.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
  }
  // reads the ray that aim() set; later layers lie on top, so they are tried first
  function hitTest() {
    for (let i = layers.length - 1; i >= 0; i--) {
      const { L, on } = layers[i];
      const h = on && L.hit ? L.hit(ray) : null;
      if (h) return h;
    }
    return null;
  }
  const onMove = ev => {
    if (ev.pointerType !== 'mouse') return;
    aim(ev);
    const h = hitTest();
    const over = h && h.target ? h.target : null;
    if (over !== hovered) { hovered = over; invalidate(); }
    renderer.domElement.style.cursor = h ? 'pointer' : '';
  };
  const onDown = ev => { downAt = [ev.clientX, ev.clientY]; };
  const onUp = ev => {
    if (!downAt || Math.hypot(ev.clientX - downAt[0], ev.clientY - downAt[1]) > 6) return;
    aim(ev);
    const h = hitTest();
    if (h && h.car) { if (options.onCar) options.onCar(); return; }
    if (options.onRoom) options.onRoom(h && h.room ? h.room : null);
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
    if (!kit.near(fade.cur, fade.to)) { fade.cur += (fade.to - fade.cur) * k; moving = true; } else fade.cur = fade.to;
    layers.forEach(({ L }) => {
      if (!L.lift) return;
      L.lift.position.y = (1 - fade.cur) * 4.5;
      kit.applyFade(L.lift, Math.max(0, fade.cur * 1.25 - 0.25));
    });
    layers.forEach(({ L }) => { if (L.update && L.update(dt, k)) moving = true; });
    if (!moving && !dirty) { raf = 0; return; }
    dirty = false;
    raf = requestAnimationFrame(frame);

    const roofOpen = Math.max(0, 1 - fade.cur * 1.6);
    for (const rec of markers.values()) {
      // an alert indoors shows through the roof, so a closed view never hides it
      const m = rec.data, el = rec.el, covered = isIndoor(m) && m.state !== 'alert';
      v.set(m.pos[0], m.pos[1], m.pos[2]).project(camera);
      if ((covered && roofOpen <= 0.02) || v.z >= 1) { if (el.style.display !== 'none') el.style.display = 'none'; continue; }
      el.style.display = '';
      el.style.opacity = (covered ? roofOpen : 1).toFixed(2);
      el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -50%)`;
    }
    labels.forEach(l => {
      if (roofOpen < 0.02) { l.el.style.display = 'none'; return; }
      v.copy(l.pos).project(camera);
      l.el.style.display = v.z < 1 ? '' : 'none';
      l.el.style.opacity = (roofOpen * 0.8).toFixed(2);
      l.el.style.transform = `translate(${((v.x + 1) / 2) * width}px, ${((1 - v.y) / 2) * height}px) translate(-50%, -50%)`;
    });
    if (bloomOn()) getComposer().render();
    else renderer.render(scene, camera);
  }

  resize();
  setMode(options.mode === 'open' ? 'open' : 'roof', true);
  invalidate();

  function dispose() {
    disposed = true;
    cancelAnimationFrame(raf);
    raf = 0;
    if (ro) ro.disconnect();
    if (io) io.disconnect();
    renderer.domElement.removeEventListener('pointermove', onMove);
    renderer.domElement.removeEventListener('pointerdown', onDown);
    renderer.domElement.removeEventListener('pointerup', onUp);
    controls.dispose();
    layers.forEach(({ L }) => { if (L.dispose) L.dispose(); });
    scene.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material && !Array.isArray(o.material)) o.material.dispose(); });
    kit.disposables.forEach(d => d.dispose());
    if (composer) composer.dispose();
    renderer.dispose();
    renderer.forceContextLoss();
    root.remove();
  }

  // carState and carScreen stay getters, so a copy of this object would freeze them
  return {
    setMarkers, setMode, setSelection, setLayer, reset, resize, dispose,
    setCar: s => { if (byId.car) byId.car.api.setCar(s); },
    get mode() { return mode; },
    get carState() { return byId.car ? byId.car.api.carState : 'away'; },
    get carScreen() { return byId.car ? byId.car.api.carScreen : null; },
    get layers() { return layers.filter(e => e.L.toggle && (!e.L.listed || e.L.listed())).map(e => ({ id: e.L.id, on: e.on })); }
  };
}
