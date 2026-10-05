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
});
