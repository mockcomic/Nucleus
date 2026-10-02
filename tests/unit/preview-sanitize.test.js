'use strict';
/* The action:preview fix: a renderer-supplied preview item must pass through
   the store's own cleanItem pipeline BEFORE actions.js sees it — the same
   discipline wheel:segment-click applies against the live config. (Audit:
   a compromised settings page could otherwise hand executeAction — and
   through it the SendInput macro engine — an unbounded, unvalidated item.) */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

/* ---- electron stub, injected before any src/main require (test-bootstrap) ---- */
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() } }
};

const { sanitizeItem, MAX_CHILDREN, MAX_FOLDER_DEPTH } = require('../../src/main/config.js');

test('oversized action payloads are capped, never passed through', () => {
  const it = sanitizeItem({ type: 'macro', value: 'a,'.repeat(50000) });
  assert.equal(it.value.length, 2048, 'macro spec reaches the store with the 2048-char cap');
  const app = sanitizeItem({ type: 'app', value: 'x'.repeat(9999), args: 'y'.repeat(9999), dir: 'z'.repeat(9999) });
  assert.equal(app.value.length, 2048);
  assert.equal(app.args.length, 2048);
  assert.equal(app.dir.length, 2048);
});

test('unknown types coerce and launch slots stay type-scoped', () => {
  assert.equal(sanitizeItem({ type: 'evil', value: 'calc.exe' }).type, 'app');
  const macro = sanitizeItem({ type: 'macro', args: '--nope' });
  assert.equal(macro.args, '', 'args exist only on app items');
});

test('folder items are wiped non-executable and pruned at the caps', () => {
  const kids = Array.from({ length: 30 }, (_, k) => ({ type: 'app', value: 'x' + k }));
  const f = sanitizeItem({ type: 'folder', value: 'calc.exe', children: kids });
  assert.equal(f.value, '', 'a folder carries no launch payload');
  assert.equal(f.children.length, MAX_CHILDREN, 'children capped');

  // A folder at depth d keeps ITS children only while d < MAX_FOLDER_DEPTH:
  // chain root + MAX_FOLDER_DEPTH folders ending in an app — the last folder
  // must survive (as a pruned shell) and the app beyond it must not.
  const chain = (n) => n === 0 ? { type: 'app', value: 'boom' }
    : { type: 'folder', value: '', children: [chain(n - 1)] };
  const d = sanitizeItem(chain(MAX_FOLDER_DEPTH + 1));
  assert.equal(d.children.length, 1, 'root folder keeps its child');
  const l1 = d.children[0];
  const l2 = l1.children[0];
  const l3 = l2.children[0];
  assert.equal(l1.type, 'folder');
  assert.equal(l2.type, 'folder');
  assert.equal(l3.type, 'folder');
  assert.deepEqual(l3.children, [], 'the deepest folder is pruned to an empty shell');
});

test('label and icon slots cannot smuggle bulk or paths', () => {
  assert.equal(sanitizeItem({ label: 'l'.repeat(5000) }).label.length, 40);
  assert.equal(sanitizeItem({ iconImage: 'custom:../../evil.png' }).iconImage, '');
  assert.equal(sanitizeItem({ iconImage: 'custom:' + 'a'.repeat(16) + '.png' }).iconImage,
    'custom:' + 'a'.repeat(16) + '.png', 'legitimate custom keys survive');
});

test('junk input still yields a bounds-capped default item (never a crash)', () => {
  for (const junk of [null, undefined, 42, 'string', []]) {
    const it = sanitizeItem(junk);
    assert.equal(it.type, 'app');
    assert.equal(it.value, '');
    assert.ok(typeof it.id === 'string' && it.id, 'gets a fresh id');
  }
});
