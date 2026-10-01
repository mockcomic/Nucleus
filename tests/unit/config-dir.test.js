'use strict';
/* validate() cleaning of the optional item `dir` field — the folder slot the
   sys `explorer` action opens File Explorer in (see sys.js / settings.js).
   electron is stubbed via require-cache injection per test-bootstrap. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() } }
};

const { validate } = require('../../src/main/config.js');

const oneItem = (extra) => validate({
  rings: { 1: [{ id: 'x1', label: 'Files', type: 'sys', value: 'explorer', ...extra }] }
}).rings['1'][0];

test('dir survives validate as a trimmed string', () => {
  assert.equal(oneItem({ dir: '  C:\\Temp  ' }).dir, 'C:\\Temp');
});

test('dir defaults to empty string when absent', () => {
  assert.equal(oneItem({}).dir, '');
});

test('non-string dir values are dropped to empty string', () => {
  for (const bad of [42, true, {}, [], () => 'C:\\x']) {
    assert.equal(oneItem({ dir: bad }).dir, '', `dir=${typeof bad}`);
  }
});

test('dir is truncated at 2048 chars', () => {
  const long = 'C:\\' + 'a'.repeat(3000);
  assert.equal(oneItem({ dir: long }).dir.length, 2048);
});

test('dir round-trips through repeated validate (config watch / save echoes)', () => {
  const once = oneItem({ dir: 'C:\\Users\\dev\\Documents' });
  assert.equal(once.dir, 'C:\\Users\\dev\\Documents');
  assert.equal(oneItem(once).dir, 'C:\\Users\\dev\\Documents');
});

test('dir rides along on non-sys items without breaking them', () => {
  const it = validate({
    rings: { 1: [{ id: 'a', label: 'Notes', type: 'app', value: 'notepad.exe', dir: 'C:\\stray' }] }
  }).rings['1'][0];
  assert.equal(it.type, 'app');
  assert.equal(it.value, 'notepad.exe');
  assert.equal(it.dir, 'C:\\stray');   // inert for app type — sys.run never reads it
});
