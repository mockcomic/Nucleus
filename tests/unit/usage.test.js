'use strict';
/* Usage sidecar + the auto-filled `recent` container (src/main/usage.js) —
   pure logic, plain objects in and out (main owns the state.json I/O). */
const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../../src/main/usage');
const { record, resolveRecents, MAX_KEYS } = usage;

const item = (id, type = 'app') => ({ id, type, label: id + ' label', value: type === 'app' ? id + '.exe' : '' });

/* --------------------------------- record --------------------------------- */
test('record counts up and stamps last-use', () => {
  const m = {};
  record(m, 'a', 1000);
  assert.deepEqual(m.a, { n: 1, t: 1000 });
  record(m, 'a', 2000);
  assert.deepEqual(m.a, { n: 2, t: 2000 });
});

test('record ignores junk ids and junk maps without throwing', () => {
  for (const bad of [undefined, null, '', 'x'.repeat(65), 42, {}]) {
    assert.doesNotThrow(() => record({}, bad));
  }
  for (const badMap of [undefined, null]) {
    assert.doesNotThrow(() => record(badMap, 'a'));
  }
});

test('record heals corrupted entries', () => {
  const m = { a: 'garbage' };
  record(m, 'a', 5);
  assert.deepEqual(m.a, { n: 1, t: 5 });
  const m2 = { a: { n: 'x', t: 'y' } };
  record(m2, 'a', 7);
  assert.deepEqual(m2.a, { n: 1, t: 7 });
});

test('record caps the sidecar at MAX_KEYS, evicting least-recently-used', () => {
  const m = {};
  for (let i = 0; i < MAX_KEYS + 60; i++) record(m, 'k' + i, 1_000_000 + i);
  assert.equal(Object.keys(m).length, MAX_KEYS);
  assert.ok(m['k' + (MAX_KEYS + 59)], 'the newest survives');
  assert.ok(!m.k0, 'the oldest is gone');
});

/* ------------------------------ resolveRecents ----------------------------- */
test('no recent segments → the SAME reference back (zero-cost hot path)', () => {
  const cfg = { rings: { 1: [item('a')], 2: [] }, profiles: [] };
  assert.equal(resolveRecents(cfg, { a: { n: 3, t: 5 } }, 8), cfg);
});

test('junk usage maps and never-used items produce an empty fan', () => {
  const cfg = { rings: { 1: [{ id: 'r', type: 'recent', label: 'Recent', children: [] }, item('a')], 2: [] } };
  const out = resolveRecents(cfg, undefined, 8);
  const recent = out.rings['1'].find((x) => x.recent);
  assert.equal(recent.type, 'folder',                     // presented as a folder for the shared renderer
  );
  assert.deepEqual(recent.children, []);
});

test('the fan fills by last-use (ties broken by fire count), capped by count', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => item(id));
  const cfg = { rings: { 1: [{ id: 'r', type: 'recent', label: 'Recent' }, ...items], 2: [] } };
  const map = {
    a: { n: 9, t: 100 },
    b: { n: 1, t: 300 },
    c: { n: 5, t: 300 },            // same t as b, more fires → ahead of b
    d: { n: 1, t: 200 },
    e: { n: 1, t: 50 }
  };
  const out = resolveRecents(cfg, map, 3);
  const kids = out.rings['1'][0].children;
  assert.deepEqual(kids.map((k) => k.id), ['c', 'b', 'd']);
});

test('containers are never candidates; children of folders ARE', () => {
  const cfg = {
    rings: {
      1: [
        { id: 'r', type: 'recent', label: 'Recent' },
        { id: 'f', type: 'folder', label: 'F', children: [item('deep')] }
      ], 2: []
    }
  };
  const out = resolveRecents(cfg, { r: { n: 5, t: 9 }, f: { n: 5, t: 8 }, deep: { n: 5, t: 7 } }, 8);
  const kids = out.rings['1'][0].children.map((k) => k.id);
  assert.deepEqual(kids, ['deep'], 'folders and recent-containers stay out of their own fan');
});

test('profile rings hold candidates AND recent containers', () => {
  const cfg = {
    rings: { 1: [item('home')], 2: [] },
    profiles: [{ id: 'p1', name: 'P', apps: ['x.exe'], rings: { 1: [{ id: 'r', type: 'recent' }, item('work')], 2: [] } }]
  };
  const out = resolveRecents(cfg, { home: { n: 1, t: 5 }, work: { n: 1, t: 9 } }, 8);
  const kids = out.profiles[0].rings['1'][0].children.map((k) => k.id);
  assert.deepEqual(kids, ['work', 'home'], 'candidates come from the whole config; the store is never mutated');
  assert.equal(cfg.profiles[0].rings['1'][0].children, undefined);
});

test('children carry the REAL ids (ipc live-match contract)', () => {
  const cfg = { rings: { 1: [{ id: 'r', type: 'recent' }, item('a')], 2: [] } };
  const out = resolveRecents(cfg, { a: { n: 2, t: 50 } }, 8);
  const kid = out.rings['1'][0].children[0];
  assert.equal(kid.id, 'a');
  assert.notEqual(kid, cfg.rings['1'][1], 'deep-copied — the store object never rides into the payload');
});

test('count is clamped to 3..12 and the RECENT_MAX fan cap', () => {
  const items = Array.from({ length: 20 }, (_, i) => item('i' + i));
  const cfg = { rings: { 1: [{ id: 'r', type: 'recent' }, ...items], 2: [] } };
  const map = Object.fromEntries(items.map((it, i) => [it.id, { n: 1, t: 1000 + i }]));
  assert.equal(resolveRecents(cfg, map, 999).rings['1'][0].children.length, 12, 'RECENT_MAX');
  assert.equal(resolveRecents(cfg, map, 0).rings['1'][0].children.length, 3, 'MIN_COUNT floor');
  assert.equal(resolveRecents(cfg, map, 'x').rings['1'][0].children.length, 8, 'junk → default 8');
});

test('recent items nested inside a folder resolve too; folder children are valid candidates', () => {
  const cfg = {
    rings: {
      1: [{ id: 'f', type: 'folder', label: 'F', children: [{ id: 'r', type: 'recent', label: 'R' }, { id: 'x', type: 'app', label: 'X' }] }],
      2: []
    }
  };
  const out = resolveRecents(cfg, { f: { n: 1, t: 9 }, x: { n: 1, t: 5 } }, 8);
  const nested = out.rings['1'][0].children[0];
  assert.equal(nested.recent, true);
  assert.deepEqual(nested.children.map((k) => k.id), ['x'], 'the folder itself stays out; its leaf children are candidates');
});
