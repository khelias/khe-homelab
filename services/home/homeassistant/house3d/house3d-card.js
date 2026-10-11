// Home Assistant card for the house 3D view. The model (every layer but showcase) arrives in
// the card config, written by scripts/ha-dashboard.py; this file carries no house data.
// Bump HOUSE3D_VERSION on every change to this file or the engine, and the same ?v= on the
// Lovelace resource URL: HA's /local and the phone app cache aggressively.
const HOUSE3D_VERSION = 4;
const engine = import(`./house3d.js?v=${HOUSE3D_VERSION}`);

const nf1 = new Intl.NumberFormat('et-EE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
const esc = s => String(s).replace(/[&<>"']/g, ch => `&#${ch.charCodeAt(0)};`);
const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v)) ? null : Number(v));

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
.msg { position: absolute; inset: 0; display: grid; place-items: center; padding: 16px; color: var(--muted); text-align: center; background: var(--bg); }
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
  }

  setConfig(config) {
    if (!config || !config.model || !Array.isArray(config.model.walls)) throw new Error('house3d-card: config.model with walls is required');
    const changed = this._config && this._config.model !== config.model;
    this._config = config;
    this._devices = config.model.devices || [];
    if (changed) { this._unmount(); this._states.clear(); }
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._view) return;
    // the first push after mount always runs, so entities missing from HA still show dimmed
    let changed = !this._pushed;
    for (const d of this._devices) {
      const st = hass.states[d.entity];
      if (this._states.get(d.entity) !== st) { this._states.set(d.entity, st); changed = true; }
    }
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
  }

  _render() {
    if (!this._config || !this.isConnected || this._view || this._mounting) return;
    const sr = this.shadowRoot;
    sr.innerHTML = `<style>${STYLE}</style><ha-card class="wrap"><div class="view"></div>
      <div class="bar"><div class="seg" role="group" aria-label="Vaade">
        <button type="button" data-mode="roof" aria-pressed="true">Katusega</button>
        <button type="button" data-mode="open" aria-pressed="false">Katuseta</button></div>
        <button type="button" class="icon-btn" data-act="reset" aria-label="Lähtesta vaade" title="Lähtesta vaade"></button></div>
      <aside class="sheet" hidden aria-live="polite"></aside></ha-card>`;
    const token = (this._mounting = {});
    engine.then(mod => {
      if (this._mounting !== token || !this.isConnected) return;
      this._mounting = null;
      this._mod = mod;
      sr.querySelector('[data-act="reset"]').innerHTML = mod.icon('reset');
      this._view = mod.mount(sr.querySelector('.view'), this._config.model, {
        onMarker: id => this._moreInfo(id),
        onRoom: id => this._openRoom(id),
        onMode: m => {
          sr.querySelectorAll('[data-mode]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
          if (m === 'roof') this._openRoom(null);
        }
      });
      sr.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => this._view.setMode(b.dataset.mode)));
      sr.querySelector('[data-act="reset"]').addEventListener('click', () => this._view.reset());
      sr.querySelector('.sheet').addEventListener('click', ev => {
        const row = ev.target.closest('[data-entity]');
        if (row) return this._moreInfo(row.dataset.entity);
        if (ev.target.closest('[data-act="close"]')) this._openRoom(null);
      });
      this._states.clear();
      this._pushed = false;
      if (this._hass) this.hass = this._hass;
    }).catch(err => {
      sr.querySelector('.view').innerHTML = `<div class="msg">3D-vaate laadimine ebaõnnestus: ${esc(err && err.message || err)}</div>`;
    });
  }

  _push() {
    this._pushed = true;
    this._view.setMarkers(this._devices.map(d => toMarker(d, this._states.get(d.entity))));
    if (this._room) this._refreshRoom();
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

  _openRoom(id) {
    const sheet = this.shadowRoot.querySelector('.sheet');
    const room = id && this._config.model.rooms.find(r => r.id === id);
    this._room = room ? id : null;
    if (this._view) this._view.setSelection(this._room);
    if (!room) { sheet.hidden = true; sheet.innerHTML = ''; return; }
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
  }
}

if (!customElements.get('house3d-card')) {
  customElements.define('house3d-card', House3dCard);
  window.customCards = window.customCards || [];
  window.customCards.push({ type: 'house3d-card', name: 'House 3D', description: 'The house as a 3D model with live device markers.' });
}
