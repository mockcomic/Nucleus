'use strict';
/* Activation logic for app-specific profiles (src/main/profiles.js) — pure,
   Electron-free, exactly like the gaming-mode verdict tests. The probe shape
   mirrors macro.foregroundProbe(): { pid, exe, … } or null. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { pickProfile, hasRings } = require('../../src/main/profiles');

const P = (name, apps, filled = true) => ({
  id: name, name, apps,
  rings: filled ? { 1: [{ id: 's-' + name, type: 'app', value: 'a.exe' }], 2: [] } : { 1: [], 2: [] }
});
const cfg = (...profiles) => ({ profiles });
const probe = (exe, pid = 4242) => ({ pid, exe, winRect: [0, 0, 10, 10], monRect: [0, 0, 10, 10], style: 0 });

/* ------------------------------- matching -------------------------------- */
test('the first profile (list order) whose apps match wins', () => {
  const c = cfg(P('a', ['code.exe']), P('b', ['code.exe', 'blender.exe']));
  assert.equal(pickProfile(c, probe('C:\\x\\Code.exe')).id, 'a');
});

test('exe basename matches case-insensitively, full paths included', () => {
  const c = cfg(P('b', ['blender.exe']));
  assert.equal(pickProfile(c, probe('C:\\Program Files\\Blender Foundation\\Blender.exe')).id, 'b');
  assert.equal(pickProfile(c, probe('BLENDER.EXE')).id, 'b');
});

test('no profile matches → null (the default wheel)', () => {
  const c = cfg(P('a', ['code.exe']));
  assert.equal(pickProfile(c, probe('notepad.exe')), null);
});

/* ------------------------------- fail-soft --------------------------------- */
test('a null probe fails OPEN to the default wheel', () => {
  const c = cfg(P('a', ['code.exe']));
  assert.equal(pickProfile(c, null), null);
});

test('our own foreground pid never activates a profile', () => {
  const c = cfg(P('a', ['electron.exe']));
  assert.equal(pickProfile(c, probe('electron.exe', 999), 999), null);
  assert.equal(pickProfile(c, probe('electron.exe', 111), 999).id, 'a');   // another process: fine
});

test('empty / missing profiles list, junk config, missing exe → null', () => {
  assert.equal(pickProfile(cfg(), probe('a.exe'), 1), null);
  assert.equal(pickProfile(cfg(null, 42, 'x'), probe('a.exe'), 1), null);
  assert.equal(pickProfile({ profiles: 'nope' }, probe('a.exe'), 1), null);
  assert.equal(pickProfile(null, probe('a.exe'), 1), null);
  assert.equal(pickProfile(cfg(P('a', ['a.exe'])), { pid: 5, exe: '' }, 1), null);
});

/* ------------------------------ inert entries ----------------------------- */
test('a profile with no apps listed never activates', () => {
  const c = cfg(P('empty', []), P('full', ['x.exe']));
  assert.equal(pickProfile(c, probe('x.exe')).id, 'full');
});

test('a profile with empty rings is skipped — it must not blank the wheel', () => {
  const c = cfg(P('blank', ['code.exe'], false), P('full', ['code.exe']));
  assert.equal(pickProfile(c, probe('code.exe')).id, 'full');
  const onlyBlank = cfg(P('blank', ['code.exe'], false));
  assert.equal(pickProfile(onlyBlank, probe('code.exe')), null);
});

/* -------------------------------- hasRings -------------------------------- */
test('hasRings: any non-empty ring array counts; junk does not', () => {
  assert.equal(hasRings({ rings: { 1: [], 2: [{ id: 'a' }] } }), true);
  assert.equal(hasRings({ rings: { 1: [], 2: [] } }), false);
  assert.equal(hasRings({ rings: {} }), false);
  assert.equal(hasRings({ rings: null }), false);
  assert.equal(hasRings(null), false);
});
