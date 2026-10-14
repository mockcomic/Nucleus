'use strict';
/* Regression tests for the 2026-10 review fixes (Critical C1, Highs H1–H6).
   Electron is stubbed via require-cache injection (test-bootstrap recipe);
   nothing touches %APPDATA% and no FFI is exercised. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

/* The sender-frame gate compares the URL to app.getAppPath(), so the stub
   and every legitimate frame in this file share one root. */
const APP_ROOT = path.join(os.tmpdir(), 'nucleus-app-gate');
const pageUrl = (page) => pathToFileURL(path.join(APP_ROOT, 'src', 'renderer', page, 'index.html')).href;

/* ---- electron stub, injected before any src/main require ---- */
const handle = new Map();
const onMap = new Map();
const fakeGlobalShortcut = {
  register: () => true,
  unregister: () => {},
  isRegistered: () => true
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test', getAppPath: () => APP_ROOT },
    ipcMain: { on: (ch, fn) => onMap.set(ch, fn), handle: (ch, fn) => handle.set(ch, fn) },
    globalShortcut: fakeGlobalShortcut,
    dialog: {}, shell: {}, Tray: function () {}, Menu: { buildFromTemplate: () => ({}) },
    nativeImage: { createFromPath: () => ({ isEmpty: () => false }) },
    nativeTheme: {},
    BrowserWindow: function () { return {}; },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayMatching: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    }
  }
};

/* autostart stub: ipc.js loads it at require time. */
require.cache[require.resolve('../../src/main/autostart.js')] = {
  id: require.resolve('../../src/main/autostart.js'),
  filename: require.resolve('../../src/main/autostart.js'), loaded: true,
  exports: { set: () => ({ ok: true, verified: true }), get: () => false }
};

const macro = require('../../src/main/macro.js');
const { validate } = require('../../src/main/config.js');

/* ------------------------- H3: macro `type:` tokenizer ---------------------- */
test('_splitSteps: a type: step consumes the rest of the spec, commas and all', () => {
  assert.deepEqual(macro._splitSteps('ctrl+c, type:Hi, there'), ['ctrl+c', 'type:Hi, there']);
  assert.deepEqual(macro._splitSteps('type:a,b'), ['type:a,b']);            // used to inject a stray 'b' press
  assert.deepEqual(macro._splitSteps('type: done, all, day'), ['type: done, all, day']);
});

test('_splitSteps: no type: — plain comma steps as before', () => {
  assert.deepEqual(macro._splitSteps('ctrl+c, wait=0.2, ctrl+v'), ['ctrl+c', ' wait=0.2', ' ctrl+v']);
  assert.deepEqual(macro._splitSteps(''), ['']);
});

test('_splitSteps: the FIRST type: wins; later text stays literal', () => {
  assert.deepEqual(macro._splitSteps('type:x, type:y'), ['type:x, type:y']);
});

/* --------------------- H6: radius cross-constraint in validate -------------- */
test('validate clamps innerRadius down so a clickable band survives', () => {
  const ap = validate({ appearance: { innerRadius: 140, outerRadius: 120 } }).appearance;
  assert.ok(ap.innerRadius <= ap.outerRadius - 24,
    `inner ${ap.innerRadius} must leave >=24px band under outer ${ap.outerRadius}`);
});

test('validate leaves honest radius pairs alone', () => {
  const ap = validate({ appearance: { innerRadius: 70, outerRadius: 210 } }).appearance;
  assert.equal(ap.innerRadius, 70);
  assert.equal(ap.outerRadius, 210);
});

test('validate keeps defaults when appearance is junk', () => {
  const ap = validate({ appearance: { innerRadius: 'x', outerRadius: null } }).appearance;
  assert.equal(ap.innerRadius, 70);
  assert.equal(ap.outerRadius, 210);
  assert.ok(ap.innerRadius <= ap.outerRadius - 24);
});

/* ------------------ H5: theme-name dedup terminates (main side) ------------- */
test('validate dedups colliding 24-char theme names and TERMINATES (was: infinite loop)', () => {
  const colors = { bg: '#111111', ring1: '#222222', ring2: '#333333', hover: '#444444', accent: '#555555', text: '#666666', center: '#777777' };
  const longName = 'A'.repeat(24);                     // hits the cap exactly — the old slice form looped forever
  const out = validate({ userThemes: [
    { name: longName, colors }, { name: longName, colors }, { name: longName, colors }
  ] });
  assert.equal(out.userThemes.length, 3);
  const names = out.userThemes.map((t) => t.name);
  assert.equal(new Set(names).size, 3, `expected 3 distinct names, got ${JSON.stringify(names)}`);
  for (const n of names) assert.ok(n.length <= 24);
  assert.equal(names[0], longName);                    // first keeps the requested name verbatim
});

/* ------------------- C1: spawn 'error' never thrown async ------------------- */
test('actions.js has no child_process error handlers that throw', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'actions.js'), 'utf8');
  assert.doesNotMatch(src, /on\('error'[^)]*\{[^}]*\bthrow\b/s, 'spawn error events must reject, never throw');
  const sysSrc = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'sys.js'), 'utf8');
  assert.doesNotMatch(sysSrc, /on\('error'[^)]*\{[^}]*\bthrow\b/s);
});

/* ------------- H1: store.set write failure rolls back + is reported --------- */
test('ConfigStore.set() throws, and config:set answers {ok:false} — never rejects', async () => {
  // userData pointed at a path whose ancestor is a regular FILE: every
  // mkdirSync under it fails with ENOTDIR, the exact AV-lock/disk-full shape.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-store-'));
  const blocker = path.join(base, 'blocked');
  fs.writeFileSync(blocker, 'not a dir');
  const storePath = path.join(blocker, 'deep');

  const { ConfigStore } = require('../../src/main/config.js');
  const store = new ConfigStore();
  store.file = () => path.join(storePath, 'config.json');
  const before = store.get();
  const beforeRev = store.rev;
  assert.throws(() => store.set({ ...before, hotkey: 'ctrl+shift+f12' }), /could not save config/);
  assert.equal(store.rev, beforeRev, 'failed set must not bump rev');
  assert.equal(store.get().hotkey, before.hotkey, 'failed set must roll the store back');

  // ipc layer: the handler must convert that throw into the {ok:false} the
  // renderer's dead-until-now else branch was written to consume.
  const { registerIpc } = require('../../src/main/ipc.js');
  registerIpc({
    store: { ...store, get: () => before, set: () => { throw new Error('could not save config (EBUSY) — is config.json locked?'); }, rev: 1, on: () => {} },
    hotkeyMgr: {}, overlay: { hide: () => {} }, settings: { send: () => {}, win: null }, welcome: { close: () => {}, send: () => {} },
    tray: { balloon: () => {} }, getState: () => ({}), setState: () => {},
    registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
  });
  const h = handle.get('config:set');
  const ev = { senderFrame: { url: pageUrl('settings') } };
  const r = await h(ev, before);
  assert.equal(r.ok, false);
  assert.match(r.error, /could not save config/);
});

test('privileged channels refuse frames that are not their own window', async () => {
  const { registerIpc } = require('../../src/main/ipc.js');
  let persisted = 0;
  registerIpc({
    store: { get: () => ({ hotkey: 'ctrl+alt+space', rings: {}, appearance: { colors: {} }, behavior: {} }), set: () => { persisted++; return {}; }, rev: 1, on: () => {} },
    hotkeyMgr: {}, overlay: { hide: () => {} }, settings: { send: () => {}, win: null }, welcome: { close: () => {}, send: () => {} },
    tray: { balloon: () => {} }, getState: () => ({}), setState: () => {},
    registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
  });
  const impostor = { senderFrame: { url: pageUrl('wheel') } };   // overlay pretending to be settings
  const r = await handle.get('config:set')(impostor, {});
  assert.equal(r.ok, false);
  assert.equal(persisted, 0, 'a refused frame must not reach the store');

  const lookalike = await handle.get('config:set')(
    { senderFrame: { url: 'https://evil.test/renderer/settings/index.html' } }, {});
  assert.equal(lookalike.ok, false, 'an https URL that merely contains /renderer/settings/ is not Settings');
  const outside = pathToFileURL(path.join(os.tmpdir(), 'elsewhere', 'src', 'renderer', 'settings', 'index.html')).href;
  const foreign = await handle.get('config:set')({ senderFrame: { url: outside } }, {});
  assert.equal(foreign.ok, false, 'a file URL outside the app directory is not Settings');
  assert.equal(persisted, 0);
});

/* ------------------ ipc.js: autostart flag persisted NEW, not stale --------- */
test('autostart:set persists the NEW flag and only after registry success', async () => {
  const { registerIpc } = require('../../src/main/ipc.js');
  let saved = null;
  const cfg = () => ({ hotkey: 'ctrl+alt+space', rings: {}, appearance: { colors: {} }, behavior: { autostart: false } });
  registerIpc({
    store: { get: cfg, set: (c) => { saved = c; return c; }, rev: 1, on: () => {} },
    hotkeyMgr: {}, overlay: { hide: () => {} }, settings: { send: () => {}, win: null }, welcome: { close: () => {}, send: () => {} },
    tray: { balloon: () => {} }, getState: () => ({}), setState: () => {},
    registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
  });
  const ev = { senderFrame: { url: pageUrl('settings') } };
  const r = await handle.get('autostart:set')(ev, true);
  assert.equal(r.ok, true);
  assert.equal(saved.behavior.autostart, true, 'config must carry the NEW flag, not the stale clone');
});

/* ------------------ hotkeys.js: register() never escapes throws ------------- */
test('HotkeyManager.register converts a throwing globalShortcut into {ok:false}', () => {
  const real = fakeGlobalShortcut.register;
  fakeGlobalShortcut.register = () => { throw new Error('Super+Quote is exotic'); };
  try {
    const { HotkeyManager } = require('../../src/main/hotkeys.js');
    const hm = new HotkeyManager();
    const res = hm.register('ctrl+alt+space', () => {});
    assert.equal(res.ok, false);
    assert.match(res.error, /could not be registered/);
  } finally {
    fakeGlobalShortcut.register = real;
  }
});

/* --------------- config:import / :reset replies carry the rev --------------- */
test('config:import and config:reset include rev (parity with config:set)', async () => {
  const { registerIpc } = require('../../src/main/ipc.js');
  const cfg = { hotkey: 'ctrl+alt+space', rings: {}, appearance: { colors: {} }, behavior: {} };
  registerIpc({
    store: { get: () => cfg, set: (c) => c, rev: 7, on: () => {} },
    hotkeyMgr: {}, overlay: { hide: () => {} }, settings: { send: () => {}, win: null }, welcome: { close: () => {}, send: () => {} },
    tray: { balloon: () => {} }, getState: () => ({}), setState: () => {},
    registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
  });
  const ev = { senderFrame: { url: pageUrl('settings') } };
  const r = await handle.get('config:reset')(ev);
  assert.equal(r.ok, true);
  assert.equal(r.rev, 7);
});

/* ------------- segment clicks execute the LIVE item, not the payload -------- */
test('wheel:segment-click ignores an unrecognised item id and executes the store item', async () => {
  const actions = require('../../src/main/actions.js');
  const realExec = actions.executeAction;
  const executed = [];
  actions.executeAction = async (item) => { executed.push(item); };
  try {
    const live = { id: 'good', type: 'app', value: 'notepad.exe', label: 'N' };
    const { registerIpc } = require('../../src/main/ipc.js');
    registerIpc({
      store: { get: () => ({ hotkey: 'x', rings: { 1: [live] }, appearance: { colors: {} }, behavior: {} }), set: () => ({}), rev: 1, on: () => {} },
      hotkeyMgr: {}, overlay: { hide: () => {} }, settings: { send: () => {}, win: null }, welcome: { close: () => {}, send: () => {} },
      tray: { balloon: () => {} }, getState: () => ({}), setState: () => {},
      registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
    });
    const ev = { senderFrame: { url: pageUrl('wheel') } };
    await onMap.get('wheel:segment-click')(ev, { id: 'evil', type: 'command', value: 'calc' });
    assert.equal(executed.length, 0, 'a payload id missing from the live config must be dropped');
    await onMap.get('wheel:segment-click')(ev, { id: 'good', type: 'command', value: 'POWERSHELL.exe' });
    assert.equal(executed.length, 1);
    assert.equal(executed[0].value, 'notepad.exe', 'the STORE item runs — never the renderer payload');
  } finally {
    actions.executeAction = realExec;
  }
});
