// Engine tests on the synthetic fixture: every scene layer builds in Node with the vendored
// three.js, and the simple style's objects and materials match tests/house3d/simple-snapshot.json.
// Run from the repo root: node --test tests/house3d/engine.test.mjs
// UPDATE_SNAPSHOT=1 rewrites the snapshot instead of comparing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const E = new URL('../../services/home/homeassistant/house3d/', import.meta.url);
const SNAPSHOT = new URL('./simple-snapshot.json', import.meta.url);
const LAYERS = ['ground', 'site', 'trees', 'gates', 'surroundings', 'pergola', 'building', 'car', 'fans'];

// kit.canvasTexture is the only thing under scene/ that touches the DOM
globalThis.document = {
  createElement: () => ({
    width: 0,
    height: 0,
    getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, fillStyle: '' })
  })
};

const THREE = await import(new URL('vendor/three-0.186.1/build/three.module.js', E));
const { createKit } = await import(new URL('scene/kit.js', E));
const BUILDERS = await Promise.all(LAYERS.map(id => import(new URL(`scene/layers/${id}.js`, E))));
const { modelFrame, buildLayer, guardLayer } = await import(new URL('house3d.js', E));
const { sunPosition, gridBearing, sunDirection } = await import(new URL('scene/sun.js', E));

const model = JSON.parse(execFileSync('python3', ['-I', fileURLToPath(new URL('../../scripts/house3d_model.py', import.meta.url)), '--layers', 'all',
  fileURLToPath(new URL('./fixture-model.md', import.meta.url))], { encoding: 'utf-8' }));

// what the card passes besides the model
const options = {
  car: model.car && model.car.profile && model.car.path ? { profile: model.car.profile, path: model.car.path } : undefined,
  surroundings: model.surroundings
};

// the ctx mount() builds, without a renderer, camera or loop
function makeCtx(opts = options, m = model) {
  const style = opts.style === 'real' ? 'real' : 'simple';
  const kit = createKit(THREE, style);
  const { roof, frame } = modelFrame(m);
  const byId = {};
  const ctx = {
    THREE, kit, C: kit.C, model: m, options: opts, style, reduceMotion: false,
    state: { mode: 'roof', roofFade: 1, hovered: null, selection: null },
    screen: () => null,
    frame, roof,
    ceiling: m.ceiling,
    layer: id => byId[id] || null,
    invalidate: () => {}
  };
  return { ctx, byId };
}

function buildAll(opts) {
  const { ctx, byId } = makeCtx(opts);
  const built = [];
  BUILDERS.forEach((mod, i) => {
    const L = mod.default(ctx);
    if (!L) return;
    byId[L.id] = L;
    built.push({ want: LAYERS[i], L });
  });
  return { ctx, built, byId };
}

// one layer's objects in traversal order (group, then lift), each with its material's id; the
// ids give which objects share a material instance
function describe(L) {
  const ids = new Map(), materials = {}, objects = [];
  const r = v => Number(v.toFixed(4));
  [L.group, L.lift].filter(Boolean).forEach(root => root.traverse(o => {
    let line = `${o.type} ${o.renderOrder}`;
    if (o.material) {
      const mt = o.material;
      if (!ids.has(mt)) {
        const id = `m${ids.size}`;
        ids.set(mt, id);
        materials[id] = `${mt.type} #${mt.color ? mt.color.getHexString() : '-'} ${r(mt.opacity)} transparent=${mt.transparent} depthWrite=${mt.depthWrite} side=${mt.side}`;
      }
      line += ` ${ids.get(mt)}`;
    }
    objects.push(line);
  }));
  return { materials, objects };
}

test('every layer builds and returns id and group', () => {
  const { built } = buildAll();
  const ids = built.map(b => b.L.id);
  assert.deepEqual(ids, LAYERS, 'the fixture has something for every layer');
  built.forEach(({ want, L }) => {
    assert.equal(L.id, want);
    assert.ok(L.group && L.group.isObject3D, `${want} has a group`);
  });
});

test('car and surroundings build from the options, not the model', () => {
  const { byId } = buildAll();
  assert.ok(byId.car);
  assert.ok(byId.surroundings);
  const bare = buildAll({});
  assert.equal(bare.byId.car, undefined);
  assert.equal(bare.byId.surroundings, undefined);
});

test('the simple style matches the snapshot', () => {
  const { built } = buildAll();
  const snap = Object.fromEntries(built.map(({ L }) => [L.id, describe(L)]));
  if (process.env.UPDATE_SNAPSHOT === '1' || !existsSync(SNAPSHOT)) {
    writeFileSync(SNAPSHOT, JSON.stringify(snap, null, 1) + '\n');
    if (process.env.UPDATE_SNAPSHOT !== '1') assert.fail('no snapshot yet: wrote one, check it in and rerun');
    return;
  }
  const want = JSON.parse(readFileSync(SNAPSHOT, 'utf-8'));
  for (const id of new Set([...Object.keys(want), ...Object.keys(snap)])) assert.deepEqual(snap[id], want[id], `layer ${id}`);
});

test('modules under scene/ import nothing', () => {
  const rx = /\bimport\s*[('"]|\bfrom\s*['"]/;
  const dir = new URL('scene/', E);
  const files = readdirSync(dir, { recursive: true }).filter(f => f.endsWith('.js'));
  assert.ok(files.length > 5);
  files.forEach(f => assert.doesNotMatch(readFileSync(new URL(f, dir), 'utf-8'), rx, `scene/${f}`));
});

// console.error calls during fn, with the console kept quiet
function errorsOf(fn) {
  const seen = [], orig = console.error;
  console.error = (...args) => seen.push(args.map(String).join(' '));
  try { return { result: fn(), seen }; } finally { console.error = orig; }
}

test('buildLayer: a layer that throws builds as null and logs', () => {
  const broken = structuredClone(model);
  broken.site.garage_roof = {};
  const { ctx } = makeCtx(options, broken);
  const { result, seen } = errorsOf(() => buildLayer(BUILDERS[LAYERS.indexOf('building')], 'building', ctx));
  assert.equal(result, null);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^house3d: layer building failed/);
  // the rest still builds from the same ctx
  assert.ok(buildLayer(BUILDERS[LAYERS.indexOf('site')], 'site', ctx));
});

test('guardLayer: a throwing update switches the layer off once', () => {
  let calls = 0, offs = 0;
  const L = guardLayer({
    id: 'bad',
    update() { calls++; throw new Error('boom'); },
    hit() { throw new Error('boom'); },
    api: { poke() { throw new Error('boom'); }, get state() { return 'x'; } }
  }, () => offs++);
  const { result, seen } = errorsOf(() => [L.update(0.016, 0.1), L.update(0.016, 0.1), L.hit({}), L.api.poke()]);
  assert.deepEqual(result, [false, false, null, undefined]);
  assert.equal(calls, 1, 'not called again after the throw');
  assert.equal(offs, 1);
  assert.equal(seen.length, 1);
  assert.match(seen[0], /^house3d: layer bad failed/);
  assert.equal(L.api.state, 'x', 'getters are left alone');
});

test('guardLayer: a working layer passes through', () => {
  let offs = 0;
  const L = guardLayer({ id: 'ok', update: (dt, k) => dt + k, hit: r => r }, () => offs++);
  assert.equal(L.update(1, 2), 3);
  assert.equal(L.hit('ray'), 'ray');
  assert.equal(offs, 0);
});

// coordinates as two-decimal positional arguments: the commit gate's ee-gps rules catch more
test('sunPosition: NOAA values for a midsummer and a midwinter noon', () => {
  const near = (v, want, tol, what) => assert.ok(Math.abs(v - want) <= tol, `${what}: ${v} is not ${want} +- ${tol}`);
  const june = sunPosition(new Date('2026-06-21T10:00Z'), 59.44, 24.75);
  near(june.altitude, 53.8, 0.3, 'June altitude');
  near(june.azimuth, 171.1, 0.3, 'June azimuth');
  near(sunPosition(new Date('2026-12-21T10:00Z'), 59.44, 24.75).altitude, 7.0, 0.3, 'December altitude');
  assert.ok(sunPosition(new Date('2026-06-21T22:00Z'), 59.44, 24.75).altitude < 0, 'below the horizon at midnight');
});

test('sunDirection and gridBearing', () => {
  const close = (v, want) => v.forEach((x, i) => assert.ok(Math.abs(x - want[i]) < 0.01, `${v} is not ${want}`));
  close(sunDirection(0, 0, 0), [1, 0, 0]);
  close(sunDirection(0, 90, 0), [0, 0, 1]);
  close(sunDirection(0, 90, 100.38), [0.98, 0, -0.18]);
  close(sunDirection(90, 0, 0), [0, 1, 0]);
  assert.equal(gridBearing(90, 24), 90);
  assert.ok(Math.abs(gridBearing(90, 26.5) - 87.87) < 0.01);
});

// the real style: each surface colour has one shadow role per layer, [castShadow, receiveShadow]
const REAL_FLAGS = {
  building: { cladding: [true, true], interior: [true, true], frameHouse: [true, true], frameDark: [true, true], glass: [false, false], floor: [false, true], roof: [true, false] },
  site: { deck: [false, true], paving: [false, true], hedge: [true, false], plinth: [true, false], fence: [true, false] },
  trees: { trunk: [true, false], crown: [true, false] },
  pergola: { frameDark: [true, false] },
  car: { car: [true, false], glass: [false, false] }
};

test('real style: lit materials and shadow flags', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const names = new Map(Object.entries(ctx.kit.REAL).map(([k, v]) => [new THREE.Color(v).getHexString(), k]));
  // the car casts only once fully shown
  byId.car.api.setCar('parked');
  byId.car.update(1, 1);
  const seen = {};
  for (const [id, want] of Object.entries(REAL_FLAGS)) {
    const L = byId[id];
    seen[id] = new Set();
    [L.group, L.lift].filter(Boolean).forEach(root => root.traverse(o => {
      if (!o.isMesh) return;
      assert.equal(o.material.type, 'MeshStandardMaterial', `${id}: a ${o.geometry.type}`);
      const name = names.get(o.material.color.getHexString());
      assert.ok(name in want, `${id}: unexpected surface ${name}`);
      seen[id].add(name);
      assert.deepEqual([o.castShadow, o.receiveShadow], want[name], `${id}: ${name} shadow flags`);
    }));
  }
  // the fixture's frames_dark names one of its two roofs, so both frame colours occur
  assert.ok(seen.building.has('frameHouse') && seen.building.has('frameDark'));
});

test('real style: every floor has its own material', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const floors = [];
  byId.building.group.traverse(o => { if (o.isMesh && o.userData.room) floors.push(o.material); });
  assert.ok(floors.length >= 3);
  assert.equal(new Set(floors).size, floors.length);
});

test('real style: the lift fades out and back on its own materials', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const lift = byId.building.lift, mats = new Set();
  lift.traverse(o => { if (o.isMesh) mats.add(o.material); });
  const below = new Set();
  byId.building.group.traverse(o => { if (o.isMesh) below.add(o.material); });
  mats.forEach(m => assert.ok(!below.has(m), 'a lift material is used below the lift'));
  ctx.kit.applyFade(lift, 0);
  assert.equal(lift.visible, false);
  mats.forEach(m => assert.equal(m.opacity, 0));
  ctx.kit.applyFade(lift, 1);
  assert.equal(lift.visible, true);
  mats.forEach(m => assert.equal(m.opacity, 1));
  below.forEach(m => assert.ok(m.opacity > 0));
});

test('real style: the car casts only while fully shown', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const body = byId.car.group.children.find(o => o.isMesh);
  assert.equal(body.castShadow, false);
  byId.car.api.setCar('parked');
  byId.car.update(0.016, 0.5);
  assert.equal(body.castShadow, false, 'half faded in');
  byId.car.update(1, 1);
  assert.equal(body.castShadow, true);
  byId.car.api.setCar('away');
  byId.car.update(0.016, 0.5);
  assert.equal(body.castShadow, false);
});
