'use strict';
const { app, Menu, nativeTheme, shell } = require('electron');
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
const profiles = require('./profiles');
const usage = require('./usage');
const macro = require('./macro');
const mousehook = require('./mousehook');
const autostart = require('./autostart');
const update = require('./update');
const log = require('./logger');
const migrate = require('./migrate');
/* The logger is safe to call from here on — it degrades to console-only until
   init() pins the userData log file (done once the app is ready, below). */

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
  const res = hotkeyMgr.register(spec, () => toggleWheel(), hotkeyOpts());
  store.hotkeyError = res.ok ? null : res.error;
  if (!res.ok) {
    if (tray) tray.balloon('Hotkey could not be registered', res.error, 'error');
    // restore previous registration so the user isn't left without a hotkey —
    // and clear the error once the OLD hotkey is confirmed live, otherwise
    // Settings keeps claiming "already taken" for a hotkey that works.
    const prev = store.get().hotkey;
    if (prev && prev !== spec) {
      const back = hotkeyMgr.register(prev, () => toggleWheel(), hotkeyOpts());
      store.hotkeyError = back.ok ? null : back.error;
    }
  }
  if (res.ok && opts.persist !== false && spec !== store.get().hotkey) {
    store.set({ ...JSON.parse(JSON.stringify(store.get())), hotkey: spec });
  }
  return res;
}

const hotkeyActive = () => !manualPaused && !gamePaused;

/* The wheel's view of the config, resolved once per summon:
   1. app profile — when enabled, ONE foreground probe picks the first profile
      whose exe list matches the focused app and swaps its rings in
      (profiles.pickProfile; fail-open to the default wheel on any probe error);
   2. recent segments — every `recent` container's sub-menu is filled from the
      usage sidecar (usage.resolveRecents; zero cost — same reference back —
      when the wheel has none).
   Everything else (hotkeys, game mode, autostart, tray) reads the STORE —
   profiles only ever replace the ring payload of the popped wheel. */
function effectiveConfig() {
  const base = store.get();
  let eff = base;
  if (base.behavior.profilesEnabled && Array.isArray(base.profiles) && base.profiles.length) {
    let probe = null;
    try { probe = macro.foregroundProbe(); } catch { probe = null; }   // fail-open, same doctrine as game mode
    const p = profiles.pickProfile(base, probe, process.pid);
    if (p) {
      eff = JSON.parse(JSON.stringify(base));
      eff.rings = JSON.parse(JSON.stringify(p.rings));
      log.info(`wheel: profile '${p.name}' (${probe && probe.exe})`);
    }
  }
  return usage.resolveRecents(eff, getState('usage', {}) || {}, base.behavior.recentsCount);
}

/* Per-registration options from the LIVE config. A mouse-button trigger either
   swallows its own press (default, so Middle click doesn't also paste) or hands
   it to the app under the cursor — behavior.mouseClickThrough. Keyboard specs
   ignore it, so this stays cheap and total. */
const hotkeyOpts = () => {
  const bh = (store && store.get().behavior) || {};
  return { clickThrough: bh.mouseClickThrough === true };
};

/* Single source of truth for whether the global shortcut is registered. */
function applyHotkeyState() {
  if (!hotkeyMgr || quitting) return;
  if (hotkeyActive()) {
    if (!hotkeyMgr.current) {
      const res = hotkeyMgr.register(store.get().hotkey, () => toggleWheel(), hotkeyOpts());
      store.hotkeyError = res.ok ? null : res.error;
      // Only the mouse path gets a line: it is a live system hook, and "is it
      // actually installed right now?" is the first question when a button
      // trigger misbehaves. Keyboard registration is already covered by the
      // tray tooltip and the startup marker.
      if (res.mouse) log.info(`mouse trigger '${store.get().hotkey}' ${res.ok ? (mousehook.active() ? 'hook armed' : 'registered but hook NOT armed') : 'FAILED: ' + res.error}`);
      if (!res.ok && tray) tray.balloon('Hotkey could not be registered', res.error, 'error');
    }
  } else {
    const wasMouse = !!(hotkeyMgr.current && hotkeyMgr.current.mouse);
    const wasArmed = mousehook.active();
    hotkeyMgr.unregister();
    if (wasMouse && wasArmed) log.info('mouse hook released (hotkey paused)');
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
  /* Release the low-level mouse hook AND the pinned native callback: a hook
     alive past the process would keep swallowing clicks (hotkeyMgr.unregister
     unhooks; this also frees the koffi callback handle). */
  try { mousehook.shutdown(); } catch {}
  try { tray && tray.destroy(); } catch {}
  try { overlay && overlay.destroy(); } catch {}
  try { settingsWin && settingsWin.destroy(); } catch {}
  try { welcome && welcome.destroy(); } catch {}
  app.quit();
}

/* ------------------------------ update check ------------------------------
   GitHub Releases, check + notify only (see update.js): a scheduled poll a few
   seconds after start, then once a day, plus manual checks from the tray and
   Settings. Fail-soft everywhere — an app that cannot reach GitHub (or whose
   repo has no releases yet) behaves exactly as it did before this feature. */
let appPublishMs = NaN;

/* One label for every surface (tray row, balloon, Settings chip), so they can
   never disagree about what the last check found. */
function updateLabel(snap) {
  const ver = snap.info && snap.info.version ? ' ' + snap.info.version : '';
  if (snap.status === 'available') return snap.kind === 'build'
    ? `New build available${ver}` : `Update available${ver}`;
  if (snap.status === 'upToDate') return `Up to date${snap.info ? ` (${snap.info.version})` : ''}`;
  if (snap.status === 'checking') return 'Checking for updates\u2026';
  if (snap.status === 'error') return 'Update check failed';
  return 'No releases published yet';
}

/* One check end-to-end; always answers with the current snapshot (the caller
   never needs to know whether the request itself succeeded). */
async function runUpdateCheck() {
  try { await update.check({ appVersion: app.getVersion(), appPublishMs }); }
  catch (err) { log.warn('update check failed:', err && err.message); }
  const snap = update.snapshot(app.getVersion(), appPublishMs);
  try { if (tray) tray.update(); } catch { /* menu refresh is cosmetic */ }
  return snap;
}

/* Manual check (tray item / Settings button): always announces its result —
   that is the whole point of asking by hand. */
async function manualUpdateCheck() {
  const snap = await runUpdateCheck();
  if (tray) {
    if (snap.status === 'available' && snap.info) {
      setState('updateSeenTag', snap.info.tag);     // the schedule must not double-balloon it
      tray.balloon('Nucleus update available', `${updateLabel(snap)} \u2014 pick "Update available" in the tray or Settings to open the release page.`);
    } else if (snap.status === 'upToDate') {
      tray.balloon('Nucleus is up to date', snap.info ? `Version ${snap.info.version} is the latest release.` : 'You have the latest release.');
    } else if (snap.status === 'error') {
      tray.balloon('Update check failed', (snap.error || 'Could not reach GitHub.') + ' Check your connection and try again.', 'error');
    } else {
      tray.balloon('No releases found', 'Nucleus has not published a GitHub release yet.');
    }
  }
  return snap;
}

async function scheduledUpdateCheck() {
  try {
    if (!store.get().behavior.updateChecks) return;   // background checks are off; manual still works
    const snap = await runUpdateCheck();
    /* Balloon once per tag: opening the release page (or a manual check)
       records updateSeenTag in state.json, so a dismissed update never nags
       again until a NEWER one appears. */
    if (snap.status === 'available' && snap.info && tray && getState('updateSeenTag', null) !== snap.info.tag) {
      setState('updateSeenTag', snap.info.tag);
      tray.balloon('Nucleus update available', `${updateLabel(snap)} \u2014 pick "Update available" in the tray or Settings to open the release page.`);
    }
  } catch (err) { log.warn('scheduled update check failed:', err && err.message); }
}

/* unref'd so neither timer can ever hold a quit (or a test run) open. */
function startUpdateSchedule() {
  const first = setTimeout(() => { scheduledUpdateCheck(); }, 15000);
  const loop = setInterval(() => { scheduledUpdateCheck(); }, 24 * 3600e3);
  if (first.unref) first.unref();
  if (loop.unref) loop.unref();
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
    // The (hidden, reused) welcome window listens too — its hotkey chip would
    // otherwise show the boot-time hotkey forever after a later change.
    try { welcome.send('config:changed', { config: JSON.parse(JSON.stringify(config)), rev }); } catch { /* welcome may be closed */ }
  }
}

function bootstrap() {
  nativeTheme.themeSource = 'dark';
  Menu.setApplicationMenu(null);

  /* Radial Wheel → Nucleus rename: copy the old %APPDATA%\Radial Wheel
     profile into this one exactly once (see migrate.js). Fail-soft — a fresh
     profile is the fallback. */
  try { migrate.runOnce(app); } catch { /* never break boot over migration */ }

  let icons;
  try {
    icons = ensureRuntimeIcons(path.join(app.getPath('userData'), 'icons'));
  } catch (err) {
    // Unwritable userData must not abort bootstrap — a windowless,
    // hotkey-less resident process is far worse than a tray-less one.
    log.error('runtime icon prep failed:', (err && err.stack) || (err && err.message) || err);
    icons = null;
  }

  store = new ConfigStore();
  const init = store.init();
  hotkeyMgr = new HotkeyManager();

  overlay = new Overlay({ getConfig: effectiveConfig, getBehavior: () => store.get().behavior, isQuitting });
  settingsWin = new SettingsWindow({ isQuitting, getState, setState, bgColor: () => store.get().appearance.colors.bg });
  welcome = new WelcomeWindow({ getConfig: () => store.get(), isQuitting });

  if (icons) {
    tray = new TrayManager(icons, {
      onShowWheel: () => toggleWheel(true),
      onOpenSettings: () => settingsWin.open(),
      onShowWelcome: () => welcome.open(),
      onReload: () => { store.reload(); },
      onOpenLogs: () => { const d = log.dir(); if (d) { try { fs.mkdirSync(d, { recursive: true }); } catch {} shell.openPath(d); } },
      onPauseToggle: (paused) => { manualPaused = paused; applyHotkeyState(); },
      getGameMode: () => ({ active: gamePaused, reason: gameReason }),
      /* Update row: the label comes from the last snapshot (local data only —
         opening the tray never costs a request). The item itself is a click
         target only when something is on offer. */
      getUpdateStatus: () => {
        const snap = update.snapshot(app.getVersion(), appPublishMs);
        return { label: updateLabel(snap), available: snap.status === 'available', error: snap.status === 'error' };
      },
      onOpenUpdate: async () => {
        const snap = update.snapshot(app.getVersion(), appPublishMs);
        const got = await update.openRelease(snap.info && snap.info.url);
        if (got.ok && snap.info) setState('updateSeenTag', snap.info.tag);   // viewed = seen: no repeat balloon
      },
      onCheckUpdate: () => { manualUpdateCheck(); },
      onQuit: quitApp
    });
    tray.build(() => store.get());
  } else {
    tray = null;
    log.error('continuing WITHOUT a tray icon — nothing writable under ' + app.getPath('userData') + '?');
  }

  /* Update check boot: read back the last good release (sanitized again by
     the module), stamp when THIS build was made (asar mtime packaged; the
     working-tree dir mtime in dev — it only ever feeds the same-version
     publish-date tie-break), and arm the schedule. All fail-soft. */
  try { update.configure(app.getPath('userData')); }
  catch (err) { log.warn('update configure failed:', err && err.message); }
  try { appPublishMs = fs.statSync(app.getAppPath()).mtimeMs; }
  catch { /* no clock anchor: the tie-break can only ever answer "up to date" */ }
  startUpdateSchedule();

  /* Gaming mode: pause the hotkey while a fullscreen / listed app owns the foreground. */
  gameWatcher = new GameModeWatcher(() => store.get(), () => macro.foregroundProbe(), { ourPid: process.pid });
  gameWatcher.on('pause', (reason) => {
    gamePaused = true;
    gameReason = reason || 'game';
    applyHotkeyState();
    log.info(`game mode: paused (${gameReason})`);
  });
  gameWatcher.on('resume', () => {
    gamePaused = false;
    gameReason = null;
    applyHotkeyState();
    log.info('game mode: resumed');
  });
  gameWatcher.configure();

  registerIpc({
    store, hotkeyMgr, overlay, settings: settingsWin, welcome, tray,
    getState, setState, registerHotkey, toggleWheel, quitApp, isQuitting,
    /* Update trio: local snapshot, manual check (announces via balloon like
       the tray item), and the fixed-target release-page opener. openRelease
         (the URL is matched against main's sanitized copy inside update.js). */
    updateSnapshot: () => update.snapshot(app.getVersion(), appPublishMs),
    checkUpdate: () => manualUpdateCheck(),
    openRelease: async (url) => {
      const got = await update.openRelease(url);
      if (got.ok) {
        const snap = update.snapshot(app.getVersion(), appPublishMs);
        if (snap.info) setState('updateSeenTag', snap.info.tag);
      }
      return got;
    }
  });

  store.on('changed', handleConfigChanged);

  const res = hotkeyMgr.register(store.get().hotkey, () => toggleWheel(), hotkeyOpts());
  store.hotkeyError = res.ok ? null : res.error;
  if (!res.ok && tray) tray.balloon('Hotkey could not be registered', res.error, 'error');

  overlay.ensure(); // pre-warm the hidden window so the first popup is instant

  /* Which copy is this? The log must not call every packaged run "packaged":
     portable and win-unpacked are packaged too, and mixing them up hid the
     login-item wipe (an unverified disable from one copy deletes the shared
     Run value by name). Print exe, stub marker, argv, and the gate verdict. */
  log.info(`running as — "${process.execPath}" [${app.isPackaged ? 'packaged' : 'dev'}]` +
    (process.env.PORTABLE_EXECUTABLE_FILE ? ` portable stub of "${process.env.PORTABLE_EXECUTABLE_FILE}"` : '') +
    ` argv: ${process.argv.slice(1).join(' ') || '(none)'}; login item ${autostart.allowed() ? 'allowed' : 'not allowed'}`);

  /* Login item: installed copy only. A fresh install waits for the welcome
     guide (the last step's checkbox, or off if they leave early). After the
     guide has been seen, the registry follows behavior.autostart. Any other
     copy clears a login item for THIS exe only — the disable inside
     autostart.set(false) verifies the stored command line points at our own
     exe before deleting, because Electron deletes HKCU Run values by NAME and
     every copy shares 'local.nucleus'. Portable and dev share the config
     with the installed app and must not rewrite that preference. */
  if (!autostart.allowed()) {
    try {
      const r = autostart.set(false);
      if (r && !r.ok) log.warn('could not clear the login item for this copy:', r.error);
    }
    catch (err) { log.warn('could not clear the login item for this copy:', err && err.message); }
  } else if (getState('ftuSeen', false)) {
    try {
      const r = autostart.set(!!store.get().behavior.autostart);
      if (r && r.ok && r.enabled) log.info(r.verified ? 'login item registered (verified)' : 'login item written (verification fell back)');
      else if (r && !r.ok && store.get().behavior.autostart) log.warn('login item not registered:', r.error);
    }
    catch (err) { log.warn('autostart reconcile failed:', err && err.message); }
  }

  if (init.createdNew && tray) {
    // display() renders mouse triggers too: "Middle click", not "mmiddle".
    tray.balloon('Nucleus is running',
      `Press ${HotkeyManager.display(store.get().hotkey)} anywhere to open the wheel${store.importedFrom ? ' (settings imported from your old config)' : ''}.`);
    /* (Settings no longer auto-opens on first run — the FTU welcome window
       below hands off to it when the user is ready.) */
  }

  /* FTU: shown once per user via the state.json flag — an upgrade over an
     existing config sees it exactly once too. Replays: tray → "Show welcome…". */
  if (!getState('ftuSeen', false)) welcome.open();

  if (process.argv.includes('--show-wheel')) setTimeout(() => toggleWheel(true), 400);

  log.info(`ready — hotkey '${store.get().hotkey}' ${res.ok ? 'registered' : 'FAILED: ' + res.error}` +
    (res.mouse ? ` [mouse hook ${mousehook.active() ? 'armed' : 'NOT ARMED'}]` : '') +
    (store.importedFrom ? ` (imported ${store.importedFrom})` : '') +
    (store.broken ? ' (config.json was corrupt — defaults in use, see config.json.bad)' : '') +
    (init.createdNew ? ' (first run)' : ''));

  /* Dev-only verification aid: `--mouse-hook-probe` logs the low-level hook's
     counters whenever they change — calls (every event handed to the proc),
     seen (events matching our button), fired, swallowed, injectedIgnored.
     "calls rises but seen stays 0" means the button never reaches the hook
     (vendor driver remap, or another app's hook swallowed it first).
     Never enabled in a packaged build. */
  if (process.argv.includes('--mouse-hook-probe') && !app.isPackaged) {
    let last = '', samples = 0;
    const t = setInterval(() => {
      if (!mousehook.active()) { clearInterval(t); return; }
      const s = JSON.stringify(mousehook.getStats());
      if (s !== last) { last = s; log.info(`mouse hook ${s}`); }
      if (++samples > 3600) clearInterval(t);          // an hour of headroom
    }, 400);
  }
}

/* ------------------------------ app lifecycle ------------------------------ */
if (!app.requestSingleInstanceLock()) {
  /* Second launch: say so in the log — an exe double-click that "does nothing"
     is otherwise indistinguishable from a crash. */
  log.warn('another instance already holds the single-instance lock — this launch exits');
  app.quit();
} else {
  app.setAppUserModelId('local.nucleus');

  /* Tray-resident launcher: never hostage to a usable GPU process. A locked
     or corrupt GPUPersistentCache (e.g. squatting handles left by an orphan
     of an earlier badly-killed instance) makes Chromium abort the whole
     browser with "GPU process isn't usable. Goodbye." (STATUS_BREAKPOINT) —
     an invisible death: no window, no tray, process gone in seconds. This
     app's only UI is DOM compositing that software raster handles fine. */
  app.disableHardwareAcceleration();

  /* Last-resort net for an always-resident tray app: a stray async throw must
     never take the launcher down. Individual sites still handle their own
     errors; this only turns a process death into a loud log + balloon. */
  const survives = (where) => (err) => {
    log.error(`${where}:`, (err && (err.stack || err.message)) || err);
    try { tray && tray.balloon('Nucleus recovered from an internal error', String((err && err.message) || err), 'error'); } catch { /* best effort */ }
  };
  process.on('uncaughtException', survives('uncaughtException'));
  process.on('unhandledRejection', survives('unhandledRejection'));

  app.on('second-instance', (ev, argv) => {
    if (argv.includes('--show-wheel')) toggleWheel(true);
    else if (!argv.includes('--hidden')) settingsWin.open();
  });

  /* A bootstrap throw is the silent-death case: no window, no tray, no clue —
     and uncaughtException never sees a rejected whenReady promise. Log it and
     exit non-zero so `npm start` surfaces the failure too. */
  app.whenReady()
    .then(() => { log.init(); log.banner(); bootstrap(); })
    .catch((err) => {
      log.error('fatal — startup failed:', (err && (err.stack || err.message)) || err);
      process.exit(1);
    });

  app.on('before-quit', () => { quitting = true; });

  // Tray-resident: closing all windows must NOT quit the app.
  app.on('window-all-closed', () => { /* stay resident */ });

  app.on('activate', () => { if (!overlay) return; });
}
