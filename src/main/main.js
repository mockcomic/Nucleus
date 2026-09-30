'use strict';
const { app, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore, defaults } = require('./config');
const { HotkeyManager } = require('./hotkeys');
const { Overlay, SettingsWindow } = require('./windows');
const { TrayManager } = require('./tray');
const { ensureRuntimeIcons } = require('./icon-gen');
const { registerIpc } = require('./ipc');
const autostart = require('./autostart');

let quitting = false;
let store, hotkeyMgr, overlay, settingsWin, tray;

const isQuitting = () => quitting;

/* sidecar window-state file (bounds etc.) */
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); } catch {} }
const getState = (k, d) => ({ ...readState() })[k] || d;
const setState = (k, v) => { const s = readState(); s[k] = v; writeState(s); };

function registerHotkey(spec, opts = {}) {
  const res = hotkeyMgr.register(spec, () => toggleWheel());
  store.hotkeyError = res.ok ? null : res.error;
  if (!res.ok) {
    if (tray) tray.balloon('Hotkey could not be registered', res.error, 'error');
    // restore previous registration so the user isn't left without a hotkey
    const prev = store.get().hotkey;
    if (prev && prev !== spec) hotkeyMgr.register(prev, () => toggleWheel());
  }
  if (res.ok && opts.persist !== false && spec !== store.get().hotkey) {
    store.set({ ...JSON.parse(JSON.stringify(store.get())), hotkey: spec });
  }
  return res;
}

function toggleWheel(forceShow) {
  const cfg = store.get();
  if (overlay.isVisible() && cfg.behavior.reTriggerToggles && !forceShow) overlay.hide();
  else overlay.showAtCursor();
}

function quitApp() {
  quitting = true;
  try { hotkeyMgr && hotkeyMgr.unregister(); } catch {}
  try { tray && tray.destroy(); } catch {}
  try { overlay && overlay.destroy(); } catch {}
  try { settingsWin && settingsWin.destroy(); } catch {}
  app.quit();
}

function handleConfigChanged({ config, hotkeyChanged, autostartChanged, reload }) {
  if (hotkeyChanged) {
    hotkeyMgr.unregister();
    const res = hotkeyMgr.register(config.hotkey, () => toggleWheel());
    store.hotkeyError = res.ok ? null : res.error;
    if (!res.ok && tray) tray.balloon('Hotkey could not be registered', res.error, 'error');
  }
  if (autostartChanged) autostart.set(config.behavior.autostart);
  if (tray) tray.update();
  try { settingsWin.send('config:changed', config); } catch { /* settings may be closed */ }
}

function bootstrap() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);

  const icons = ensureRuntimeIcons(path.join(app.getPath('userData'), 'icons'));

  store = new ConfigStore();
  const init = store.init();
  hotkeyMgr = new HotkeyManager();

  overlay = new Overlay({ getConfig: () => store.get(), isQuitting });
  settingsWin = new SettingsWindow({ isQuitting, getState, setState });

  tray = new TrayManager(icons, {
    onShowWheel: () => toggleWheel(true),
    onOpenSettings: () => settingsWin.open(),
    onReload: () => { store.reload(); },
    onPauseToggle: (paused) => {
      if (paused) hotkeyMgr.unregister();
      else registerHotkey(store.get().hotkey, { persist: false });
    },
    onQuit: quitApp
  });
  tray.build(() => store.get());

  registerIpc({
    store, hotkeyMgr, overlay, settings: settingsWin, tray,
    getState, setState, registerHotkey, toggleWheel, quitApp, isQuitting
  });

  store.on('changed', handleConfigChanged);

  const res = hotkeyMgr.register(store.get().hotkey, () => toggleWheel());
  store.hotkeyError = res.ok ? null : res.error;
  if (!res.ok && tray) tray.balloon('Hotkey could not be registered', res.error, 'error');

  overlay.ensure(); // pre-warm the hidden window so the first popup is instant

  if (init.createdNew) {
    autostart.set(store.get().behavior.autostart);
    if (tray) {
      tray.balloon('Radial Wheel is running',
        `Press ${store.get().hotkey.replace(/\+/g, ' + ')} anywhere to open the wheel${store.importedFrom ? ' (settings imported from your old config)' : ''}.`);
    }
    settingsWin.open(); // first run: show the user how to customize
  }

  if (process.argv.includes('--show-wheel')) setTimeout(() => toggleWheel(true), 400);

  console.log(`[radial-wheel] ready — hotkey '${store.get().hotkey}' ${res.ok ? 'registered' : 'FAILED: ' + res.error}` +
    (store.importedFrom ? ` (imported ${store.importedFrom})` : '') +
    (store.broken ? ' (config.json was corrupt — defaults in use, see config.json.bad)' : '') +
    (init.createdNew ? ' (first run)' : ''));
}

/* ------------------------------ app lifecycle ------------------------------ */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.setAppUserModelId('local.radialwheel');

  app.on('second-instance', (ev, argv) => {
    if (argv.includes('--show-wheel')) toggleWheel(true);
    else if (!argv.includes('--hidden')) settingsWin.open();
  });

  app.whenReady().then(bootstrap);

  app.on('before-quit', () => { quitting = true; });

  // Tray-resident: closing all windows must NOT quit the app.
  app.on('window-all-closed', () => { /* stay resident */ });

  app.on('activate', () => { if (!overlay) return; });
}
