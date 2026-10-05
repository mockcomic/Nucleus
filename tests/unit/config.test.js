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
  for (const type of ['url', 'file', 'command', 'macro', 'sys', 'setting']) {
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

/* ---------------------- behaviour: focus-existing-app ---------------------- */
test('focusExistingApp defaults to false (always launch)', () => {
  assert.equal(bhv({}).focusExistingApp, false);
  assert.equal(bhv({ behavior: {} }).focusExistingApp, false);
});

test('focusExistingApp is only true for a real true', () => {
  assert.equal(bhv({ behavior: { focusExistingApp: true } }).focusExistingApp, true);
  for (const junk of ['yes', 1, {}, [], 'true']) {
    assert.equal(bhv({ behavior: { focusExistingApp: junk } }).focusExistingApp, false, String(junk));
  }
  assert.equal(bhv({ behavior: { focusExistingApp: false } }).focusExistingApp, false);
});

test('focusExistingApp survives a save round-trip', () => {
  const saved = validate({ behavior: { focusExistingApp: true } });
  assert.equal(validate(JSON.parse(JSON.stringify(saved))).behavior.focusExistingApp, true);
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

/* -------------------------------- profiles --------------------------------- */
const profs = (raw) => validate(raw).profiles;
const one = (p) => profs({ profiles: [p] })[0];

test('profiles default to an empty array and drop junk entries', () => {
  assert.deepEqual(profs({}), []);
  assert.deepEqual(profs({ profiles: 'nope' }), []);
  assert.deepEqual(profs({ profiles: [null, 42, 'x', []] }), []);
});

test('profile caps: MAX_PROFILES slices the list', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ name: 'P' + i }));
  assert.equal(profs({ profiles: many }).length, 8);
});

test('profile name: control chars stripped, blank becomes "Profile", capped at 40', () => {
  assert.equal(one({ name: 'VS Code' }).name, 'VS Code');
  assert.equal(one({ name: 'be\u0000ep\u0001' }).name, 'beep');
  assert.equal(one({ name: '   ' }).name, 'Profile');
  assert.equal(one({}).name, 'Profile');
  assert.equal(one({ name: 'x'.repeat(90) }).name.length, 40);
});

test('profile apps reuse the gaming-mode basename normalizer (dedupe + junk drop)', () => {
  const p = one({ apps: ['C:\\Games\\FOO.exe', 'foo.exe', ' bar.exe ', 'bad|name', 42, ''] });
  assert.deepEqual(p.apps, ['foo.exe', 'bar.exe']);
});

test('profile rings normalize exactly like the default wheel (contiguous 1..N, items cleaned)', () => {
  const p = one({ rings: { '3': [{ id: 'x', label: 'Deep', type: 'url', value: 'https://a' }], '9': [] } });
  assert.deepEqual(Object.keys(p.rings).sort(), ['1', '2']);
  assert.equal(p.rings['1'][0].label, 'Deep');
});

test('an ALL-EMPTY profile is allowed (it simply never activates) — unlike the default wheel', () => {
  const p = one({ name: 'Empty', rings: { 1: [], 2: [] } });
  assert.deepEqual(p.rings['1'], []);                       // no defaults injected into a profile
  assert.ok(profs({ rings: { 1: [], 2: [] } }).length >= 0); // top level keeps its own never-empty guard
  assert.ok(validate({ rings: { 1: [], 2: [] } }).rings['1'].length > 0);
});

test('profile ids survive when well-formed and regenerate when junk', () => {
  assert.equal(one({ id: 'p-42' }).id, 'p-42');
  assert.equal(one({ id: 'x'.repeat(90) }).id.length, 40);
  assert.ok(one({ id: 7 }).id, 'junk id → fresh nid');
});

/* ------------------------------ recent items ------------------------------- */
test('recent is a container type: action slots and hand-carried children wiped', () => {
  const it = clean({ type: 'recent', value: 'notepad.exe', args: '--sneaky', dir: 'C:\\x', children: [{ id: 'k', type: 'app', value: 'evil.exe' }] });
  assert.equal(it.type, 'recent');
  assert.equal(it.value, '');
  assert.equal(it.args, '');
  assert.equal(it.dir, '');
  assert.deepEqual(it.children, []);
});

/* ------------------------------ mixer items -------------------------------- */
test('mixer is a container type too: it stores no action and no fan', () => {
  const it = clean({ type: 'mixer', value: 'sndvol.exe', args: '--loud', dir: 'C:\\x', children: [{ id: 'k', type: 'app', value: 'evil.exe' }] });
  assert.equal(it.type, 'mixer', 'must survive the TYPES whitelist, not coerce to app');
  assert.equal(it.value, '');
  assert.equal(it.args, '');
  assert.equal(it.dir, '');
  assert.deepEqual(it.children, [], 'the volume card is built live from Core Audio — nothing stowed in the item');
});

/* ------------------------------ setting items ------------------------------ */
test('setting is an executable type: value kept, args/dir/children wiped', () => {
  const it = clean({ type: 'setting', value: 'toggle_wheel_sound', args: '--sneaky', dir: 'C:\\ghost', children: [{ id: 'k', type: 'app', value: 'evil.exe' }] });
  assert.equal(it.type, 'setting', 'must survive the TYPES whitelist, not coerce to app');
  assert.equal(it.value, 'toggle_wheel_sound');
  assert.equal(it.args, '', 'the arguments slot is app-only');
  assert.equal(it.dir, '', 'the folder slot is sys-only');
  assert.deepEqual(it.children, [], 'children are folder-only');
});

test('the builtin:app icon key survives sanitize; junk and near-misses drop', () => {
  assert.equal(clean({ type: 'setting', iconImage: 'builtin:app' }).iconImage, 'builtin:app');
  // Exact-match sentinel: case is part of the key contract, path-ish junk never passes.
  assert.equal(clean({ type: 'app', iconImage: 'BUILTIN:APP' }).iconImage, '');
  assert.equal(clean({ type: 'app', iconImage: 'builtin:app/../evil' }).iconImage, '');
  assert.equal(clean({ type: 'app', iconImage: 'builtin:app\n' }).iconImage, '');
});


/* ----------------------------- behavior flags ------------------------------ */
test('new behavior flags: defaults', () => {
  const b = validate({}).behavior;
  assert.equal(b.profilesEnabled, false,   // off unless explicitly true (probing is opt-in)
  );
  assert.equal(b.markingSelect, true);
  assert.equal(b.typeToFilter, true);
  assert.equal(b.recentsCount, 8);
});

test('profilesEnabled is true ONLY for a real true; the other two are opt-out', () => {
  assert.equal(bhv({ behavior: { profilesEnabled: true } }).profilesEnabled, true);
  for (const junk of ['yes', 1, {}]) assert.equal(bhv({ behavior: { profilesEnabled: junk } }).profilesEnabled, false);
  assert.equal(bhv({ behavior: { markingSelect: false } }).markingSelect, false);
  assert.equal(bhv({ behavior: { markingSelect: 'off' } }).markingSelect, true, 'junk does not switch the feature off');
  assert.equal(bhv({ behavior: { typeToFilter: false } }).typeToFilter, false);
});

test('recentsCount clamps to 3..12 and heals junk', () => {
  assert.equal(bhv({ behavior: { recentsCount: 99 } }).recentsCount, 12);
  assert.equal(bhv({ behavior: { recentsCount: 0 } }).recentsCount, 3);
  assert.equal(bhv({ behavior: { recentsCount: 'eight' } }).recentsCount, 8);
});

/* ------------------------------- wheelSound ------------------------------- */
test('wheelSound is opt-in: default false, only a real true turns audio on', () => {
  assert.equal(bhv({}).wheelSound, false, 'absent = silent wheel');
  assert.equal(bhv({ behavior: { wheelSound: true } }).wheelSound, true);
  for (const junk of ['yes', 1, {}, 'on']) {
    assert.equal(bhv({ behavior: { wheelSound: junk } }).wheelSound, false, `junk ${JSON.stringify(junk)} stays silent`);
  }
});


/* ----------------------------- walkItems coverage --------------------------- */
test('walkItems reaches into profile rings AND nested folder children', () => {
  const cfg = validate({
    rings: { 1: [{ id: 'top', type: 'app', value: 'a' }], 2: [] },
    profiles: [{
      id: 'p', name: 'P',
      rings: { 1: [{ id: 'pp', type: 'folder', children: [{ id: 'kk', type: 'app', value: 'b' }] }], 2: [] }
    }]
  });
  const ids = [];
  const { walkItems } = require('../../src/main/config.js');
  walkItems(cfg, (it) => { ids.push(it.id); });
  assert.ok(ids.includes('top') && ids.includes('pp') && ids.includes('kk'),
    'profile segments must satisfy the overlay live-id match just like the default wheel');
});
