'use strict';
/* Import-approval regression tests (security: an imported config must not
   silently make shell commands launchable). Drives the real 'config:import'
   handler through a stubbed electron dialog; the store fake records what
   would have replaced the live config. Electron stub precedes any
   src/main require (test-bootstrap recipe). */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const APP_ROOT = path.join(os.tmpdir(), 'nucleus-app-import');
const settingsUrl = pathToFileURL(path.join(APP_ROOT, 'src', 'renderer', 'settings', 'index.html')).href;

const electronPath = require.resolve('electron');
const dialogStub = { showOpenDialog: async () => ({ canceled: false, filePaths: [] }), showMessageBox: async () => ({ response: 1 }) };
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', getAppPath: () => APP_ROOT },
    ipcMain: { on: () => {}, handle: (ch, fn) => { handlers.set(ch, fn); } },
    dialog: dialogStub, shell: {}, BrowserWindow: function () { return {}; },
    screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) }
  }
};
const handlers = new Map();
const { registerIpc } = require('../../src/main/ipc.js');

let applied = [];
function makeDeps() {
  const store = {
    get: () => ({ hotkey: 'ctrl+alt+space', rings: {}, appearance: { colors: {} }, behavior: {} }),
    set: (cfg) => { applied.push(cfg); return cfg; },
    rev: 0, on: () => {}, broken: false, backupDir: () => os.tmpdir(), listBackups: () => []
  };
  return {
    deps: {
      store, hotkeyMgr: {},
      overlay: { hide: () => {} },
      settings: { open: () => {}, send: () => {}, win: null },
      welcome: { close: () => {} }, tray: { balloon: () => {}, update: () => {} },
      getState: (k, d) => d, setState: () => {},
      registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
    }
  };
}

function tmpJson(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-imp-'));
  const p = path.join(dir, 'import.json');
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

async function runImport(file, boxResponse) {
  applied = [];
  dialogStub.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
  const asked = [];
  dialogStub.showMessageBox = async (...args) => { const opts = args.find((a) => a && typeof a === 'object'); asked.push(opts); return { response: boxResponse }; };
  registerIpc(makeDeps().deps);
  const r = await handlers.get('config:import')({ sender: {}, senderFrame: { url: settingsUrl } });
  return { r, asked };
}

const exeCfg = { rings: { '1': [{ type: 'command', label: 'nuke', value: 'reg delete HKCU\\Foo /f' }] }, behavior: {} };

test('importing a config with executable items asks first, naming the item', async () => {
  const { r, asked } = await runImport(tmpJson(exeCfg), 0);         // user clicked "Import anyway"
  assert.equal(asked.length, 1, 'the approval dialog must have been shown');
  assert.match(asked[0].detail, /nuke/);
  assert.match(asked[0].detail, /reg delete/);
  assert.equal(asked[0].defaultId, 1);                              // Cancel is the safe default
  assert.equal(r.ok, true);
  assert.equal(applied.length, 1);                                  // and only then applied
});

test('cancelling the approval aborts the import — the store is untouched', async () => {
  const { r, asked } = await runImport(tmpJson(exeCfg), 1);         // Cancel
  assert.equal(asked.length, 1);
  assert.equal(r.ok, false);
  assert.equal(r.canceled, true);
  assert.deepEqual(applied, [], 'a refused import must not replace the config');
});

test('a config with no executable items imports without a dialog', async () => {
  const { r, asked } = await runImport(tmpJson({ rings: { '1': [{ type: 'setting', label: 'vol', value: 'mixer' }] }, behavior: {} }), 0);
  assert.equal(asked.length, 0);
  assert.equal(r.ok, true, r.error || JSON.stringify(r));
});

test('malformed import files fail with a clear error, never a crash', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-imp-'));
  const p = path.join(dir, 'junk.json');
  fs.writeFileSync(p, '{not json');
  const { r } = await runImport(p, 0);
  assert.equal(r.ok, false);
  assert.match(r.error, /Import failed/);
});
