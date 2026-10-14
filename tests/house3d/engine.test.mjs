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
const { sunPosition, gridBearing, sunDirection, sunGlow } = await import(new URL('scene/sun.js', E));
const { cornerBoards } = await import(new URL('scene/layers/building.js', E));

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
  building: { cladding: [true, true], interior: [true, true], frame: [true, true], glass: [false, false], floor: [false, true], tile: [false, true], roof: [true, true], paving: [false, true] },
  site: {
    deck: [false, true], paving: [false, true], hedge: [true, false], unit: [true, false], fence: [true, false],
    stone: [false, true], frame: [true, false], cladding: [true, false], mesh: [false, false],
    timber: [true, false], sand: [false, true], slide: [true, false], nest: [true, false], pad: [true, false], mat: [true, false], net: [false, false]
  },
  gates: { fence: [true, false] },
  trees: { trunk: [true, false], crown: [true, false] },
  pergola: { frame: [true, false] },
  car: { car: [true, false], glass: [false, false] }
};

test('real style: lit materials and shadow flags', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const names = new Map(Object.entries(ctx.kit.REAL).map(([k, v]) => [new THREE.Color(v).getHexString(), k]));
  // the car casts only once fully shown
  byId.car.api.setCar('parked');
  byId.car.update(1, 1);
  const seen = {}, lifted = new Set();
  for (const [id, want] of Object.entries(REAL_FLAGS)) {
    const L = byId[id];
    seen[id] = new Set();
    [L.group, L.lift].filter(Boolean).forEach(root => root.traverse(o => {
      if (!o.isMesh) return;
      [o.material].flat().forEach(mt => {
        assert.equal(mt.type, 'MeshStandardMaterial', `${id}: a ${o.geometry.type}`);
        const name = names.get(mt.color.getHexString());
        assert.ok(name in want, `${id}: unexpected surface ${name}`);
        seen[id].add(name);
        if (root === L.lift) lifted.add(`${id} ${name}`);
        assert.deepEqual([o.castShadow, o.receiveShadow], want[name], `${id}: ${name} shadow flags`);
      });
    }));
  }
  assert.ok(seen.building.has('frame'));
  assert.ok(lifted.has('building frame'), 'the roof edges and the upper corner boards');
  // the roofs' edge band and the carport roof's fascia: frame round a roof grey face
  const hex = n => new THREE.Color(ctx.kit.REAL[n]).getHexString();
  const edged = byId.building.lift.children.filter(o => o.isMesh && Array.isArray(o.material) && o.material.some(m => m.color.getHexString() === hex('roof')));
  assert.equal(edged.filter(o => o.geometry.type === 'ExtrudeGeometry').length, Object.keys(model.roofs).length);
  assert.equal(edged.filter(o => o.geometry.type === 'BoxGeometry').length, model.site.garage_roof.rects.length);
  edged.forEach(o => assert.ok(o.material.some(m => m.color.getHexString() === hex('frame')), o.geometry.type));
  assert.ok(seen.building.has('tile'), 'a room with floor tile');
});

test('real style: an exterior wall is boarded on its outer face only', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const walls = [];
  byId.building.group.traverse(o => { if (o.isMesh && Array.isArray(o.material)) walls.push(o); });
  assert.ok(walls.length >= 6);
  const inRoom = ([x, , z]) => model.rooms.some(r => r.rects.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1));
  byId.building.group.updateMatrixWorld(true);
  walls.forEach(w => {
    const [back, front, edge] = w.material, t = w.geometry.parameters.options.depth;
    assert.deepEqual(w.geometry.groups.map(g => g.materialIndex), [0, 1, 2]);
    assert.equal(edge.map, null);
    // the face whose material has the boards has no room just beyond it
    [[back, -1], [front, 1]].forEach(([mt, z]) => {
      if (!mt.map) return;
      const L = w.geometry.boundingBox || (w.geometry.computeBoundingBox(), w.geometry.boundingBox);
      const mid = new THREE.Vector3((L.min.x + L.max.x) / 2, 1, z * (t / 2 + 0.3)).applyMatrix4(w.matrixWorld);
      assert.ok(!inRoom(mid.toArray()), 'the boards face out');
    });
    assert.ok(back.map || front.map, 'boarded on one face at least');
    assert.notEqual(back.map, front.map, 'the back face takes the mirrored boards');
  });
});

test('real style: exterior walls get a base strip broken at doors', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const strips = [];
  byId.building.group.traverse(o => { if (o.isMesh && o.geometry.type === 'BoxGeometry' && Math.abs(o.position.y - 0.06) < 1e-6) strips.push(o); });
  // the fixture's street wall: a glass door and a door at the ground, three strips; the back
  // wall's floor window, two; the four other exterior walls one each; the interior wall none
  assert.equal(strips.length, 9);
  strips.forEach(s => assert.ok(s.geometry.parameters.width > 0.01));
  // on the outer face only: in the plan, just past the strip there is no room
  const inRoom = ([x, , z]) => model.rooms.some(r => r.rects.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1));
  byId.building.group.updateMatrixWorld(true);
  strips.forEach(s => {
    assert.ok(Math.abs(s.position.z) > 0.1, 'one face only');
    const out = new THREE.Vector3(0, 0, Math.sign(s.position.z) * 0.3).add(s.position).applyMatrix4(s.parent.matrixWorld);
    assert.ok(!inRoom(out.toArray()), 'the outer face');
  });
});

// the wall group for model wall w: the group at w.a holding the extruded wall
function wallGroup(root, w) {
  return root.children.find(g => g.isGroup && g.position.x === w.a[0] && g.position.z === w.a[1] && g.children.some(o => o.geometry && o.geometry.type === 'ExtrudeGeometry'));
}

test('real style: openings in an exterior wall get trims, reveals and a sill on the outer face', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const root = byId.building.group;
  root.updateMatrixWorld(true);
  const inRoom = ([x, , z]) => model.rooms.some(r => r.rects.some(([x0, z0, x1, z1]) => x >= x0 && x <= x1 && z >= z0 && z <= z1));
  const front = model.walls[0], g = wallGroup(root, front);
  const parts = g.children.filter(o => o.userData.part);
  // each opening's pieces, by where they sit along the wall
  const of = o => parts.filter(p => p.position.x > o.c - o.w / 2 - 0.2 && p.position.x < o.c + o.w / 2 + 0.2);
  const count = (list, part) => list.filter(p => p.userData.part === part).length;
  const [win, glassdoor, door] = front.openings;
  const w = of(win);
  assert.deepEqual([count(w, 'trim'), count(w, 'sill'), count(w, 'reveal')], [4, 1, 4], 'window');
  [glassdoor, door].forEach(o => {
    const d = of(o);
    assert.deepEqual([count(d, 'trim'), count(d, 'sill'), count(d, 'reveal')], [3, 0, 3], o.kind);
    const jambs = d.filter(p => p.userData.part === 'trim' && p.geometry.parameters.width < 0.2);
    assert.equal(jambs.length, 2);
    jambs.forEach(j => assert.ok(Math.abs(j.position.y - j.geometry.parameters.height / 2) < 1e-9, `${o.kind}: a jamb reaches the ground`));
  });
  parts.forEach(p => {
    const out = new THREE.Vector3(0, 0, Math.sign(p.position.z) * 0.3).add(p.position).applyMatrix4(g.matrixWorld);
    assert.ok(!inRoom(out.toArray()), `${p.userData.part} on the outer face`);
  });
  assert.equal(parts.length, 10 + 1 + 10);
  const inner = wallGroup(root, model.walls[6]);
  assert.ok(inner);
  assert.equal(inner.children.filter(o => o.userData.part).length, 0, 'the interior wall has no trim');
});

test('real style: corner boards and fillers at the outer corners only, split at the cut', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const corners = [[1.8, 1.8], [12.2, 1.8], [12.2, 10.2], [1.8, 10.2]], joins = [[2, 6], [12, 6]];
  const dist = (v, [x, z]) => Math.hypot(v.x - x, v.z - z);
  [byId.building.group, byId.building.lift].forEach((root, j) => {
    root.updateMatrixWorld(true);
    const found = [];
    root.traverse(o => { if (o.userData.part === 'corner') found.push(o); });
    const boards = found.filter(o => o.geometry.type === 'BoxGeometry'), fillers = found.filter(o => o.geometry.type === 'PlaneGeometry');
    const where = j ? 'lift' : 'group';
    assert.equal(boards.length, 8, `${where}: boards`);
    assert.equal(fillers.length, 8, `${where}: fillers`);
    found.forEach(o => {
      const v = o.getWorldPosition(new THREE.Vector3());
      assert.ok(corners.some(c => dist(v, c) < 0.15), `${where}: ${v.x}, ${v.z} at an outer corner`);
      assert.ok(joins.every(c => dist(v, c) > 1), `${where}: nothing at a collinear join`);
    });
    // cut at the ceiling: below it in group, above it in lift
    boards.forEach(o => {
      const h = o.geometry.parameters.height, y = o.position.y;
      assert.ok(j ? Math.abs(y - h / 2 - model.ceiling) < 1e-9 : Math.abs(y - h / 2) < 1e-9 && Math.abs(h - model.ceiling) < 1e-9);
    });
    fillers.forEach(o => assert.ok(o.material.map, `${where}: a filler carries the boards`));
  });
});

test('real style: a panel wall is anthracite, without a base strip', () => {
  const panelled = structuredClone(model);
  panelled.walls.push({ a: [13, 7.5], b: [13, 9], t: 0.04, top: 2.6, finish: 'panel' });
  const { ctx } = makeCtx({ ...options, style: 'real' }, panelled);
  const L = buildLayer(BUILDERS[LAYERS.indexOf('building')], 'building', ctx);
  const frame = new THREE.Color(ctx.kit.REAL.frame).getHexString();
  const panel = L.group.children.find(g => g.isGroup && g.position.x === 13 && g.position.z === 7.5);
  assert.equal(panel.children.length, 1, 'the panel has no strip, frames or glass');
  assert.equal(panel.children[0].material.color.getHexString(), frame);
  assert.deepEqual([panel.children[0].castShadow, panel.children[0].receiveShadow], [true, true]);
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
  lift.traverse(o => { if (o.isMesh) [o.material].flat().forEach(m => mats.add(m)); });
  const below = new Set();
  byId.building.group.traverse(o => { if (o.isMesh) [o.material].flat().forEach(m => below.add(m)); });
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

// an L outline's walls, t thick, each on its edge of the outer outline O with outward normal n;
// shift 0 runs centreline crossing to crossing (the fixture), shift t/2 moves every wall back
// along itself, so it runs to the outer corner at its start and stops at the next wall's inner
// face (the real model)
function lWalls(t, shift) {
  const O = [[0, 0], [10, 0], [10, 4], [4, 4], [4, 10], [0, 10]];
  const N = [[0, -1], [1, 0], [0, 1], [1, 0], [0, 1], [-1, 0]];
  const C = O.map((_, i) => {
    const [n0, n1] = [N[(i + 5) % 6], N[i]];
    // the centreline crossing at vertex i: t/2 in from both edges' outer faces
    return [O[i][0] - ((n0[0] + n1[0]) * t) / 2, O[i][1] - ((n0[1] + n1[1]) * t) / 2];
  });
  return C.map((c, i) => {
    const d = C[(i + 1) % 6], L = Math.hypot(d[0] - c[0], d[1] - c[1]), u = [(d[0] - c[0]) / L, (d[1] - c[1]) / L];
    return { i, a: [c[0] - u[0] * shift, c[1] - u[1] * shift], u, n: N[i], L, t };
  });
}

const cornerKey = p => p.map(v => v.toFixed(3)).join(',');

test('cornerBoards: an L outline has five convex corners and one concave', () => {
  const W = 0.12, D = 0.025, outer = ['0.000,0.000', '10.000,0.000', '10.000,4.000', '4.000,10.000', '0.000,10.000'];
  [0, 0.2].forEach(shift => {
    const res = cornerBoards(lWalls(0.4, shift), W, D);
    const boards = res.filter(c => !c.filler), at = {};
    boards.forEach(c => (at[cornerKey(c.p)] ||= []).push(c));
    assert.deepEqual(Object.keys(at).sort(), [...outer, '4.000,4.000'].sort(), `shift ${shift}`);
    outer.forEach(k => {
      assert.equal(at[k].length, 2, `convex ${k}`);
      assert.notEqual(at[k][0].wall, at[k][1].wall);
      at[k].forEach(c => assert.deepEqual([c.from, c.to], [-D, W]));
    });
    // found from both walls' ends, kept once
    assert.equal(at['4.000,4.000'].length, 2, 'concave');
    assert.deepEqual(at['4.000,4.000'].map(c => c.wall).sort(), [2, 3]);
    at['4.000,4.000'].forEach(c => assert.deepEqual([c.from, c.to], [0, W]));
    res.filter(c => c.filler).forEach(c => assert.ok(outer.includes(cornerKey(c.p)), 'fillers only at convex corners'));
  });
  // crossing to crossing, every convex corner has a notch on both walls
  assert.equal(cornerBoards(lWalls(0.4, 0), W, D).filter(c => c.filler).length, 10);
});

test('cornerBoards: a collinear join gives nothing', () => {
  const f = (i, x) => ({ i, a: [x, 0.2], u: [1, 0], n: [0, -1], L: 5, t: 0.4 });
  assert.deepEqual(cornerBoards([f(0, 0), f(1, 5)], 0.12, 0.025), []);
});

test('cornerBoards: a wall that stops at the other one\'s inner face gets a filler', () => {
  // B (0.5 thick) runs to the outer corner (0, 0); A (0.2 thick) stops at B's inner face
  const B = { i: 0, a: [0, 0.25], u: [1, 0], n: [0, -1], L: 5, t: 0.5 };
  const A = { i: 1, a: [0.1, 0.5], u: [0, 1], n: [-1, 0], L: 4.5, t: 0.2 };
  const res = cornerBoards([B, A], 0.12, 0.025);
  const boards = res.filter(c => !c.filler), fillers = res.filter(c => c.filler);
  assert.equal(boards.length, 2);
  boards.forEach(c => assert.equal(cornerKey(c.p), '0.000,0.000'));
  assert.equal(fillers.length, 1);
  assert.equal(fillers[0].wall, 1);
  assert.deepEqual(fillers[0].dir, [0, 1]);
  assert.ok(Math.abs(fillers[0].to - 0.5) < 1e-9 && fillers[0].from === 0);
});

test('cornerBoards: a wall butting into another one mid-length is no convex corner', () => {
  // B's outer face at z 0 runs on both sides of A, which ends at B's inner face
  const B = { i: 0, a: [0, 0.1], u: [1, 0], n: [0, -1], L: 10, t: 0.2 };
  const A = { i: 1, a: [5, 0.2], u: [0, 1], n: [-1, 0], L: 3, t: 0.2 };
  assert.deepEqual(cornerBoards([B, A], 0.12, 0.025), []);
});

test('real style: a corner board stops at an opening next to the corner', () => {
  // the street wall's door moved to end 0.05 m short of the east corner's face line
  const near = structuredClone(model);
  near.walls[0].openings[2] = { kind: 'door', c: 9.65, w: 1, h: 2.1 };
  const { ctx } = makeCtx({ ...options, style: 'real' }, near);
  const L = buildLayer(BUILDERS[LAYERS.indexOf('building')], 'building', ctx);
  L.group.updateMatrixWorld(true);
  const boards = [];
  L.group.traverse(o => {
    if (o.userData.part !== 'corner' || o.geometry.type !== 'BoxGeometry') return;
    const v = o.getWorldPosition(new THREE.Vector3());
    if (Math.hypot(v.x - 12.2, v.z - 1.8) < 0.15 && Math.abs(v.z - 1.8) < 0.02) boards.push(o);
  });
  assert.equal(boards.length, 1, 'the street wall\'s board at the east corner');
  const b = boards[0], w = b.geometry.parameters.width;
  // the door ends at local x 10.15, the corner's face line is at 10.2
  assert.ok(Math.abs(b.position.x - w / 2 - 10.15) < 1e-9, 'starts at the door');
  assert.ok(w < 0.12);
});

test('kit: every real-style colour is distinct', () => {
  const { REAL } = createKit(THREE, 'real');
  const hexes = Object.values(REAL).map(v => new THREE.Color(v).getHexString());
  assert.equal(new Set(hexes).size, hexes.length);
});

test('kit: pavers() is one texture per mount on a metre tile', () => {
  const kit = createKit(THREE, 'real'), t = kit.pavers();
  assert.equal(kit.pavers(), t);
  assert.notEqual(createKit(THREE, 'real').pavers(), t, 'a mount of its own');
  assert.equal(t.wrapS, THREE.RepeatWrapping);
  assert.equal(t.wrapT, THREE.RepeatWrapping);
  assert.ok(Math.abs(t.repeat.x - 1 / 0.9) < 1e-9 && Math.abs(t.repeat.y - 1 / 0.9) < 1e-9);
  // joints at 1, stones darker, shades vary
  const vals = new Set();
  for (let i = 0; i < t.image.data.length; i += 4) vals.add(t.image.data[i]);
  assert.ok(vals.has(255) && Math.min(...vals) >= Math.round(0.88 * 0.96 * 255) - 1 && vals.size > 3);
});

test('kit: bars() has two rails and a bar every 0.12 m, ends included, casting only', () => {
  const kit = createKit(THREE, 'real'), m = kit.surface('fence'), g = kit.bars(1.2, 1.2, m);
  const rails = g.children.filter(o => !o.isInstancedMesh), im = g.children.find(o => o.isInstancedMesh);
  assert.equal(rails.length, 2);
  assert.deepEqual(rails.map(r => r.position.y), [0.05, 1.2]);
  assert.equal(im.count, 11);
  const at = new THREE.Matrix4(), p = new THREE.Vector3(), xs = [];
  for (let i = 0; i < im.count; i++) { im.getMatrixAt(i, at); xs.push(p.setFromMatrixPosition(at).x); }
  xs.forEach((x, i) => assert.ok(Math.abs(x - i * 0.12) < 1e-6 && x >= -1e-6 && x <= 1.2 + 1e-6));
  g.children.forEach(o => assert.deepEqual([o.castShadow, o.receiveShadow], [true, false]));
});

test('kit: wireMesh() alpha is a wire or the veil, nothing between', () => {
  const t = createKit(THREE, 'real').wireMesh(), alphas = new Set();
  for (let i = 3; i < t.image.data.length; i += 4) alphas.add(t.image.data[i]);
  assert.deepEqual([...alphas].sort((a, b) => a - b), [26, 255]);
  assert.ok(Math.abs(t.repeat.x - 5) < 1e-9);
});

const hexOf = (kit, n) => new THREE.Color(kit.REAL[n]).getHexString();
const siteParts = (L, part) => { const out = []; L.group.traverse(o => { if (o.userData.part === part) out.push(o); }); return out; };

test('real style: paving and the carport floor carry the stones on world (x, z)', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const paving = byId.site.group.children.filter(o => o.isMesh && o.material.color.getHexString() === hexOf(ctx.kit, 'paving'));
  assert.equal(paving.length, 2, 'the paving and the porch');
  paving.forEach(m => {
    assert.equal(m.material.map, ctx.kit.pavers());
    const pos = m.geometry.attributes.position, uv = m.geometry.attributes.uv, nor = m.geometry.attributes.normal;
    const top = Math.max(...Array.from({ length: pos.count }, (_, k) => pos.getY(k)));
    let n = 0;
    // the top face's vertices: at the top, facing up or down (the extrusion's caps), not the sides
    for (let k = 0; k < pos.count; k++) {
      if (Math.abs(pos.getY(k) - top) > 1e-6 || Math.abs(nor.getY(k)) < 0.99) continue;
      n++;
      assert.ok(Math.abs(uv.getX(k) - pos.getX(k)) < 1e-6 && Math.abs(uv.getY(k) - pos.getZ(k)) < 1e-6, 'top-face uv is world (x, z)');
    }
    assert.ok(n >= 4);
  });
  const floor = byId.building.group.children.find(o => o.userData.room === 'carport');
  assert.equal(floor.material.map, ctx.kit.pavers());
  floor.updateMatrixWorld(true);
  const pos = floor.geometry.attributes.position, uv = floor.geometry.attributes.uv, v = new THREE.Vector3();
  for (let k = 0; k < pos.count; k++) {
    v.fromBufferAttribute(pos, k).applyMatrix4(floor.matrixWorld);
    assert.ok(Math.abs(uv.getX(k) - v.x) < 1e-6 && Math.abs(uv.getY(k) - v.z) < 1e-6, 'carport floor uv is world (x, z)');
  }
});

test('real style: bar fences on the street, mesh fences on the sides, no post at a gate post', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const spans = siteParts(byId.site, 'bars');
  assert.ok(spans.length >= 2);
  let total = 0;
  spans.forEach(g => {
    const im = g.children.find(o => o.isInstancedMesh), len = g.children.find(o => !o.isInstancedMesh).geometry.parameters.width;
    assert.ok(Math.abs(g.position.z + 6) < 1e-9, 'along z -6');
    assert.ok(Math.abs(Math.sin(g.rotation.y)) < 1e-9, 'running along x');
    // n gaps of 0.12 m, n + 1 bars
    assert.ok(Math.abs(im.count - 1 - len / 0.12) <= 1, `${im.count} bars on ${len} m`);
    total += len;
  });
  const want = model.site.bar_fences.reduce((a, [p, q]) => a + Math.hypot(q[0] - p[0], q[1] - p[1]), 0);
  assert.ok(Math.abs(total - want) < 1e-6, 'the spans cover the bar fences');
  const gatePosts = model.site.gates.flatMap(g => [g.a, g.b]);
  const posts = siteParts(byId.site, 'post');
  assert.ok(posts.length > 6);
  posts.forEach(p => gatePosts.forEach(([x, z]) => assert.ok(Math.hypot(p.position.x - x, p.position.z - z) >= 0.05, `a post at ${x}, ${z}`)));
  const planes = siteParts(byId.site, 'mesh');
  assert.equal(planes.length, model.site.fences.length);
  planes.forEach(m => {
    assert.equal(m.material.map, ctx.kit.wireMesh());
    assert.ok(model.site.fences.some(([a, b]) => Math.hypot(m.position.x - (a[0] + b[0]) / 2, m.position.z - (a[1] + b[1]) / 2) < 1e-6), 'on a side segment');
  });
});

test('real style: the step, the planters and their plants', () => {
  const { ctx, byId } = buildAll({ ...options, style: 'real' });
  const steps = byId.site.group.children.filter(o => o.isMesh && o.material.color.getHexString() === hexOf(ctx.kit, 'stone'));
  assert.equal(steps.length, 1);
  assert.ok(Math.abs(steps[0].position.y + steps[0].geometry.parameters.height / 2 - 0.115) < 1e-9);
  const planters = siteParts(byId.site, 'planter');
  assert.equal(planters.length, 2);
  planters.forEach(p => assert.equal(p.castShadow, true));
  assert.deepEqual(planters.map(p => p.material.color.getHexString()), [hexOf(ctx.kit, 'frame'), hexOf(ctx.kit, 'cladding')]);
});

test('real style: the swing, its tower and slide, the sandpit and the trampoline', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const sw = model.site.swing, L = byId.site;
  L.group.updateMatrixWorld(true);
  const legs = siteParts(L, 'leg');
  assert.equal(legs.length, 4 + 4 + 6, 'two A-frames, the tower and the trampoline');
  legs.forEach(l => assert.equal(Math.min(l.userData.ends[0][1], l.userData.ends[1][1]), 0));
  const [beam] = siteParts(L, 'beam');
  assert.ok(Math.abs(new THREE.Box3().setFromObject(beam).max.y - sw.height) < 1e-6, 'the beam top at height');
  const [chute] = siteParts(L, 'chute'), foot = chute.userData.ends[1];
  assert.ok(Math.hypot(foot[0] - sw.slide[0], foot[2] - sw.slide[1]) <= 0.15);
  // the chute lies flat across its slope
  const across = new THREE.Vector3(1, 0, 0).applyQuaternion(chute.quaternion);
  assert.ok(Math.abs(across.y) < 1e-6);
  // the tower is at the beam end nearer to the slide
  const [platform] = siteParts(L, 'platform');
  assert.ok(platform.position.z > sw.rect[3], 'past the end at z1');
  const [sand] = siteParts(L, 'sand'), ledges = siteParts(L, 'ledge');
  const topOf = o => new THREE.Box3().setFromObject(o).max.y;
  assert.ok(topOf(sand) < Math.min(...ledges.map(topOf)) - 0.05);
  const [net] = siteParts(L, 'net');
  assert.ok(net.material.transparent && net.material.opacity < 1 && !net.material.depthWrite);
  const b = new THREE.Box3().setFromObject(net), [x0, z0, x1, z1] = model.site.trampoline.rect;
  assert.ok(b.min.x >= x0 - 1e-6 && b.max.x <= x1 + 1e-6 && b.min.z >= z0 - 1e-6 && b.max.z <= z1 + 1e-6, 'the net inside the rect');
});

test('real style: a swing without slide along x, and a site without the new keys', () => {
  const m = structuredClone(model);
  m.site.swing = { rect: [6, -4, 9, -3.8], height: 2.2 };
  ['bar_fences', 'trampoline', 'planters', 'steps', 'sandpit'].forEach(k => delete m.site[k]);
  const { ctx } = makeCtx({ ...options, style: 'real' }, m);
  const L = buildLayer(BUILDERS[LAYERS.indexOf('site')], 'site', ctx);
  assert.ok(L);
  assert.equal(siteParts(L, 'chute').length, 0);
  assert.equal(siteParts(L, 'leg').length, 4);
  assert.equal(siteParts(L, 'bars').length, 0);
  assert.equal(siteParts(L, 'mesh').length, m.site.fences.length);
  const [beam] = siteParts(L, 'beam');
  assert.ok(Math.abs(beam.userData.ends[0][2] - beam.userData.ends[1][2]) < 1e-9, 'the beam runs along x');
  // with a slide on an x-axis swing, the climbing wall's width lies across the beam
  m.site.swing.slide = [10.5, -3];
  const L2 = buildLayer(BUILDERS[LAYERS.indexOf('site')], 'site', makeCtx({ ...options, style: 'real' }, m).ctx);
  const [wall] = siteParts(L2, 'wall');
  assert.ok(Math.abs(new THREE.Vector3(1, 0, 0).applyQuaternion(wall.quaternion).z) > 0.99);
});

test('real style: the drive gate is bars and slides its width', () => {
  const { byId } = buildAll({ ...options, style: 'real' });
  const gate = byId.gates.api.driveGate(model.car.path);
  const leaf = gate.leaves[0].pivot.children[0];
  assert.ok(leaf.isGroup && leaf.children.some(o => o.isInstancedMesh));
  byId.gates.group.updateMatrixWorld(true);
  const before = leaf.getWorldPosition(new THREE.Vector3());
  byId.gates.api.setGate(gate, 1);
  byId.gates.group.updateMatrixWorld(true);
  assert.ok(Math.abs(leaf.getWorldPosition(new THREE.Vector3()).distanceTo(before) - gate.w) < 1e-9);
});

test('sunGlow: hidden below the horizon, fading in, warm when low', () => {
  assert.equal(sunGlow(-5).visible, false);
  const low = sunGlow(1);
  assert.ok(low.visible && low.opacity > 0 && low.opacity < 1);
  assert.equal(low.warm, 1);
  assert.deepEqual(sunGlow(30), { visible: true, opacity: 1, warm: 0 });
});
