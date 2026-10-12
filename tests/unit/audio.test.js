'use strict';
/* audio.js pure layer (see test-bootstrap): GUID packing, flow validation,
   volume conversions, id sanitizing, session grouping, and the argument
   pre-checks that must reject BEFORE any COM call. Nothing here touches the
   audio stack: every public function is only exercised along paths that
   return before the (lazy) COM gate — the real FFI surface is verified on a
   live machine, never in node:test. */
const test = require('node:test');
const assert = require('node:assert/strict');

const audio = require('../../src/main/audio.js');

/* ---- guidBytes ---- */
test('guidBytes packs the wire layout (LE Data1-3, verbatim Data4)', () => {
  // CLSID_MMDeviceEnumerator — the byte order that decides whether COM finds
  // the class at all.
  const b = audio._guidBytes('bcde0395-e52f-467c-8e3d-c4579291692e');
  assert.equal(b.length, 16);
  assert.equal(b.toString('hex'), '9503debc2fe57c46' + '8e3dc4579291692e');
});

test('guidBytes round-trips the volume interface IID', () => {
  assert.equal(audio._guidBytes('5cdf2c82-841e-4546-9722-0cf74078229a').toString('hex'),
    '822cdf5c1e84464597220cf74078229a');
});

test('guidBytes refuses malformed literals', () => {
  for (const junk of ['', 'x', 'ffffffff-ffff-ffff-ffff', 'not-a-guid-at-all-at-all']) {
    assert.throws(() => audio._guidBytes(junk), /bad GUID literal/);
  }
});

/* ---- parseFlow ---- */
test('parseFlow accepts both the header and the UI names', () => {
  assert.equal(audio._parseFlow('render'), 0);
  assert.equal(audio._parseFlow('output'), 0);
  assert.equal(audio._parseFlow('OUTPUT'), 0);
  assert.equal(audio._parseFlow(' capture '), 1);
  assert.equal(audio._parseFlow('input'), 1);
});

test('parseFlow rejects everything else (never a guess)', () => {
  for (const junk of [null, undefined, '', 'all', 0, 1, 'eRender?']) {
    assert.equal(audio._parseFlow(junk), null);
  }
});

/* ---- volume conversions ---- */
test('percent/scalar round-trip through the Windows float', () => {
  assert.equal(audio._scalarToPercent(0.25999999046325684), 26);
  assert.equal(audio._scalarToPercent(1), 100);
  assert.equal(audio._scalarToPercent(0), 0);
  assert.equal(audio._percentToScalar(40), 0.4);
  assert.equal(audio._percentToScalar(150), 1);        // clamped, not modulo'd
  assert.equal(audio._percentToScalar(-3), 0);
});

test('clampPercent keeps only honest numbers', () => {
  assert.equal(audio._clampPercent(26.4), 26);
  assert.equal(audio._clampPercent(-5), 0);
  assert.equal(audio._clampPercent(100.6), 101 > 100 ? 100 : 101);
  assert.equal(audio._clampPercent('40'), null);       // strings are not numbers
  assert.equal(audio._clampPercent(NaN), null);
  assert.equal(audio._clampPercent(Infinity), null);
});

/* ---- sanitizeDeviceId ---- */
test('sanitizeDeviceId takes real endpoint ids and nothing else', () => {
  const id = '{0.0.0.00000000}.{0513e965-c2aa-40eb-8cbf-951f737d4e}';
  assert.equal(audio._sanitizeDeviceId('  ' + id + '  '), id);   // trim only
  assert.equal(audio._sanitizeDeviceId(''), '');
  assert.equal(audio._sanitizeDeviceId(null), '');
  assert.equal(audio._sanitizeDeviceId('line\nbreak'), '');      // no control chars
  assert.equal(audio._sanitizeDeviceId('embed\x01nul'), '');
  assert.equal(audio._sanitizeDeviceId('x'.repeat(513)), '');    // length cap
  assert.equal(audio._sanitizeDeviceId('ünïcödé'), '');          // ASCII-only
});

/* ---- fallbackName ---- */
test('fallbackName trims an id into something a human can scan', () => {
  assert.equal(audio._fallbackName('{0.0.1.00000000}::{b0b1}'), 'b0b1');
  assert.equal(audio._fallbackName('{0.0.0.00000000}.{deadbeef}'), '0.0.0.00000000}.deadbeef'.replace(/[{}]/g, ''));
  assert.equal(audio._fallbackName('x'.repeat(200)).length, 60);
  assert.equal(audio._fallbackName(''), '');
});

/* ---- filterHiddenDevices (behavior.audioHidden filtering, ipc.js side) ---- */
const dev = (id, isDefault) => ({ id, name: id, isDefault: !!isDefault });
test('filterHiddenDevices drops hidden ids and keeps everything else', () => {
  const list = [dev('a'), dev('b', true), dev('c')];
  assert.deepEqual(audio._filterHiddenDevices(list, [{ id: 'a', name: 'A' }]).map((d) => d.id), ['b', 'c']);
  assert.deepEqual(audio._filterHiddenDevices(list, []).map((d) => d.id), ['a', 'b', 'c']);
  assert.deepEqual(audio._filterHiddenDevices(list, null).map((d) => d.id), ['a', 'b', 'c']);
});

test('the CURRENT default is never hidden, whatever the hidden list claims', () => {
  const list = [dev('a', true), dev('b')];
  assert.deepEqual(audio._filterHiddenDevices(list, [{ id: 'a' }]).map((d) => d.id), ['a', 'b'],
    'a picker that could hide the live default would misreport Windows');
  // The exemption is exactly isDefault — a hidden peer is still dropped.
  assert.deepEqual(audio._filterHiddenDevices(list, [{ id: 'a' }, { id: 'b' }]).map((d) => d.id), ['a']);
});

test('filterHiddenDevices survives junk lists and junk hidden entries', () => {
  const list = [dev('a'), null, dev('b', true)];
  // 'a-string' hides nothing (ids only come from {id} objects); {id:'b'} hits
  // the exempt default; null rows pass through untouched.
  assert.deepEqual(audio._filterHiddenDevices(list, ['a-string', { id: '' }, { nope: 1 }, { id: 'b' }]).map((d) => (d && d.id) || d), ['a', null, 'b']);
  assert.deepEqual(audio._filterHiddenDevices('not-a-list', [{ id: 'x' }]), []);
});

/* ---- groupSessions (Volume-Mixer semantics) ---- */
const row = (o) => Object.assign({ pid: 1, title: '', exe: '', isSystem: false, volume: 50, muted: false }, o);

test('groupSessions folds a process\'s streams into one row', () => {
  const g = audio._groupSessions([
    row({ pid: 5, exe: 'a.exe', volume: 50, muted: false }),
    row({ pid: 5, title: 'Stream Two', exe: 'a.exe', volume: 30, muted: true })
  ]);
  assert.equal(g.length, 1);
  assert.equal(g[0].sessions, 2);
  assert.equal(g[0].title, 'Stream Two');              // a named stream labels the row
  assert.equal(g[0].muted, false);                     // one audible stream keeps the row audible
});

test('groupSessions keeps System Sounds separate and drops orphan pids', () => {
  const g = audio._groupSessions([
    row({ pid: 7, exe: 's.exe', isSystem: true, volume: 11, muted: true }),
    row({ pid: 0 }),
    row({ pid: 3, exe: 'z.exe' })
  ]);
  // Mixer order: apps first (alphabetical), System Sounds last.
  assert.deepEqual(g.map((r) => [r.pid, r.isSystem]), [[3, false], [7, true]]);
});

test('groupSessions sorts audibly: apps first (by label), system sounds last', () => {
  const g = audio._groupSessions([
    row({ pid: 7, isSystem: true, exe: 'sys.exe' }),
    row({ pid: 2, exe: 'zebra.exe' }),
    row({ pid: 1, exe: 'apple.exe' })
  ]);
  assert.deepEqual(g.map((r) => r.exe), ['apple.exe', 'zebra.exe', 'sys.exe']);
});

/* ---- the policy ladder (source of the device-switch identity) ----
   A route must carry its OWN (clsid, iid, slot) triple: the coclass only
   serves its paired IID (cross-asking answers E_NOINTERFACE), and the two
   variants place SetDefaultEndpoint one slot apart (the Vista one has no
   ResetDeviceFormat before it). A half-swapped triple either fails to
   create — which is how "cannot change the output device" ships — or calls
   a wrong method through a wrong-arity call. The registered pairings are
   measured facts (verified live, incl. an actual default flip read back
   through the documented enumerator, on Windows 11 25H2 / 10.0.26200). */
test('every policy route is a complete (clsid, iid, slot) triple', () => {
  const routes = audio._policyRoutes;
  assert.ok(Array.isArray(routes) && routes.length >= 4);
  const keys = new Set();
  for (const r of routes) {
    assert.ok(typeof r.key === 'string' && r.key && !keys.has(r.key), 'unique route key: ' + r.key);
    keys.add(r.key);
    assert.equal(typeof r.run, 'function', 'route ' + r.key + ' is callable');
    assert.ok(Number.isInteger(r.slot) && r.slot >= 3, 'route ' + r.key + ' carries its own vtable slot');
    assert.deepEqual([...audio._guidBytes(r.clsid)].length, 16);   // malformed literals throw
    assert.deepEqual([...audio._guidBytes(r.iid)].length, 16);
  }
});

test('the registered modern pairs keep their measured GUIDs and slots', () => {
  const byKey = Object.fromEntries(audio._policyRoutes.map((r) => [r.key, r]));
  assert.deepEqual(
    [byKey.client.clsid, byKey.client.iid, byKey.client.slot],
    ['870af99c-171d-4f9e-af0d-e63df40c2bc9', 'f8679f50-850a-41cf-9c72-430f290290c8', 13]);
  assert.deepEqual(
    [byKey.vista.clsid, byKey.vista.iid, byKey.vista.slot],
    ['294935ce-f637-4e7c-a41b-ab255460b862', '568b9108-44bf-40b4-9006-86afe5b5a620', 12]);
  // Factory fallbacks must carry the SAME pair as their registry route — the
  // bug that shipped was a ladder built on identities the image never had.
  assert.equal(byKey['client-factory'].clsid, byKey.client.clsid);
  assert.equal(byKey['client-factory'].iid, byKey.client.iid);
  assert.equal(byKey['client-factory'].slot, byKey.client.slot);
  assert.equal(byKey['vista-factory'].clsid, byKey.vista.clsid);
  assert.equal(byKey['vista-factory'].iid, byKey.vista.iid);
  assert.equal(byKey['vista-factory'].slot, byKey.vista.slot);
  // The registered-identity routes run before the legacy pair.
  assert.ok(audio._policyRoutes.findIndex((r) => r.key === 'client') <
            audio._policyRoutes.findIndex((r) => r.key === 'registry'));
});

/* ---- argument pre-checks (must reject before the COM gate) ---- */
test('bad arguments are rejected without ever waking COM', () => {
  assert.match(audio.listDevices('sideways').error, /render or capture/);
  assert.match(audio.setDefaultDevice(null, 'x').error, /render or capture/);
  assert.match(audio.setDefaultDevice('render', 'li\nne').error, /not usable/);
  assert.match(audio.getLevels('nope').error, /render or capture/);
  assert.match(audio.setLevels('render', {}).error, /nothing to change/);
  assert.match(audio.setLevels('render', { volume: 'loud' }).error, /0–100/);
  assert.match(audio.setSession('abc', { volume: 5 }).error, /process id/);
  assert.match(audio.setSession(7, {}).error, /nothing to change/);
});

test('available() answers the {ok}/{ok:false,reason} contract', () => {
  const a = audio.available();
  assert.equal(typeof a, 'object');
  if (process.platform === 'win32') assert.ok(a.ok === true || (a.ok === false && typeof a.reason === 'string'));
  else assert.equal(a.ok, false);
  // The surfaces word their own advice from this flag, so it is part of the
  // contract — never an optional extra that silently disappears.
  assert.equal(typeof a.canSetDefault, 'boolean');
  if (a.ok === true) assert.equal(typeof a.canSetDefault, 'boolean');
});

/* ---- the refusal copy, as a source-scan invariant (same style as the
   owner-list assertions in ipc-gating.test.js). The message IS the feature
   here: an OS-wide refusal must not claim, in the same breath, that some other
   app can still do what it just said no app can do — and every surface that
   shows the refusal has to name a next step that actually exists on it. ---- */
const fs = require('node:fs');
const path = require('node:path');
const readSrc = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

test('the refused-switch copy names its escape hatch without contradicting itself', () => {
  const main = readSrc('src', 'main', 'audio.js');
  const settings = readSrc('src', 'renderer', 'settings', 'settings.js');
  const wheel = readSrc('src', 'renderer', 'wheel', 'wheel.js');

  // main: the human line states the limit in plain words; the COM jargon and
  // the HRESULT live in `detail`, which is for the log, not for the toast.
  assert.match(main, /does not let apps change the default audio device/);
  assert.ok(!/error: '[^']*audio-policy/.test(main), 'the user-facing error line must not carry COM jargon');
  assert.match(main, /detail: 'audio-policy object not available/);

  // The retired tail ("… Windows sound settings (below) can do it by hand")
  // contradicted main's own refusal and pointed at a direction, not a control.
  assert.ok(!settings.includes('Windows sound settings (below)'), 'settings.js: the retired contradictory advice');
  assert.ok(!wheel.includes('can do it by hand'), 'wheel.js: the retired advice line');

  // Both surfaces special-case the OS-wide refusal and point at a door that is
  // really on that surface: the Settings tab has the button, the card points at
  // the system page because it carries no button of its own.
  assert.ok(settings.includes("'policy_unavailable'"), 'settings.js must word advice for the OS-wide refusal');
  assert.ok(settings.includes('Open Windows sound settings'), 'settings.js must name the button it points at');
  assert.ok(wheel.includes("'policy_unavailable'"), 'wheel.js must word advice for the OS-wide refusal');
  assert.ok(wheel.includes('Windows sound settings'), 'the card has no button: it has to name the system page');

  // The flag that lets a surface admit the refusal before the doomed click.
  assert.ok(settings.includes('canSetDefault'), 'settings.js must honour canSetDefault up front');
  assert.ok(wheel.includes('canSetDefault'), 'the card must honour canSetDefault on opening');
});
