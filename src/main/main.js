'use strict';
const { app, Menu, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');

const { ConfigStore, defaults } = require('./config');
const { HotkeyManager, parse: parseHotkey } = require('./hotkeys');
const { Overlay, SettingsWindow } = require('./windows');
const { WelcomeWindow } = require('./welcome');
const { TrayManager } = require('./tray');
const { ensureRuntimeIcons } = require('./icon-gen');
const { registerIpc } = require('./ipc');
const { GameModeWatcher } = require('./gamemode');
const macro = require('./macro');
const autostart = require('./autostart');

let quitting = false;
let store, hotkeyMgr, overlay, settingsWin, welcome, tray, gameWatcher;

/* Two independent hotkey suppressors compose here: the tray's manual pause and
   gaming mode. The hotkey lives only while BOTH are clear (see applyHotkeyState). */
let manualPaused = false;
let gamePaused = false, gameReason = null;

const isQuitting = () => quitting;

/* sidecar window-state file (bounds etc.) */
const stateFile = () => path.join(app.getPath('userData'), 'state.json');
function readState() { try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch { return {}; } }
function writeState(s) { try { fs.mkdirSync(path.dirname(stateFile()), { recursive: true }); fs.writeFileSync(stateFile(), JSON.stringify(s, null, 2)); } catch {} }
const getState = (k, d) => ({ ...readState() })[k] || d;
const setState = (k, v) => { const s = readState(); s[k] = v; writeState(s); };

function registerHotkey(spec, opts = {}) {
  if (!hotkeyActive()) {
    // Paused (tray or gaming mode): validate the spec so bad combos are still
    // reported and persisted, but don't (re-)register behind the suppressor's back.
    try { parseHotkey(spec); } catch (e) { return { ok: false, error: e.message }; }
    if (opts.persist !== false && spec !== store.get().hotkey) {
      store.set({ ...JSON.parse(JSON.stringify(store.get())), hotkey: spec });
    }
    return { ok: true, accel: null, deferred: true };
  }
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

const hotkeyActive = () => !manualPaused && !gamePaused;

/* Single source of truth for whether the global shortcut is registered. */
function applyHotkeyState() {
  if (!hotkeyMgr || quitting) return;
  if (hotkeyActive()) {
    if (!hotkeyMgr.current) {
      const res = hotkeyMgr.register(store.get().hotkey, () => toggleWheel());
      store.hotkeyError = res.ok ? null : res.error;
      if (!res.ok && tray) tray.balloon('Hotkey could not be registered', res.error, 'error');
    }
  } else {
    hotkeyMgr.unregister();
    if (overlay) overlay.hide();
    store.hotkeyError = null; // the hotkey is deliberately off — no stale error
  }
  if (tray) tray.update();
}

function toggleWheel(forceShow) {
  const cfg = store.get();
  if (overlay.isVisible() && cfg.behavior.reTriggerToggles && !forceShow) overlay.hide();
  else overlay.showAtCursor();
}

function quitApp() {
  quitting = true;
  try { gameWatcher && gameWatcher.stop(); } catch {}
  try { hotkeyMgr && hotkeyMgr.unregister(); } catch {}
  try { tray && tray.destroy(); } catch {}
  try { overlay && overlay.destroy(); } catch {}
  try { settingsWin && settingsWin.destroy(); } catch {}
  try { welcome && welcome.destroy(); } catch {}
  app.quit();
}

function handleConfigChanged({ config, rev, hotkeyChanged, autostartChanged, reload }) {
  if (hotkeyChanged) {
    hotkeyMgr.unregister();
    applyHotkeyState();   // stays unregistered while the tray/game suppressors hold
  }
  if (autostartChanged) autostart.set(config.behavior.autostart);
  try { gameWatcher && gameWatcher.configure(); } catch { /* never let config break the watcher */ }
  if (tray) tray.update();
  // The settings window is the source of every store.set(); echoing the config
  // back to it raced ahead of the IPC reply, replacing cfg under the open
  // editor and silently dropping writes made through its captured item refs.
  // Only reload() (tray reload / config.json watch) is an external change.
  if (reload) {
    try { settingsWin.send('config:changed', { config: JSON.parse(JSON.stringify(config)), rev }); } catch { /* settings may be closed */ }
  }
}

function bootstrap() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);

  const icons = ensureRuntimeIcons(path.join(app.getPath('userData'), 'icons'));

  store = new ConfigStore();
  const init = store.init();
  hotkeyMgr = new HotkeyManager();

  overlay = new Overlay({ getConfig: () => store.get(), isQuitting });
  settingsWin = new SettingsWindow({ isQuitting, getState, setState, bgColor: () => store.get().appearance.colors.bg });
  welcome = new WelcomeWindow({ getConfig: () => store.get(), isQuitting });

  tray = new TrayManager(icons, {
    onShowWheel: () => toggleWheel(true),
    onOpenSettings: () => settingsWin.open(),
    onShowWelcome: () => welcome.open(),
    onReload: () => { store.reload(); },
    onPauseToggle: (paused) => { manualPaused = paused; applyHotkeyState(); },
    getGameMode: () => ({ active: gamePaused, reason: gameReason }),
    onQuit: quitApp
  });
  tray.build(() => store.get());

  /* Gaming mode: pause the hotkey while a fullscreen / listed app owns the foreground. */
  gameWatcher = new GameModeWatcher(() => store.get(), () => macro.foregroundProbe(), { ourPid: process.pid });
  gameWatcher.on('pause', (reason) => {
    gamePaused = true;
    gameReason = reason || 'game';
    applyHotkeyState();
    console.log(`[radial-wheel] game mode: paused (${gameReason})`);
  });
  gameWatcher.on('resume', () => {
    gamePaused = false;
    gameReason = null;
    applyHotkeyState();
    console.log('[radial-wheel] game mode: resumed');
  });
  gameWatcher.configure();

  registerIpc({
    store, hotkeyMgr, overlay, settings: settingsWin, welcome, tray,
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
    /* (Settings no longer auto-opens on first run — the FTU welcome window
       below hands off to it when the user is ready.) */
  }

  /* FTU: shown once per user via the state.json flag — an upgrade over an
     existing config sees it exactly once too. Replays: tray → "Show welcome…". */
  if (!getState('ftuSeen', false)) welcome.open();

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
