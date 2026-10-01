'use strict';
/* Regression tests for the FTU (welcome) exit path.

   The renderer never closes its own window — every Done / Open Settings / Esc / ✕
   fires 'welcome:done' and MAIN decides what happens. So three things must come
   out of that one IPC: the guide goes off screen, 'ftuSeen' is recorded, and
   Settings opens only when asked. The original bug was the missing first one:
   Done marked the guide seen and left it sitting there. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

/* ---- electron stub, injected before any src/main require ---- */
const on = new Map();     // ipcMain.on      -> channel: listener
const handle = new Map(); // ipcMain.handle  -> channel: handler
const windows = [];       // every BrowserWindow the code under test built

function fakeWindow() {
  const handlers = {};
  const win = {
    sent: [], shown: 0, hidden: 0, closed: 0, destroyed: 0, focusCalls: 0, visible: false,
    handlers,
    webContents: { send: (ch, payload) => { win.sent.push([ch, payload]); } },
    once: (ev, fn) => { handlers[ev] = fn; },
    on: (ev, fn) => { handlers[ev] = fn; },
    loadFile: () => {}, setMenuBarVisibility: () => {},
    show: () => { win.shown++; win.visible = true; }, hide: () => { win.hidden++; win.visible = false; },
    focus: () => { win.focusCalls++; }, close: () => { win.closed++; },
    destroy: () => { win.destroyed++; win.dead = true; win.visible = false; },
    isDestroyed: () => !!win.dead, isVisible: () => win.visible
  };
  return win;
}

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir(), getVersion: () => '0.0.0-test' },
    ipcMain: { on: (ch, fn) => on.set(ch, fn), handle: (ch, fn) => handle.set(ch, fn) },
    dialog: {}, shell: {},
    BrowserWindow: function BrowserWindow() { const w = fakeWindow(); windows.push(w); return w; },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    }
  }
};

const { registerIpc } = require('../../src/main/ipc.js');
const { WelcomeWindow } = require('../../src/main/welcome.js');

/* ---- fakes ---- */
function makeDeps() {
  const calls = [];
  const welcome = { close: () => calls.push('welcome:close') };
  const settings = { open: () => calls.push('settings:open'), send: () => {}, win: null };
  const state = {};
  const deps = {
    store: {
      get: () => ({ hotkey: 'ctrl+alt+space', rings: {}, appearance: { colors: {} }, behavior: {} }),
      set: () => {}, rev: 0, on: () => {}
    },
    hotkeyMgr: {},
    overlay: { hide: () => calls.push('overlay:hide') },
    settings, welcome,
    tray: { balloon: () => {}, update: () => {} },
    getState: (k, d) => (k in state ? state[k] : d),
    setState: (k, v) => { state[k] = v; calls.push(`setState:${k}=${v}`); },
    registerHotkey: () => ({ ok: true }), toggleWheel: () => {}, quitApp: () => {}, isQuitting: () => false
  };
  return { deps, calls, state, welcome, settings };
}

function fire(channel, ...args) {
  const fn = on.get(channel);
  assert.ok(fn, `no ipcMain.on listener registered for ${channel}`);
  fn({ sender: {} }, ...args);
}

/* ----------------------------- welcome:done ----------------------------- */
test('welcome:done takes the FTU off screen, marks it seen, and does not open Settings', () => {
  const { deps, calls, state } = makeDeps();
  registerIpc(deps);
  fire('welcome:done', false);
  assert.deepEqual(calls, ['welcome:close', 'setState:ftuSeen=true']);
  assert.equal(state.ftuSeen, true);
});

test('welcome:done closes the guide even when handing off to Settings', () => {
  const { deps, calls, state } = makeDeps();
  registerIpc(deps);
  fire('welcome:done', true);
  assert.deepEqual(calls, ['welcome:close', 'setState:ftuSeen=true', 'settings:open']);
  assert.equal(state.ftuSeen, true);
});

test('welcome:done is registered as a fire-and-forget listener (the renderer never awaits it)', () => {
  const { deps } = makeDeps();
  registerIpc(deps);
  assert.ok(on.has('welcome:done'), 'welcome:done must be ipcMain.on');
  assert.ok(handle.has('welcome:info'), 'welcome:info must be ipcMain.handle');
});

test('main hands a welcome window to registerIpc — without it, Done cannot close', () => {
  // The other half of the same bug class: ipc.js can only close what main.js wired in.
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'main.js'), 'utf8');
  const call = src.match(/registerIpc\(\{([\s\S]*?)\}\)/);
  assert.ok(call, 'main.js must call registerIpc({...})');
  assert.ok(/[{,\s]welcome[,:\s}]/.test(call[1]), 'registerIpc deps must include `welcome`');
});

/* --------------------------- WelcomeWindow window --------------------------- */
function makeWin() {
  const before = windows.length;
  const w = new WelcomeWindow({ getConfig: () => ({ appearance: { colors: {} } }), isQuitting: () => false });
  const created = () => windows.slice(before);
  /* The window is created with show:false and revealed by 'ready-to-show';
     the stub never fires it on its own, so tests drive that step. */
  const reveal = () => { const [win] = created(); win.handlers['ready-to-show'] && win.handlers['ready-to-show'](); };
  return { w, created, reveal };
}

test('close() hides the window without destroying it (the tray replay stays free)', () => {
  const { w, created, reveal } = makeWin();
  w.open();
  reveal();
  const [win] = created();
  assert.equal(win.hidden, 0);
  w.close();
  assert.equal(win.hidden, 1);
  assert.equal(win.destroyed, 0);
  assert.equal(win.closed, 0, 'must not call BrowserWindow.close() — that path only hides while resident');
});

test('close() on a never-opened (or destroyed) guide is a no-op', () => {
  const { w } = makeWin();
  assert.doesNotThrow(() => w.close());
  w.open();
  w.destroy();
  assert.doesNotThrow(() => w.close());
});

test('reopening a hidden guide reuses the page and asks the renderer to walk back to step 1', () => {
  const { w, created, reveal } = makeWin();
  w.open();
  reveal();
  w.close();
  w.open();
  assert.equal(created().length, 1, 'open() must not build a second window');
  const [win] = created();
  assert.deepEqual(win.sent.map(([ch]) => ch), ['welcome:reset'],
    'a replay must not come back on the step the last run finished on');
  assert.equal(win.shown, 2);
  assert.equal(win.focusCalls, 2);
});
