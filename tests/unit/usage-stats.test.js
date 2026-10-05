'use strict';
/* usage.stats() — the pure join behind Settings → Advanced → Usage. Electron-
   and fs-free by design (main hands it the parsed state.json map), so this file
   needs no stubs at all. */
const test = require('node:test');
const assert = require('node:assert/strict');

const usage = require('../../src/main/usage.js');
const { stats, STATS_MAX_ROWS, STATS_DEFAULT_ROWS } = usage;

const cfg = () => ({
  rings: {
    1: [
      { id: 'a', label: 'Notes', type: 'app', value: 'notepad.exe' },
      { id: 'b', label: 'Calc', type: 'app', value: 'calc.exe' },
      { id: 'f', label: 'Tools', type: 'folder', children: [
        { id: 'c', label: 'Deep', type: 'url', value: 'https://example.com' },
        { id: 'g', label: 'Nested', type: 'folder', children: [
          { id: 'd', label: 'Deeper', type: 'sys', value: 'lock' }
        ] }
      ] },
      { id: 'r', label: 'Recent', type: 'recent', children: [ { id: 'ghost', label: 'copied', type: 'app', value: 'x' } ] }
    ],
    2: []
  },
  profiles: [
    { id: 'p1', name: 'Editing', rings: { 1: [{ id: 'e', label: 'Premiere', type: 'app', value: 'premiere.exe' }] } }
  ]
});

/* ---------------------------------- basics ---------------------------------- */
test('rows come back most-fired first, then most-recent, then by name', () => {
  const map = { a: { n: 3, t: 1000 }, b: { n: 9, t: 900 }, e: { n: 9, t: 900 } };
  const out = stats(cfg(), map, { now: 5000 });
  assert.deepEqual(out.rows.map((r) => r.id), ['b', 'e', 'a'], 'tie on n breaks on t, then label');
  assert.equal(out.totalFires, 21);
  assert.equal(out.segments, 3);
});

test('a row carries everything the panel shows: label, type, ring, folder path, profile, count, recency', () => {
  const out = stats(cfg(), { c: { n: 2, t: 4000 }, d: { n: 1, t: 3000 }, e: { n: 5, t: 1000 } }, { now: 5000 });
  const deep = out.rows.find((r) => r.id === 'c');
  assert.deepEqual(
    { label: deep.label, type: deep.type, ring: deep.ring, path: deep.path, profile: deep.profile, n: deep.n, ageMs: deep.ageMs },
    { label: 'Deep', type: 'url', ring: 1, path: 'Tools', profile: null, n: 2, ageMs: 1000 }
  );
  const nested = out.rows.find((r) => r.id === 'd');
  assert.equal(nested.path, 'Tools › Nested', 'the trail is the whole chain of parents');
  const prof = out.rows.find((r) => r.id === 'e');
  assert.equal(prof.profile, 'Editing', 'profile segments are tagged, not mixed into the default wheel');
});

test('containers never appear as rows — only what can actually fire', () => {
  const out = stats(cfg(), { f: { n: 99, t: 4000 }, r: { n: 99, t: 4000 }, ghost: { n: 7, t: 3000 }, c: { n: 1, t: 1000 } }, { now: 4000 });
  // The folder and the recents box are skipped even with huge counts; their
  // children are real segments and ride the list (mirrors candidates()).
  assert.deepEqual(out.rows.map((r) => r.id), ['ghost', 'c']);
  assert.ok(!out.rows.some((r) => r.id === 'f' || r.id === 'r'));
});

/* --------------------------------- honesty --------------------------------- */
test('counts belonging to deleted segments are reported as orphans, not rows', () => {
  const out = stats(cfg(), { a: { n: 2, t: 900 }, gone1: { n: 8, t: 800 }, gone2: { n: 1, t: 700 } }, { now: 1000 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.orphans, 2);
  assert.equal(out.records, 3);
  assert.equal(out.totalFires, 2, 'an orphan fire never inflates the total');
});

test('junk records produce nothing, and inputs are never mutated', () => {
  const configBefore = cfg();
  const map = { a: { n: 0, t: 0 }, b: 'nope', c: null, d: { n: 4, t: 10 } };
  const mapBefore = JSON.stringify(map);
  const out = stats(configBefore, map, { now: 20 });
  assert.deepEqual(out.rows.map((r) => r.id), ['d']);
  assert.equal(JSON.stringify(configBefore), JSON.stringify(cfg()), 'config untouched');
  assert.equal(JSON.stringify(map), mapBefore, 'the usage map is read, never edited');
});

test('totals survive the row limit: the summary counts what the list truncates', () => {
  const map = {};
  for (let i = 0; i < 5; i++) map['a' + i] = { n: 10 + i, t: 100 + i };
  const many = { rings: { 1: Array.from({ length: 5 }, (_, i) => ({ id: 'a' + i, label: 'S' + i, type: 'app', value: 'x' })), 2: [] } };
  const out = stats(many, map, { now: 200, limit: 2 });
  assert.equal(out.rows.length, 2);
  assert.equal(out.segments, 5);
  assert.equal(out.totalFires, 10 + 11 + 12 + 13 + 14);
});

test('the limit is bounded and defaults sensibly', () => {
  assert.equal(STATS_MAX_ROWS, 300);
  assert.equal(STATS_DEFAULT_ROWS, 24);
  const build = (n) => ({
    rings: { 1: Array.from({ length: n }, (_, i) => ({ id: 'i' + i, label: 'L' + i, type: 'app', value: 'v' })), 2: [] }
  });
  const mapFor = (n) => { const m = {}; for (let i = 0; i < n; i++) m['i' + i] = { n: i + 1, t: 1000 + i }; return m; };

  assert.equal(stats(build(40), mapFor(40)).rows.length, STATS_DEFAULT_ROWS, 'no opts → default rows');
  assert.equal(stats(build(320), mapFor(320), { limit: 9999 }).rows.length, STATS_MAX_ROWS, 'a huge limit is clamped');
  assert.equal(stats(build(40), mapFor(40), { limit: 0 }).rows.length, 1, 'zero means one, not none');
  assert.equal(stats(build(40), mapFor(40), { limit: 'junk' }).rows.length, STATS_DEFAULT_ROWS, 'junk limit → default');
});

test('clock skew never yields a negative age, and a missing timestamp reads "never"', () => {
  const out = stats(cfg(), { a: { n: 1, t: 900 }, b: { n: 1, t: 0 } }, { now: 500 });
  assert.equal(out.rows.find((r) => r.id === 'a').ageMs, null, 't in the future → no age rather than a negative one');
  assert.equal(out.rows.find((r) => r.id === 'b').t, 0);
});

test('labels and targets are clipped for display', () => {
  const long = { rings: { 1: [{ id: 'x', label: 'L'.repeat(200), type: 'url', value: 'u'.repeat(500) }], 2: [] } };
  const row = stats(long, { x: { n: 1, t: 1 } }).rows[0];
  assert.equal(row.label.length, 40);
  assert.equal(row.value.length, 60);
});

/* --------------------------------- totality -------------------------------- */
test('garbage inputs answer an empty result instead of throwing', () => {
  for (const [c, m] of [[null, {}], [undefined, undefined], [{}, null], [{ rings: 'junk' }, 42], [[], []]]) {
    const out = stats(c, m);
    assert.deepEqual(out.rows, []);
    assert.equal(out.totalFires, 0);
    assert.equal(out.segments, 0);
    assert.equal(out.orphans, 0);
  }
});

test('duplicate ids count once (first occurrence wins), matching candidates() behaviour', () => {
  const dup = { rings: { 1: [{ id: 'z', label: 'First', type: 'app', value: 'a' }], 2: [{ id: 'z', label: 'Second', type: 'app', value: 'b' }] } };
  const out = stats(dup, { z: { n: 4, t: 10 } }, { now: 10 });
  assert.equal(out.rows.length, 1);
  assert.equal(out.rows[0].label, 'First');
  assert.equal(out.totalFires, 4);
});
