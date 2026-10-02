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

/* --------------------- behaviour: mouse click-through policy ---------------- */
const bhv = (raw) => validate(raw).behavior;

test('mouseClickThrough defaults to false (swallow the click)', () => {
  assert.equal(bhv({}).mouseClickThrough, false);
  assert.equal(bhv({ behavior: {} }).mouseClickThrough, false);
});

test('mouseClickThrough is only true for a real true', () => {
  assert.equal(bhv({ behavior: { mouseClickThrough: true } }).mouseClickThrough, true);
  for (const junk of ['yes', 1, {}, [], 'true']) {
    assert.equal(bhv({ behavior: { mouseClickThrough: junk } }).mouseClickThrough, false, String(junk));
  }
  assert.equal(bhv({ behavior: { mouseClickThrough: false } }).mouseClickThrough, false);
});

/* --------------------------------- hotkey ---------------------------------- */
test('validate keeps mouse-button specs as written', () => {
  for (const spec of ['mmiddle', 'mback', 'mfwd', 'ctrl+mmiddle', 'ctrl+alt+mmiddle', 'ctrl+alt+shift+win+mfwd']) {
    assert.equal(validate({ hotkey: spec }).hotkey, spec, spec);
  }
});

test('validate lowercases/trims the spec and falls back on shape-invalid values', () => {
  assert.equal(validate({ hotkey: '  Ctrl+Alt+MMiddle ' }).hotkey, 'ctrl+alt+mmiddle');
  assert.equal(validate({ hotkey: 'not a hotkey!!' }).hotkey, 'ctrl+alt+space');   // '!' fails HOTKEY_RE
  assert.equal(validate({ hotkey: 'a'.repeat(60) }).hotkey, 'ctrl+alt+space');     // >40 chars
  assert.equal(validate({ hotkey: null }).hotkey, 'ctrl+alt+space');
  // HOTKEY_RE is a shape gate only; token GRAMMAR is enforced at registration by
  // hotkeys.parse, which surfaces the message in Settings and keeps the old hotkey.
  assert.equal(validate({ hotkey: 42 }).hotkey, '42');
});

/* ------------------------- regression: fields intact ----------------------- */
test('validate round-trips the rest of the item shape alongside args', () => {
  const it = clean({ type: 'app', value: 'notepad.exe', args: 'C:\\a.txt', dir: 'C:\\ghost' });
  assert.equal(it.value, 'notepad.exe');
  assert.equal(it.args, 'C:\\a.txt');
  assert.equal(it.label, 'L');
  assert.equal(it.id, 'x');
});

/* ------------------------- iconImage: two key families --------------------- */
/* The slot carries a Dashboard Icons slug OR custom-artwork keys; whichever
   family main's resolver routes on, validate must not be the thing that
   silently blanks the user's art. */
const CUSTOM = 'custom:' + 'a'.repeat(16) + '.png';

test('validate keeps a custom-artwork key and a dashboard slug alike', () => {
  assert.equal(clean({ iconImage: CUSTOM }).iconImage, CUSTOM);
  assert.equal(clean({ iconImage: 'firefox' }).iconImage, 'firefox');
  assert.equal(clean({ iconImage: CUSTOM.toUpperCase() }).iconImage, CUSTOM, 'case folds, like sanitizeSlug');
  assert.equal(clean({ iconImage: '  ' + CUSTOM + '  ' }).iconImage, CUSTOM, 'whitespace trims');
});

test('validate blanks iconImage for anything neither family recognises', () => {
  for (const junk of ['', null, undefined, 42, {}, [], 'custom:../../windows.png',
    'custom:' + 'a'.repeat(16) + '.exe', 'custom:not-a-hash.png', 'file:///C:/a.png',
    'https://example.com/a.png']) {
    assert.equal(clean({ iconImage: junk }).iconImage, '', JSON.stringify(junk));
  }
});

test('icon and iconImage are independent slots', () => {
  const it = clean({ icon: '\uE713', iconImage: CUSTOM });
  assert.equal(it.icon, '\uE713');
  assert.equal(it.iconImage, CUSTOM);
});
