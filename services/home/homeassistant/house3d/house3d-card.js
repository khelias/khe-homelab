// Home Assistant card for the house 3D view. The model (every layer but showcase) arrives in
// the card config, written by scripts/ha-dashboard.py; this file carries no house data.
// Bump HOUSE3D_VERSION on every change to this file or the engine, and the same ?v= on the
// Lovelace resource URL: HA's /local and the phone app cache aggressively.
const HOUSE3D_VERSION = 15;
const engine = import(`./house3d.js?v=${HOUSE3D_VERSION}`);

const nf1 = new Intl.NumberFormat('et-EE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

// The car drives in once per arrival per browser: the last arrival key seen is stored per entity.
// Storage can throw (private mode, blocked site data), so a module-level copy keeps a remount from
// replaying even then.
const seenMemory = new Map();
const seenKey = entity => `house3d-car-seen:${entity}`;
function readSeen(entity) {
  try {
    const v = localStorage.getItem(seenKey(entity));
    if (v !== null) return v;
  } catch (e) { /* the in-memory copy answers */ }
  return seenMemory.get(seenKey(entity)) ?? null;
}
function writeSeen(entity, key) {
  seenMemory.set(seenKey(entity), key);
  try { localStorage.setItem(seenKey(entity), key); } catch (e) { /* the in-memory copy stands */ }
}

// The Kihid sheet's switches, in this order; the choice is kept per browser like the arrival key.
const LAYER_LABELS = { markers: 'Seadmed', fans: 'Kaamerate vaated', trees: 'Puud', car: 'Auto', surroundings: 'Ümbrus' };
const LAYER_ORDER = Object.keys(LAYER_LABELS);
const LAYERS_KEY = 'house3d-layers';
function readLayers() {
  try {
    const v = JSON.parse(localStorage.getItem(LAYERS_KEY));
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (e) { /* the in-memory copy answers */ }
  return { ...(seenMemory.get(LAYERS_KEY) || {}) };
}
function writeLayers(layers) {
  seenMemory.set(LAYERS_KEY, layers);
  try { localStorage.setItem(LAYERS_KEY, JSON.stringify(layers)); } catch (e) { /* the in-memory copy stands */ }
}

// The style is kept per browser too; the time of day is not.
const STYLE_KEY = 'house3d-style';
function readStyle() {
  try {
    const v = localStorage.getItem(STYLE_KEY);
    if (v === 'simple' || v === 'real') return v;
  } catch (e) { /* the in-memory copy answers */ }
  return seenMemory.get(STYLE_KEY) === 'real' ? 'real' : 'simple';
}
function writeStyle(v) {
  seenMemory.set(STYLE_KEY, v);
  try { localStorage.setItem(STYLE_KEY, v); } catch (e) { /* the in-memory copy stands */ }
}

// The real style's sliders: the time of day in quarter hours (96 is 24:00) and the day of this year.
const dayFmt = new Intl.DateTimeFormat('et-EE', { day: 'numeric', month: 'long' });
const pad = n => String(n).padStart(2, '0');
const yearStart = () => new Date(new Date().getFullYear(), 0, 1);
const dayOfYear = d => Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - yearStart()) / 86400000);
const hourText = q => `${pad(Math.floor(q / 4))}:${pad((q % 4) * 15)}`;
const dayDate = n => new Date(yearStart().getFullYear(), 0, 1 + n);

// true when the car is home ('home' from a tracker, 'on' from the arrival helper), null when the
// state says nothing (unavailable, unknown), false otherwise and for a missing entity
export function carHome(st) {
  if (!st) return false;
  if (st.state === 'unavailable' || st.state === 'unknown') return null;
  return st.state === 'home' || st.state === 'on';
}

// the arrival helper's arrived_at when the entity has that attribute (null: parked without a
// drive-in), else last_changed
export function arrivalKey(st) {
  const a = st.attributes || {};
  if ('arrived_at' in a) return a.arrived_at === null || a.arrived_at === undefined ? null : String(a.arrived_at);
  return st.last_changed ? String(st.last_changed) : null;
}

// One device and its entity state -> a generic engine marker.
export function toMarker(d, st) {
  const m = { id: d.entity, pos: d.pos, icon: d.type, room: d.room, label: d.name, state: 'idle' };
  if (d.look) m.look = d.look;
  if (d.role) m.role = d.role;
  if (!st || st.state === 'unavailable') { m.state = 'off'; return m; }
  const s = st.state, domain = d.entity.split('.')[0];
  if (domain === 'alarm_control_panel') {
    m.state = s === 'triggered' ? 'alert' : s === 'disarmed' || s === 'unknown' ? 'idle' : 'on';
    m.warm = false;
    m.pulse = s === 'triggered';
  } else if (d.type === 'door' || d.type === 'smoke') {
    if (s === 'on') { m.state = 'alert'; m.pulse = true; }
  } else if (d.type === 'motion') {
    if (s === 'on') { m.state = 'on'; m.pulse = true; }
  } else if (domain === 'light') {
    if (s === 'on') {
      m.state = 'on';
      const b = num(st.attributes && st.attributes.brightness);
      m.level = b === null ? 1 : b / 255;
    }
  } else if (domain === 'sensor') {
    const v = num(s);
    if (v !== null) m.value = `${nf1.format(v)}°`;
  } else if (domain === 'water_heater') {
    const v = num(st.attributes && st.attributes.current_temperature);
    if (v !== null) m.value = `${nf1.format(v)}°`;
  }
  // cover (the pergola reports no position), select and camera stay idle
  return m;
}

const STYLE = `
:host { display: block; height: 480px; }
.wrap { display: block; position: relative; width: 100%; height: 100%; overflow: hidden; border-radius: var(--ha-card-border-radius, 12px);
  --ink: #e4ecff; --muted: #8a9bc2; --line: #6fe3ff; --amber: #ffc56e; --alert: #ff8b7b; --bg: #060c1b;
  --panel: rgba(10, 18, 38, 0.9); --edge: rgba(111, 227, 255, 0.18); --chip: rgba(111, 227, 255, 0.08);
  color: var(--ink); font: 14px/1.45 var(--paper-font-body1_-_font-family, system-ui, sans-serif); }
:host([panel]) .wrap { border-radius: 0; }
.view { position: absolute; inset: 0; }
.bar { position: absolute; top: 12px; right: 12px; display: flex; gap: 8px; align-items: center; }
.seg { display: flex; padding: 3px; gap: 2px; background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; }
.seg button, .icon-btn { font: inherit; font-size: 13px; font-weight: 500; line-height: 1; color: var(--muted); background: transparent; border: 0; border-radius: 7px; padding: 9px 12px; cursor: pointer; white-space: nowrap; }
.seg button[aria-pressed="true"] { color: var(--bg); background: var(--line); }
.icon-btn { display: grid; place-items: center; width: 40px; height: 40px; padding: 0; background: var(--panel); border: 1px solid var(--edge); border-radius: 10px; }
.icon-btn svg { width: 18px; height: 18px; }
button:focus-visible { outline: 2px solid var(--amber); outline-offset: 2px; }
.sheet[hidden] { display: none; }
.sheet { position: absolute; top: 64px; right: 12px; width: 320px; max-height: calc(100% - 80px); overflow: auto;
  background: var(--panel); border: 1px solid var(--edge); border-radius: 14px; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.45);
  display: grid; gap: 14px; padding: 16px; box-sizing: border-box; }
.head { display: grid; grid-template-columns: 1fr 32px; gap: 12px; align-items: start; }
.head h2 { margin: 0; font-size: 19px; font-weight: 600; line-height: 1.2; }
.head p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
.close { width: 32px; height: 32px; border-radius: 8px; border: 0; background: transparent; color: var(--muted); cursor: pointer; display: grid; place-items: center; }
.close svg { width: 18px; height: 18px; }
.list { display: grid; gap: 6px; }
.list button { display: grid; grid-template-columns: 22px 1fr auto; gap: 10px; align-items: center; text-align: left; width: 100%;
  font: inherit; font-size: 14px; line-height: 1.2; color: var(--ink); background: var(--chip); border: 1px solid transparent; border-radius: 9px; padding: 9px 10px; cursor: pointer; }
.list button svg { width: 18px; height: 18px; color: var(--line); }
.list button.on svg { color: var(--amber); }
.list button.alert svg { color: var(--alert); }
.list .st { font-size: 12px; color: var(--muted); font-variant-numeric: tabular-nums; }
.empty { color: var(--muted); }
.list.switches button { grid-template-columns: 1fr auto; }
.sw { position: relative; width: 34px; height: 20px; border-radius: 10px; background: rgba(138, 155, 194, 0.25); transition: background-color .15s; }
.sw::after { content: ""; position: absolute; top: 3px; left: 3px; width: 14px; height: 14px; border-radius: 50%; background: var(--muted); transition: transform .15s, background-color .15s; }
[aria-checked="true"] .sw { background: rgba(111, 227, 255, 0.35); }
[aria-checked="true"] .sw::after { transform: translateX(14px); background: var(--line); }
@media (prefers-reduced-motion: reduce) { .sw, .sw::after { transition: none; } }
.row { display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; }
.sheet .seg button { padding: 7px 12px; }
.slider { display: grid; gap: 6px; }
.slider output { font-size: 13px; color: var(--muted); font-variant-numeric: tabular-nums; }
.slider input { width: 100%; margin: 0; accent-color: var(--line); }
.now { justify-self: start; font: inherit; font-size: 13px; line-height: 1; color: var(--ink); background: var(--chip); border: 1px solid var(--edge); border-radius: 8px; padding: 8px 12px; cursor: pointer; }
.now[aria-pressed="true"] { color: var(--bg); background: var(--line); border-color: var(--line); }
.msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; color: var(--muted); text-align: center; background: var(--bg); }
.credit { position: absolute; top: 10px; left: 12px; max-width: calc(100% - 24px); font-size: 11px; line-height: 1.3; color: var(--muted); opacity: .8; pointer-events: none; }
@media (max-width: 600px) {
  .bar { top: auto; bottom: calc(12px + env(safe-area-inset-bottom, 0px)); right: 50%; transform: translateX(50%); }
  .sheet { top: auto; left: 0; right: 0; bottom: 0; width: auto; max-height: 62%; border-radius: 16px 16px 0 0;
    padding-bottom: calc(16px + env(safe-area-inset-bottom, 0px)); }
}
`;

class House3dCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
    this._states = new Map();
    this._room = null;
    this._style = readStyle();
    this._time = null; // null: live
  }

  setConfig(config) {
    if (!config || !config.model || !Array.isArray(config.model.walls)) throw new Error('house3d-card: config.model with walls is required');
    const changed = this._config && this._config.model !== config.model;
    this._config = config;
    this._devices = config.model.devices || [];
    this._car = config.model.car && config.model.car.profile && config.model.car.path ? config.model.car : null;
    if (changed) { this._unmount(); this._states.clear(); }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._view) return;
    if (!this._sunSet) this._applySun(hass);
    // the first push after mount always runs, so entities missing from HA still show dimmed
    let changed = !this._pushed;
    for (const d of this._devices) {
      const st = hass.states[d.entity];
      if (this._states.get(d.entity) !== st) { this._states.set(d.entity, st); changed = true; }
    }
    const carEntity = this._car && this._car.entity;
    if (carEntity && this._carSt !== hass.states[carEntity]) { this._carSt = hass.states[carEntity]; changed = true; }
    if (changed) this._push();
  }
  get hass() { return this._hass; }

  // panel views set isPanel; the card then fills the screen below its own top edge. HA's header
  // height varies (view tabs, the phone's safe area), so it is measured rather than assumed,
  // which kept the bottom button bar off screen in the phone app.
  set isPanel(v) { this.toggleAttribute('panel', !!v); this._fit(); }
  _fit() {
    if (!this.hasAttribute('panel') || !this.isConnected) { this.style.height = ''; return; }
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const top = Math.max(0, this.getBoundingClientRect().top);
    this.style.height = `${Math.max(320, Math.floor(vh - top))}px`;
  }
  getCardSize() { return 8; }
  getGridOptions() { return { columns: 'full', rows: 8 }; }

  connectedCallback() {
    this._onResize = this._onResize || (() => this._fit());
    window.addEventListener('resize', this._onResize);
    if (window.visualViewport) window.visualViewport.addEventListener('resize', this._onResize);
    requestAnimationFrame(this._onResize);
    this._render();
  }
  disconnectedCallback() {
    window.removeEventListener('resize', this._onResize);
    if (window.visualViewport) window.visualViewport.removeEventListener('resize', this._onResize);
    this._unmount();
  }

  _unmount() {
    if (this._view) { this._view.dispose(); this._view = null; }
    this._mounting = null;
    this._pushed = false;
    this._carSt = undefined;
    this._carHome = undefined;
  }

  _render() {
    if (!this._config || !this.isConnected || this._view || this._mounting) return;
    const sr = this.shadowRoot;
    sr.innerHTML = `<style>${STYLE}</style><ha-card class="wrap"><div class="view"></div>
      <div class="bar"><div class="seg" role="group" aria-label="Vaade">
        <button type="button" data-mode="roof" aria-pressed="true">Katusega</button>
        <button type="button" data-mode="open" aria-pressed="false">Katuseta</button></div>
        <button type="button" class="icon-btn" data-act="reset" aria-label="Lähtesta vaade" title="Lähtesta vaade"></button>
        <button type="button" class="icon-btn" data-act="layers" aria-label="Kihid" title="Kihid" aria-expanded="false"></button></div>
      <aside class="sheet" hidden aria-live="polite"></aside>${this._credit()}</ha-card>`;
    this._sheet = null;
    const token = (this._mounting = {});
    const keep = this._keep || {};
    this._keep = null;
    engine.then(mod => {
      if (this._mounting !== token || !this.isConnected) return;
      this._mounting = null;
      this._mod = mod;
      sr.querySelector('[data-act="reset"]').innerHTML = mod.icon('reset');
      sr.querySelector('[data-act="layers"]').innerHTML = mod.icon('layers');
      this._view = mod.mount(sr.querySelector('.view'), this._config.model, {
        onMarker: id => this._moreInfo(id),
        onRoom: id => this._openRoom(id),
        onMode: m => {
          sr.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
          if (m === 'roof') this._openRoom(null);
        },
        layers: readLayers(),
        style: this._style,
        mode: keep.mode,
        view: keep.view,
        car: this._car ? { profile: this._car.profile, path: this._car.path } : undefined,
        surroundings: this._config.model.surroundings,
        // a tap on the car replays the drive-in; the stored arrival stays as it is
        onCar: () => { if (this._carHome) this._view.setCar('arrive'); }
      });
      sr.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => this._view.setMode(b.dataset.mode)));
      sr.querySelector('[data-act="reset"]').addEventListener('click', () => this._view.reset());
      sr.querySelector('[data-act="layers"]').addEventListener('click', () => (this._sheet === 'layers' ? this._closeSheet() : this._openLayers()));
      sr.querySelector('.sheet').addEventListener('click', ev => {
        const row = ev.target.closest('[data-entity]');
        if (row) return this._moreInfo(row.dataset.entity);
        const sw = ev.target.closest('[data-layer]');
        if (sw) return this._switchLayer(sw.dataset.layer, sw.getAttribute('aria-checked') !== 'true');
        const st = ev.target.closest('[data-style]');
        if (st) return this._restyle(st.dataset.style);
        if (ev.target.closest('[data-act="now"]')) return this._setTime(null);
        if (ev.target.closest('[data-act="close"]')) return this._sheet === 'layers' ? this._closeSheet() : this._openRoom(null);
      });
      sr.querySelector('.sheet').addEventListener('input', ev => { if (ev.target.closest('[data-time]')) this._setTime(this._sliderTime()); });
      this._states.clear();
      this._pushed = false;
      this._carSt = undefined;
      this._carHome = undefined;
      this._sunSet = false;
      if (this._time) this._view.setTime(this._time);
      if (this._hass) this.hass = this._hass;
      if (keep.layers) this._openLayers();
    }).catch(err => {
      sr.querySelector('.view').innerHTML = `<div class="msg">3D-vaate laadimine ebaõnnestus: ${esc(err && err.message || err)}</div>`;
    });
  }

  // a new style remounts the engine; the mode, the camera, the time and the open Kihid sheet carry over
  _restyle(style) {
    if (style === this._style || !this._view) return;
    this._style = style;
    writeStyle(style);
    this._keep = { mode: this._view.mode, view: this._view.view, layers: this._sheet === 'layers' };
    this._unmount();
    this._render();
  }

  // the sun needs the house's place: HA's location and the model's grid bearing; without any of
  // them the real style keeps its fixed sun
  _applySun(hass) {
    const c = hass.config || {}, geo = this._config.model.georef || {};
    const place = { lat: num(c.latitude), lon: num(c.longitude), bearing: num(geo.x_axis_bearing_deg) };
    if (place.lat === null || place.lon === null || place.bearing === null) return;
    this._view.setSun(place);
    this._sunSet = true;
  }

  _sliderTime() {
    const sr = this.shadowRoot;
    const q = Number(sr.querySelector('[data-time="hour"]').value), d = Number(sr.querySelector('[data-time="day"]').value);
    return new Date(yearStart().getFullYear(), 0, 1 + d, 0, q * 15);
  }

  _setTime(t) {
    this._time = t;
    if (this._view) this._view.setTime(t);
    this._syncTime();
  }

  // the sliders show the time in use; live, they jump to now and the hour shows to the minute
  _syncTime() {
    const sr = this.shadowRoot, hour = sr.querySelector('[data-time="hour"]'), day = sr.querySelector('[data-time="day"]');
    if (!hour || !day) return;
    const now = new Date();
    if (!this._time) {
      hour.value = String(now.getHours() * 4 + Math.floor(now.getMinutes() / 15));
      day.value = String(dayOfYear(now));
    }
    sr.querySelector('[data-out="hour"]').textContent = this._time ? hourText(Number(hour.value)) : `${pad(now.getHours())}:${pad(now.getMinutes())}`;
    sr.querySelector('[data-out="day"]').textContent = dayFmt.format(dayDate(Number(day.value)));
    sr.querySelector('[data-act="now"]').setAttribute('aria-pressed', String(!this._time));
  }

  _timeRows() {
    const days = Math.round((new Date(yearStart().getFullYear() + 1, 0, 1) - yearStart()) / 86400000);
    return `<div class="slider"><div class="row"><label for="h3d-hour">Kellaaeg</label><output data-out="hour"></output></div>
        <input id="h3d-hour" type="range" min="0" max="96" step="1" data-time="hour"></div>
      <div class="slider"><div class="row"><label for="h3d-day">Kuupäev</label><output data-out="day"></output></div>
        <input id="h3d-day" type="range" min="0" max="${days - 1}" step="1" data-time="day"></div>
      <button type="button" class="now" data-act="now" aria-pressed="true">Praegu</button>`;
  }

  // the licence asks for the licensor, the dataset and its date; the bottom corners hold the
  // phone's button bar, so the line sits top left
  _credit() {
    const sur = this._config.model.surroundings;
    if (!sur) return '';
    const d = /(\d{4})-(\d{2})-(\d{2})/.exec(sur.source || '');
    return `<div class="credit">Ümbrus: Maa- ja Ruumiamet, ETAK${d ? `, ${d[3]}.${d[2]}.${d[1]}` : ''}</div>`;
  }

  _push() {
    this._pushed = true;
    this._view.setMarkers(this._devices.map(d => toMarker(d, this._states.get(d.entity))));
    this._pushCar();
    if (this._sheet === 'room') this._refreshRoom();
    else if (this._sheet === 'layers') { this._renderLayers(); this._syncTime(); }
  }

  // acts only when home/away changes, so attribute updates (a new location) never replay the drive-in
  _pushCar() {
    const car = this._car;
    if (!car) return;
    const st = car.entity ? this._carSt : undefined;
    const first = this._carHome === undefined, was = this._carHome;
    const now = carHome(st);
    // unavailable and unknown keep the last known value; on the first push they count as away
    const home = now === null ? !!was : now;
    this._carHome = home;
    if (!first && home === was) return;
    if (!home) return this._view.setCar('away');
    const key = arrivalKey(st);
    if (key === null) return this._view.setCar('parked');
    // also on a later push: an outage seen as away must not replay an arrival this browser saw
    if (readSeen(car.entity) === key) return this._view.setCar('parked');
    writeSeen(car.entity, key);
    this._view.setCar('arrive');
  }

  // update the open sheet's rows in place: replacing them would drop focus and a tap in progress
  _refreshRoom() {
    this.shadowRoot.querySelectorAll('.sheet [data-entity]').forEach(row => {
      const d = this._devices.find(x => x.entity === row.dataset.entity);
      const st = this._states.get(d.entity);
      row.className = toMarker(d, st).state;
      row.querySelector('.st').textContent = this._stateText(st);
    });
  }

  _moreInfo(entityId) {
    this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId }, bubbles: true, composed: true }));
  }

  _stateText(st) {
    if (!st) return 'puudub';
    if (this._hass && typeof this._hass.formatEntityState === 'function') return this._hass.formatEntityState(st);
    return st.state;
  }

  _closeSheet() {
    const sheet = this.shadowRoot.querySelector('.sheet');
    this._sheet = null;
    sheet.hidden = true;
    sheet.innerHTML = '';
    this.shadowRoot.querySelector('[data-act="layers"]').setAttribute('aria-expanded', 'false');
  }

  // a room sheet and Kihid replace each other; a tap on empty space and the roof going on close
  // only a room sheet
  _openRoom(id) {
    const sheet = this.shadowRoot.querySelector('.sheet');
    const room = id && this._config.model.rooms.find(r => r.id === id);
    if (!room && this._sheet === 'layers') return;
    this._room = room ? id : null;
    if (this._view) this._view.setSelection(this._room);
    if (!room) return this._closeSheet();
    this.shadowRoot.querySelector('[data-act="layers"]').setAttribute('aria-expanded', 'false');
    const mod = this._mod;
    const devs = this._devices.filter(d => d.room === id);
    const rows = devs.map(d => {
      const st = this._states.get(d.entity), m = toMarker(d, st);
      return `<button type="button" data-entity="${esc(d.entity)}" class="${m.state}">${mod.icon(d.type)}<span>${esc(d.name)}</span><span class="st">${esc(this._stateText(st))}</span></button>`;
    }).join('');
    sheet.innerHTML = `<div class="head"><div><h2>${esc(room.name)}</h2><p>Plaanil ${esc(room.no)} · ${nf1.format(mod.roomArea(room))} m²</p></div>
      <button type="button" class="close" data-act="close" aria-label="Sulge">${mod.icon('close')}</button></div>
      ${rows ? `<div class="list">${rows}</div>` : '<div class="empty">Selles ruumis seadmeid pole.</div>'}`;
    sheet.hidden = false;
    this._sheet = 'room';
  }

  _openLayers() {
    const sheet = this.shadowRoot.querySelector('.sheet');
    this._room = null;
    if (this._view) this._view.setSelection(null);
    sheet.innerHTML = `<div class="head"><div><h2>Kihid</h2></div>
      <button type="button" class="close" data-act="close" aria-label="Sulge">${this._mod.icon('close')}</button></div>
      <div class="row"><span>Stiil</span><div class="seg" role="group" aria-label="Stiil">
        <button type="button" data-style="simple" aria-pressed="${this._style === 'simple'}">Lihtne</button>
        <button type="button" data-style="real" aria-pressed="${this._style === 'real'}">Päris</button></div></div>
      ${this._style === 'real' ? this._timeRows() : ''}
      <div class="list switches"></div>`;
    this._sheet = 'layers';
    this._syncTime();
    this._renderLayers();
    sheet.hidden = false;
    this.shadowRoot.querySelector('[data-act="layers"]').setAttribute('aria-expanded', 'true');
  }

  // rows are replaced only when the set of layers changes, so a switch keeps its focus
  _renderLayers() {
    const list = this.shadowRoot.querySelector('.sheet .switches');
    if (!list || !this._view) return;
    const rank = id => (LAYER_ORDER.includes(id) ? LAYER_ORDER.indexOf(id) : LAYER_ORDER.length);
    const layers = this._view.layers.slice().sort((a, b) => rank(a.id) - rank(b.id));
    const ids = layers.map(l => l.id).join(' ');
    if (list.dataset.ids !== ids || !layers.length) {
      list.dataset.ids = ids;
      list.innerHTML = layers.length ? layers.map(l => `<button type="button" role="switch" data-layer="${esc(l.id)}" aria-checked="${l.on}">
        <span>${esc(LAYER_LABELS[l.id] || l.id)}</span><span class="sw" aria-hidden="true"></span></button>`).join('')
        : '<div class="empty">Lülitatavaid kihte pole.</div>';
      return;
    }
    list.querySelectorAll('[data-layer]').forEach((row, i) => row.setAttribute('aria-checked', String(layers[i].on)));
  }

  _switchLayer(id, on) {
    this._view.setLayer(id, on);
    const stored = readLayers();
    stored[id] = on;
    writeLayers(stored);
    this._renderLayers();
  }
}

if (!customElements.get('house3d-card')) {
  customElements.define('house3d-card', House3dCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'house3d-card', name: 'House 3D', description: 'The house as a 3D model with live device markers.' });
}
