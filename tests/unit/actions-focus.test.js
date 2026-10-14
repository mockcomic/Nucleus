'use strict';
/* Focus-existing-app gating in the `app` action: when behavior.focusExistingApp
   is on and the value names a running .exe, macro.focusAppWindowByExe must be
   consulted and a successful raise must skip the spawn entirely. child_process,
   electron, and macro.js are stubbed in the require cache before actions.js
   loads (the test-bootstrap recipe) — no processes start and no FFI runs. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const { EventEmitter } = require('events');

/* ---- stub child_process.spawn (records argv, resolves on 'spawn') ---- */
const calls = [];
const cpPath = require.resolve('child_process');
const savedCp = require.cache[cpPath];
const realCp = require('child_process');
require.cache[cpPath] = {
  id: cpPath, filename: cpPath, loaded: true,
  exports: {
    ...realCp,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args: args || [], opts: opts || {} });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  }
};

/* ---- stub electron (actions.js destructures { shell }) ---- */
const electronPath = require.resolve('electron');
const savedElectron = require.cache[electronPath];
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
    shell: { openPath: async () => '', openExternal: async () => '' }
  }
};

/* ---- stub macro.js: focusAppWindowByExe is the one behaviour under test ---- */
const macroPath = require.resolve('../../src/main/macro.js');
const savedMacro = require.cache[macroPath];
const focusCalls = [];
let focusResult = false;
require.cache[macroPath] = {
  id: macroPath, filename: macroPath, loaded: true,
  exports: {
    available: false, loadError: 'stubbed', probeAvailable: false, foregroundProbe: () => null,
    focusAvailable: true,
    focusAppWindowByExe: (base) => { focusCalls.push(base); return focusResult; },
    sendMacro: async () => {}, sendVk: async () => {}, sendChord: async () => {},
    isDown: () => true, vkFor: () => 0, ffi: { available: false }
  }
};

const actionsPath = require.resolve('../../src/main/actions.js');
delete require.cache[actionsPath];
const { executeAction, exeBaseForAppValue } = require(actionsPath);
if (savedCp) require.cache[cpPath] = savedCp; else delete require.cache[cpPath];
if (savedElectron) require.cache[electronPath] = savedElectron; else delete require.cache[electronPath];
if (savedMacro) require.cache[macroPath] = savedMacro; else delete require.cache[macroPath];

const reset = () => { calls.length = 0; focusCalls.length = 0; focusResult = false; };

/* ------------------------------- gating paths ------------------------------- */
test('flag on + focus succeeds: the existing window is raised, nothing spawns', async () => {
  reset();
  focusResult = true;
  await executeAction({ type: 'app', value: 'notepad.exe' }, { focusExistingApp: true });
  assert.deepEqual(focusCalls, ['notepad.exe']);
  assert.equal(calls.length, 0, 'no launch may happen after a successful raise');
});

test('flag on + focus fails: the normal launch proceeds', async () => {
  reset();
  focusResult = false;
  await executeAction({ type: 'app', value: 'notepad.exe' }, { focusExistingApp: true });
  assert.deepEqual(focusCalls, ['notepad.exe']);
  const appCall = calls.find((c) => c.cmd === 'notepad.exe');
  assert.ok(appCall, 'unresolved exe still spawns exactly as before');
});

test('flag off (and absent): the focus helper is never consulted', async () => {
  reset();
  await executeAction({ type: 'app', value: 'notepad.exe' }, { quit: () => {} });
  await executeAction({ type: 'app', value: 'notepad.exe' }, { focusExistingApp: false });
  assert.deepEqual(focusCalls, []);
  assert.ok(calls.length >= 2, 'both launches happened');
});

test('flag on but the value names no .exe: no focus attempt, launch unchanged', async () => {
  reset();
  await executeAction({ type: 'app', value: 'C:\\no\\such\\folder\\app.lnk' }, { focusExistingApp: true });
  await executeAction({ type: 'app', value: 'ms-settings:bluetooth' }, { focusExistingApp: true });
  assert.deepEqual(focusCalls, [], 'lnk and ms-settings values must not reach the window probe');
  assert.equal(calls.length, 2, 'both still go through cmd start as before');
  assert.ok(calls.every((c) => c.cmd === 'cmd.exe' && c.opts.windowsVerbatimArguments === true
    && String(c.args[3] || '').startsWith('start "" ')));
});

/* ------------------- pure basename extraction (exeBaseForAppValue) ---------- */
test('exeBaseForAppValue extracts lowercase basenames from every app shape', () => {
  assert.equal(exeBaseForAppValue('notepad.exe'), 'notepad.exe');
  assert.equal(exeBaseForAppValue('C:\\Windows\\System32\\NOTEPAD.EXE'), 'notepad.exe');
  assert.equal(exeBaseForAppValue('C:\\dir\\app.exe /flag'), 'app.exe');
  assert.equal(exeBaseForAppValue('"C:\\Program Files\\Foo Bar\\foo.exe" --flag x'), 'foo.exe');
  assert.equal(exeBaseForAppValue('"C:\\Program Files\\Foo Bar\\foo.exe"'), 'foo.exe');
  assert.equal(exeBaseForAppValue('calc.exe /3'), 'calc.exe');
  assert.equal(exeBaseForAppValue('  notepad.exe  '), 'notepad.exe');
});

test('exeBaseForAppValue answers null for anything a window cannot be matched to', () => {
  for (const v of ['', '   ', null, undefined, 'C:\\Start Menu\\App.lnk', 'run.bat',
    'script.cmd', 'ms-settings:bluetooth', 'notepad', 'https://google.com']) {
    assert.equal(exeBaseForAppValue(v), null, JSON.stringify(v));
  }
});
