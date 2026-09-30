'use strict';
/* Unit tests for the pure half of src/main/gamemode.js — config sanitation,
   the fullscreen/app-list verdict, and the pause ladder. The watcher's Win32
   probe is injected, so nothing here touches Electron or koffi. */
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cleanAppName, sanitizeGameMode, rectCovers, matchAppList, shouldPause, pauseReason,
  PauseLadder
} = require('../../src/main/gamemode');

const FULL = { winRect: [0, 0, 1920, 1080], monRect: [0, 0, 1920, 1080] };
const win = (extra = {}) => ({ pid: 4242, exe: 'game.exe', style: 0x96000000, ...FULL, ...extra });

/* ------------------------------ sanitizeGameMode --------------------------- */
test('sanitizeGameMode defaults are off and empty', () => {
  for (const junk of [undefined, null, {}, 'x', 42, []]) {
    const gm = sanitizeGameMode(junk);
    assert.deepEqual(gm, { enabled: false, apps: [] }, `input ${JSON.stringify(junk)}`);
  }
});

test('sanitizeGameMode keeps enabled true only for literal true', () => {
  assert.equal(sanitizeGameMode({ enabled: true }).enabled, true);
  assert.equal(sanitizeGameMode({ enabled: 'true' }).enabled, false);
  assert.equal(sanitizeGameMode({ enabled: 1 }).enabled, false);
});

test('cleanAppName normalizes paths, case, and quotes; rejects junk', () => {
  assert.equal(cleanAppName('  Game.EXE '), 'game.exe');
  assert.equal(cleanAppName('C:\\Games\\Foo.exe'), 'foo.exe');
  assert.equal(cleanAppName('C:/Games/Foo.exe'), 'foo.exe');
  assert.equal(cleanAppName('"Fortnite.exe"'), 'fortnite.exe');
  assert.equal(cleanAppName('my game 2.exe'), 'my game 2.exe');
  assert.equal(cleanAppName(''), null);
  assert.equal(cleanAppName('   '), null);
  assert.equal(cleanAppName('bad|name'), null);
  assert.equal(cleanAppName('x'.repeat(65)), null);
  assert.equal(cleanAppName(null), null);
  assert.equal(cleanAppName(42), null);
});

test('sanitizeGameMode apps: dedupes, drops junk, caps at 64', () => {
  const gm = sanitizeGameMode({
    enabled: true,
    apps: ['Foo.exe', 'C:\\x\\foo.exe', ' BAR.EXE ', 'bad|name', '', 'baz.exe', 'baz.exe']
  });
  assert.deepEqual(gm.apps, ['foo.exe', 'bar.exe', 'baz.exe']);
  const many = sanitizeGameMode({ apps: Array.from({ length: 100 }, (_, i) => `g${i}.exe`) });
  assert.equal(many.apps.length, 64);
  assert.equal(sanitizeGameMode({ apps: 'not-an-array' }).apps.length, 0);
  assert.equal(sanitizeGameMode({ apps: [null, 3, {}, []] }).apps.length, 0);
});

/* ---------------------------------- rects ---------------------------------- */
test('rectCovers: exact cover true, inset false, offsets multi-monitor true', () => {
  assert.equal(rectCovers([0, 0, 1920, 1080], [0, 0, 1920, 1080]), true);
  assert.equal(rectCovers([-2, -2, 1922, 1082], [0, 0, 1920, 1080]), true);   // spills over
  assert.equal(rectCovers([8, 8, 1912, 1072], [0, 0, 1920, 1080]), false);    // maximized inset
  assert.equal(rectCovers([2560, 0, 4480, 1080], [2560, 0, 4480, 1080]), true); // second monitor
  assert.equal(rectCovers([0, 0, 1000, 1000], [0, 0, 1920, 1080]), false);    // reversed containment
  assert.equal(rectCovers(null, [0, 0, 1, 1]), false);
  assert.equal(rectCovers([0, 0, 1, 1], undefined), false);
});

/* ------------------------------- shouldPause -------------------------------- */
test('shouldPause never fires when gaming mode is off', () => {
  assert.equal(shouldPause(win(), { enabled: false, apps: ['game.exe'] }, 1), false);
  assert.equal(shouldPause(win(), undefined, 1), false);
  assert.equal(shouldPause(win(), null, 1), false);
});

test('shouldPause: fullscreen pauses; windowed app-list hit pauses; windowed other does not', () => {
  const gm = { enabled: true, apps: ['fortnite.exe'] };
  assert.equal(shouldPause(win(), gm, 1), true);                        // fullscreen
  assert.equal(shouldPause(win({ ...FULL, exe: 'fortnite.exe', winRect: [10, 10, 800, 600] }), gm, 1), true); // listed, windowed
  assert.equal(shouldPause(win({ exe: 'chrome.exe', winRect: [100, 100, 900, 600] }), gm, 1), false); // unlisted, windowed
});

test('shouldPause fail-open: null probe never pauses', () => {
  assert.equal(shouldPause(null, { enabled: true, apps: ['a.exe'] }, 1), false);
});

test('shouldPause: our own pid never pauses (overlay / Settings windows)', () => {
  assert.equal(shouldPause(win({ pid: 999 }), { enabled: true, apps: ['game.exe'] }, 999), false);
});

test('shouldPause: explorer.exe desktop never pauses, but a listed path could not reach it', () => {
  assert.equal(shouldPause(win({ exe: 'explorer.exe' }), { enabled: true, apps: [] }, 1), false);
  assert.equal(shouldPause(win({ exe: 'EXPLORER.EXE' }), { enabled: true, apps: [] }, 1), false);
});

test('shouldPause: child windows are not games even at full coverage', () => {
  assert.equal(shouldPause(win({ style: 0x40000000, exe: 'weird.exe' }), { enabled: true, apps: [] }, 1), false);
});

test('shouldPause: maximized (inset) window does not count as fullscreen', () => {
  assert.equal(shouldPause(win({ ...FULL, winRect: [8, 8, 1912, 1072], exe: 'app.exe' }), { enabled: true, apps: [] }, 1), false);
});

test('shouldPause: unreadable exe name still allows fullscreen pause', () => {
  assert.equal(shouldPause(win({ exe: '' }), { enabled: true, apps: [] }, 1), true);
  assert.equal(shouldPause(win({ exe: '', winRect: [100, 100, 900, 600] }), { enabled: true, apps: [] }, 1), false);
});

/* ----------------------------- matchAppList/reason -------------------------- */
test('matchAppList is case-insensitive and empty-safe', () => {
  assert.equal(matchAppList('Foo.EXE', ['foo.exe']), true);
  assert.equal(matchAppList('foo.exe', []), false);
  assert.equal(matchAppList('', ['foo.exe']), false);
  assert.equal(matchAppList(null, ['foo.exe']), false);
  assert.equal(matchAppList('foo.exe', null), false);
});

test('pauseReason reports the exe for app-list hits, else fullscreen', () => {
  const gm = { enabled: true, apps: ['fortnite.exe'] };
  assert.equal(pauseReason({ exe: 'Fortnite.EXE' }, gm), 'fortnite.exe');
  assert.equal(pauseReason({ exe: 'game.exe' }, gm), 'fullscreen');
  assert.equal(pauseReason(null, gm), null);
});

/* -------------------------------- ladder ------------------------------------ */
test('PauseLadder needs 2 consecutive positives to pause, one negative to resume', () => {
  const l = new PauseLadder(2);
  assert.equal(l.tick(true), null);           // first positive — not yet
  assert.equal(l.tick(true), 'pause');        // second consecutive — pause
  assert.equal(l.tick(true), null);           // stays paused
  assert.equal(l.tick(false), 'resume');      // a single negative resumes (instant alt-tab recovery)
  assert.equal(l.tick(false), null);          // already unpaused
});

test('PauseLadder restarts the positive streak after an interleaved negative', () => {
  const l = new PauseLadder(2);
  assert.equal(l.tick(true), null);
  assert.equal(l.tick(false), null);          // focus blip breaks the streak
  assert.equal(l.tick(true), null);           // counting starts over
  assert.equal(l.tick(true), 'pause');
});
