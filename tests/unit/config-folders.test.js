'use strict';
/* Unit tests for folder (sub-menu) segments in src/main/config.js — recursive
   cleanItem, the caps, and behavior.flyoutDwellMs. Electron stubbed via
   require-cache injection (test-bootstrap recipe); nothing touches %APPDATA%. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() } }
};
const { validate, walkItems, MAX_CHILDREN, MAX_FOLDER_DEPTH } = require('../../src/main/config.js');

const first = (raw) => validate({ rings: { 1: [raw] } }).rings['1'][0];
const kid = (raw) => first(raw).children[0];

/* --------------------------------- folder ---------------------------------- */
test('folder type survives validation', () => {
  const it = first({ type: 'folder', label: 'Tools', icon: '\uE838' });
  assert.equal(it.type, 'folder');
  assert.equal(it.label, 'Tools');
});

test('folder children survive and are cleaned like ring items', () => {
  const it = first({
    type: 'folder', label: 'Tools',
    children: [
      { label: 'Chrome', type: 'app', value: 'chrome.exe' },
      { label: 'Bogus', type: 'nonsense', value: 'x' }
    ]
  });
  assert.equal(it.children.length, 2);
  assert.equal(it.children[0].type, 'app');
  assert.equal(it.children[0].value, 'chrome.exe');
  assert.ok(it.children[0].id, 'child gets an id');
  assert.equal(it.children[1].type, 'app', 'unknown child type coerced like ring items');
});

test('non-folder items never carry children', () => {
  for (const type of ['app', 'url', 'file', 'command', 'macro', 'sys']) {
    const it = first({ type, value: 'v', children: [{ label: 'sneaky', type: 'app', value: 'x' }] });
    assert.deepEqual(it.children, [], `type ${type}`);
  }
});

test('folder wipes the executable slots (value/args/dir)', () => {
  const it = first({ type: 'folder', value: 'cmd.exe', args: '/c calc', dir: 'C:\\', children: [] });
  assert.equal(it.value, '');
  assert.equal(it.args, '');
  assert.equal(it.dir, '');
});

test('junk children collapse to an empty sub-menu', () => {
  for (const junk of [42, 'nope', {}, true, null, undefined]) {
    assert.deepEqual(first({ type: 'folder', children: junk }).children, [], String(junk));
  }
});

test('old configs (no children key at all) round-trip to children: []', () => {
  const it = first({ type: 'app', label: 'Legacy', value: 'notepad.exe' });
  assert.deepEqual(it.children, []);
});

/* ---------------------------------- caps ----------------------------------- */
test('sub-menu is capped at MAX_CHILDREN', () => {
  const kids = Array.from({ length: MAX_CHILDREN + 8 }, (_, i) => ({ label: 'k' + i, type: 'app', value: 'x' }));
  const it = first({ type: 'folder', children: kids });
  assert.equal(it.children.length, MAX_CHILDREN);
  assert.equal(it.children[MAX_CHILDREN - 1].label, 'k' + (MAX_CHILDREN - 1), 'kept the FIRST N');
});

test('nesting is capped at MAX_FOLDER_DEPTH; the deepest folder renders empty', () => {
  // Build folder → folder → … one level deeper than the cap allows.
  const deep = { type: 'folder', label: 'deep', children: [{ label: 'past-the-cap', type: 'app', value: 'x' }] };
  let tree = deep;
  for (let i = 0; i < MAX_FOLDER_DEPTH; i++) tree = { type: 'folder', label: 'd' + i, children: [tree] };
  const it = first({ type: 'folder', children: [tree] });
  // Walk down the validated tree counting folder levels.
  let cur = it, levels = 0;
  while (cur.type === 'folder' && cur.children.length) { cur = cur.children[0]; levels++; }
  assert.equal(cur.type, 'folder', 'deepest kept node is a folder');
  assert.deepEqual(cur.children, [], 'its own children were pruned at the cap');
  assert.ok(levels <= MAX_FOLDER_DEPTH + 1, `depth fuse held (walked ${levels})`);
});

test('child ids under a folder are unique (validate mints missing ones)', () => {
  const it = first({
    type: 'folder',
    children: [{ label: 'a', type: 'app', value: 'a' }, { label: 'b', type: 'app', value: 'b' }]
  });
  assert.notEqual(it.children[0].id, it.children[1].id);
});

/* -------------------------------- walkItems ---------------------------------- */
test('walkItems visits ring items AND folder children, depth-first', () => {
  const cfg = validate({
    rings: {
      1: [
        { id: 'top1', type: 'app', value: 'a' },
        {
          id: 'fold', type: 'folder',
          children: [
            { id: 'kid1', type: 'app', value: 'b' },
            { id: 'kidfold', type: 'folder', children: [{ id: 'grand', type: 'app', value: 'c' }] }
          ]
        }
      ],
      2: [{ id: 'top2', type: 'app', value: 'd' }]
    }
  });
  const ids = [];
  walkItems(cfg, (it) => { ids.push(it.id); });
  assert.deepEqual(ids.slice().sort(), ['fold', 'grand', 'kid1', 'kidfold', 'top1', 'top2']);
});

test('walkItems early-stops when the visitor returns false', () => {
  const cfg = validate({
    rings: { 1: [{ id: 'f', type: 'folder', children: [{ id: 'hidden', type: 'app', value: 'x' }] }] }
  });
  const seen = [];
  walkItems(cfg, (it) => { seen.push(it.id); return false; });
  assert.deepEqual(seen, ['f'], 'stopped at the first item — subtree never walked');
});

test('walkItems shrugs off junk configs', () => {
  assert.doesNotThrow(() => walkItems(null, () => {}));
  assert.doesNotThrow(() => walkItems({}, () => {}));
  assert.doesNotThrow(() => walkItems({ rings: { 1: [null, 'junk', { id: 'ok', children: 'nope' }] } }, () => {}));
});

/* ------------------------------ flyout dwell ------------------------------- */
test('behavior.flyoutDwellMs defaults to 180, clamps 0..600', () => {
  assert.equal(validate({}).behavior.flyoutDwellMs, 180);
  assert.equal(validate({ behavior: { flyoutDwellMs: 300 } }).behavior.flyoutDwellMs, 300);
  assert.equal(validate({ behavior: { flyoutDwellMs: 0 } }).behavior.flyoutDwellMs, 0);
  assert.equal(validate({ behavior: { flyoutDwellMs: -5 } }).behavior.flyoutDwellMs, 0);
  assert.equal(validate({ behavior: { flyoutDwellMs: 5000 } }).behavior.flyoutDwellMs, 600);
  for (const junk of ['soon', null, {}, NaN]) {
    assert.equal(validate({ behavior: { flyoutDwellMs: junk } }).behavior.flyoutDwellMs, 180, String(junk));
  }
});
