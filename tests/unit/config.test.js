'use strict';
/* Unit tests for the item-sanitation half of src/main/config.js — focus on the
   `args` launch-parameter field added to app segments. Electron is stubbed via
   require-cache injection (test-bootstrap recipe); nothing touches %APPDATA%. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() } }
};
const { validate } = require('../../src/main/config.js');

const clean = (it) =>
  validate({ rings: { 1: [{ id: 'x', label: 'L', ...it }] } }).rings['1'][0];

/* ---------------------------------- args ---------------------------------- */
test('validate keeps app args verbatim (trimmed only at launch)', () => {
  assert.equal(clean({ type: 'app', value: 'a.exe', args: '--x y' }).args, '--x y');
  assert.equal(clean({ type: 'app', value: 'a.exe', args: 'C:\\My File.txt /z' }).args, 'C:\\My File.txt /z');
});

test('validate slices app args at 2048 chars', () => {
  assert.equal(clean({ type: 'app', args: 'z'.repeat(3000) }).args.length, 2048);
});

test('validate coerces junk args and defaults it to empty', () => {
  assert.equal(clean({ type: 'app', args: 42 }).args, '42');
  assert.equal(clean({ type: 'app', args: null }).args, '');
  assert.equal(clean({ type: 'app' }).args, '');
});

test('validate blanks args for every non-app type', () => {
  for (const type of ['url', 'file', 'command', 'macro', 'sys']) {
    assert.equal(clean({ type, value: 'v', args: '--sneaky' }).args, '', `type ${type}`);
  }
});

test('unknown type coerced to app still keeps its args', () => {
  const it = clean({ type: 'bogus', value: 'a.exe', args: '--keep' });
  assert.equal(it.type, 'app');
  assert.equal(it.args, '--keep');
});

/* ------------------------- regression: fields intact ----------------------- */
test('validate round-trips the rest of the item shape alongside args', () => {
  const it = clean({ type: 'app', value: 'notepad.exe', args: 'C:\\a.txt', dir: 'C:\\ghost' });
  assert.equal(it.value, 'notepad.exe');
  assert.equal(it.args, 'C:\\a.txt');
  assert.equal(it.label, 'L');
  assert.equal(it.id, 'x');
});
