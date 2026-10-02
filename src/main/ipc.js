'use strict';
const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const actions = require('./actions');
const autostart = require('./autostart');
const apps = require('./apps');
const dashboardIcons = require('./dashboard-icons');
const customIcons = require('./custom-icons');
const sys = require('./sys');
const log = require('./logger');
const { supportsVibrancy } = require('./windows');

/**
 * deps = { store, hotkeyMgr, overlay, settings, welcome, tray, getState, setState,
 *          registerHotkey, toggleWheel, quitApp, isQuitting }
 */
function registerIpc(deps) {
  const { store, overlay, settings, welcome, tray } = deps;

  /* ---- sender-frame gate (defense-in-depth, pairs with preload scoping) ----
     A privileged channel answers only the window its API was bridged for; a
     compromised overlay can't invoke config:set directly even if it
     reconstructs the channel name. Read-only channels stay ungated — their
     data is already on-screen in every window. */
  const frameOn = (ev, ...names) => {
    try {
      const u = (ev.senderFrame && ev.senderFrame.url) || '';
      return names.some((n) => u.includes('/renderer/' + n + '/'));
    } catch { return false; }
  };
  const PRIVILEGED = {
    'config:set': ['settings'], 'config:flush': ['settings'],
    'config:export': ['settings'], 'config:import': ['settings'],
    'config:reset': ['settings'], 'config:open-folder': ['settings'],
    'hotkey:set': ['settings', 'welcome'], 'autostart:set': ['settings'],
    'action:preview': ['settings'], 'overlay:show': ['settings', 'welcome'],
    'dialog:pick-file': ['settings'],
    // pick-image opens a modal on the Settings window and reads the chosen path
    // in main, so it is gated like every other privileged channel.
    'icons:pick-image': ['settings'], 'icons:add-url': ['settings'],
    'wheel:segment-click': ['wheel'], 'wheel:dismiss': ['wheel'],
    'welcome:done': ['welcome'], 'settings:close': ['settings'], 'app:quit': ['settings']
  };
  const SEND_CHANNELS = new Set(['config:flush', 'wheel:segment-click', 'wheel:dismiss', 'welcome:done', 'settings:close', 'app:quit']);
  const refused = (ch, ev) => {
    log.warn(`refused ${ch} from an untrusted frame`);
    return SEND_CHANNELS.has(ch) ? undefined : { ok: false, error: 'untrusted frame' };
  };
  const guardHandle = (ch, fn) => ipcMain.handle(ch, PRIVILEGED[ch]
    ? (ev, ...a) => (frameOn(ev, ...PRIVILEGED[ch]) ? fn(ev, ...a) : refused(ch, ev))
    : fn);
  const guardOn = (ch, fn) => ipcMain.on(ch, PRIVILEGED[ch]
    ? (ev, ...a) => { if (frameOn(ev, ...PRIVILEGED[ch])) fn(ev, ...a); else refused(ch, ev); }
    : fn);

  const broadcast = (channel, payload) => settings.send(channel, payload);

  /* ---- wheel overlay events ---- */
  guardOn('wheel:dismiss', () => overlay.hide());

  guardOn('wheel:segment-click', async (e, item) => {
    overlay.hide();
    /* The overlay payload is renderer-supplied — never execute it as-is.
       Match the clicked item against the LIVE config by id so a bugged or
       compromised renderer cannot inject an arbitrary action payload. */
    const live = item && typeof item === 'object' && item.id
      ? Object.values(store.get().rings || {}).flat().find((x) => x && x.id === item.id)
      : null;
    if (!live) { log.warn('ignored segment click for unknown item', item && item.id); return; }
    item = live;
    // sys.ALIAS forms (volup, clipboard, …) canonicalize through the same map
    // sys.run() uses, so aliased key-actions get the focus-regain wait too.
    const sysKey = sys.ALIAS[String(item.value || '').toLowerCase()] || String(item.value || '').toLowerCase();
    const isKeyAction = item.type === 'macro' || (item.type === 'sys' && sys.KEY_ACTIONS.has(sysKey));
    if (isKeyAction) await new Promise((r) => setTimeout(r, 120)); // let the former window regain focus
    try {
      await actions.executeAction(item, { quit: () => deps.quitApp() });
    } catch (err) {
      if (tray) tray.balloon(`${item && item.label ? item.label : 'Action'} failed`, String(err && err.message || err), 'error');
      log.error('action failed:', item && item.label, (err && (err.stack || err.message)) || err);
    }
  });

  /* ---- config ---- */
  guardHandle('config:get', () => ({
    config: JSON.parse(JSON.stringify(store.get())),
    rev: store.rev,
    hotkeyError: store.hotkeyError || null,
    importedFrom: store.importedFrom || null,
    broken: !!store.broken
  }));

  guardHandle('config:set', (ev, cfg) => {
    // store.set throws when the disk refuses (AV lock, disk full): report it
    // as ok:false so the Settings "Not saved" path runs — never reject the
    // invoke (the renderer's await has no catch and would strand the UI).
    try {
      const merged = store.set(cfg);
      store.broken = false;   // a successful write means config.json is healthy again
      return { ok: true, config: JSON.parse(JSON.stringify(merged)), rev: store.rev, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // Exit flush from the settings renderer (pagehide/beforeunload): a send()
  // lands here synchronously even while the window is being destroyed. The
  // payload rides through store.set → validate(), so a bad frame can at worst
  // trigger a rejected save, never an arbitrary write.
  guardOn('config:flush', (ev, cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    try { store.set(cfg); store.broken = false; }
    catch (err) { log.error('exit-flush save failed:', err && err.message); }
  });

  guardHandle('config:export', async (ev) => {
    const w = settings.win;
    const r = await dialog.showSaveDialog(w, {
      title: 'Export config', defaultPath: 'radial-wheel-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(store.get(), null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: 'Could not write export: ' + String(err && err.message || err) };
    }
    return { ok: true, path: r.filePath };
  });

  guardHandle('config:import', async () => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Import config', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const merged = store.set(raw);
      store.broken = false;
      return { ok: true, config: merged, rev: store.rev, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + (err.message || err) };
    }
  });

  guardHandle('config:reset', () => {
    try {
      const merged = store.set({}); // validate({}) == defaults
      store.broken = false;
      return { ok: true, config: merged, rev: store.rev, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  guardHandle('config:open-folder', () => shell.openPath(path.dirname(store.file())));

  /* ---- logs ----
     'log:line' is deliberately NOT frame-gated: the preload console hook is a
     fire-and-forget send() that must survive page teardown (crash-time logs),
     and its payload is sanitized + clamped inside the logger. The renderer can
     write log lines, nothing else. */
  ipcMain.on('log:line', (ev, payload) => log.forwardRenderer(payload));
  guardHandle('log:open-folder', () => {
    const d = log.dir();
    if (!d) return { ok: false, error: 'log folder unavailable' };
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* openPath reports the failure */ }
    return shell.openPath(d).then((err) => (err ? { ok: false, error: err } : { ok: true }));
  });
  guardHandle('logs:tail', (ev, n) => {
    const d = log.dir();
    if (!d) return { ok: false, error: 'log folder unavailable', lines: [] };
    try {
      const files = fs.readdirSync(d).filter((f) => /^radial-wheel-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
      if (!files.length) return { ok: true, lines: [], file: null };
      const file = files[files.length - 1];
      const lines = fs.readFileSync(path.join(d, file), 'utf8').split(/\r?\n/).filter(Boolean);
      return { ok: true, file, lines: lines.slice(-Math.max(1, Math.min(n | 0 || 200, 1000))) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), lines: [] };
    }
  });

  /* ---- hotkey ---- */
  guardHandle('hotkey:set', (ev, spec) => {
    const prev = store.get();
    const res = deps.registerHotkey(spec, { persist: false });
    if (!res.ok) return { ok: false, error: res.error };
    try {
      store.set({ ...JSON.parse(JSON.stringify(prev)), hotkey: spec });
    } catch (err) {
      // registered but not persisted — roll the registration back to the
      // saved hotkey so what works matches what survives a restart.
      const back = deps.registerHotkey(prev.hotkey, { persist: false });
      return { ok: false, error: String(err && err.message || err) + (back.ok ? '' : ' (and the previous hotkey could not be restored)') };
    }
    return { ok: true, accel: res.accel };
  });

  /* ---- autostart ---- */
  guardHandle('autostart:get', () => ({
    enabled: store.get().behavior.autostart,
    registered: autostart.get(),
    allowed: autostart.allowed()
  }));
  guardHandle('autostart:set', (ev, on) => {
    const r = autostart.set(on);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      // Persist the NEW flag — re-saving the old clone left config.json
      // contradicting the registry until the renderer's debounced save caught
      // up, and if that save never ran (renderer died) the drift was permanent.
      const cur = JSON.parse(JSON.stringify(store.get()));
      cur.behavior.autostart = !!on;
      store.set(cur);
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
    return { ok: true, verified: r.verified };
  });

  /* ---- icon images (logos + custom artwork for wheel items) ----
     item.iconImage is either a dashboardicons slug or a `custom:<hash>.<kind>`
     key. Both families resolve through ONE channel so the overlay, the Settings
     rows and the live preview share a single lookup. */
  dashboardIcons.configure(path.join(app.getPath('userData'), 'icons', 'dashboard'));
  customIcons.configure(path.join(app.getPath('userData'), 'icons', 'custom'));
  const ringItems = (cfg) => (cfg && cfg.rings ? Object.values(cfg.rings) : [])
    .flatMap((a) => Array.isArray(a) ? a : []);
  const resolveIconImage = (key) => customIcons.isCustomKey(key)
    ? customIcons.dataUrlFor(key)
    : dashboardIcons.dataUrlFor(key);

  guardHandle('icons:search', (ev, query) => dashboardIcons.searchIcons(query));
  guardHandle('icons:fetch', (ev, slug) => dashboardIcons.fetchIcon(slug));
  guardHandle('icons:data-url', (ev, key) => resolveIconImage(key));

  /* The dialog and the read are a single round trip: a renderer can never name
     a path for main to read, only accept or cancel what this window shows. */
  guardHandle('icons:pick-image', async () => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Choose an icon image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: customIcons.PICK_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const got = customIcons.addFile(r.filePaths[0]);
    if (!got.ok) log.warn('custom icon rejected:', got.error);
    return got;
  });

  guardHandle('icons:add-url', async (ev, url) => {
    const got = await customIcons.addUrl(url);
    if (!got.ok) log.warn('custom icon URL rejected:', got.error);
    return got;
  });

  // Prime both disk caches so the wheel never has to wait on a download. Each
  // module ignores keys outside its own family, so one list serves both.
  const warmIcons = (cfg) => {
    const keys = ringItems(cfg).map((it) => it.iconImage);
    dashboardIcons.warm(keys);
    customIcons.warm(keys);
  };
  warmIcons(store.get());
  store.on('changed', ({ config }) => warmIcons(config));

  /* ---- misc ---- */
  guardHandle('dialog:pick-file', async (ev, opts) => {
    // opts.directory: folder picker (the sys explorer action's start folder);
    // file filters are meaningless there, so they are skipped.
    if (opts && opts.directory) {
      const r = await dialog.showOpenDialog(settings.win, {
        title: opts.title || 'Choose a folder',
        properties: ['openDirectory', 'createDirectory']
      });
      return r.canceled ? null : r.filePaths[0];
    }
    const r = await dialog.showOpenDialog(settings.win, {
      title: (opts && opts.title) || 'Choose a file',
      properties: ['openFile'],
      filters: opts && opts.extensions && opts.extensions.length
        ? [{ name: opts.filterName || 'Programs', extensions: opts.extensions }, { name: 'All files', extensions: ['*'] }]
        : undefined
    });
    return r.canceled ? null : r.filePaths[0];
  });

  guardHandle('action:preview', async (ev, item) => {
    try {
      await actions.executeAction(item, { quit: () => deps.quitApp() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  guardHandle('overlay:show', () => { deps.toggleWheel(true); return { ok: true }; });

  /* ---- welcome (FTU) ---- */
  guardHandle('welcome:info', () => {
    const cfg = store.get();
    const rings = cfg.rings || {};
    const hasWheel = Object.values(rings).some((a) => Array.isArray(a) && a.length);
    return {
      hotkey: cfg.hotkey,
      hotkeyError: store.hotkeyError || null,
      version: app.getVersion(),
      importedFrom: store.importedFrom || null,
      hasWheel,
      ftuSeen: !!deps.getState('ftuSeen', false),
      autostartAllowed: autostart.allowed()
    };
  });
  guardOn('welcome:done', (_e, payload) => {
    // Every exit path lands here — so this handler owns the consequences:
    // put the guide away, remember it was seen, hand off to Settings on request.
    // A boolean payload is the older "open Settings?" signal and does not touch
    // startup. An object may also carry applyAutostart, honored only the first
    // time and only for an installed copy (portable must not rewrite the shared
    // config flag).
    const openSettings = payload === true || !!(payload && typeof payload === 'object' && payload.openSettings);
    const first = !deps.getState('ftuSeen', false);
    const apply = payload && typeof payload === 'object' && typeof payload.applyAutostart === 'boolean'
      ? payload.applyAutostart : null;
    welcome.close();
    if (first && apply !== null && autostart.allowed()) {
      try { autostart.set(apply); }
      catch (err) { log.warn('autostart from welcome failed:', err && err.message); }
      try {
        const cur = JSON.parse(JSON.stringify(store.get()));
        if (!!cur.behavior.autostart !== apply) {
          cur.behavior.autostart = apply;
          store.set(cur);
        }
      } catch (err) {
        log.warn('could not save welcome autostart choice:', err && err.message);
      }
    }
    deps.setState('ftuSeen', true);   // UI state, not config — rides in state.json
    if (openSettings) settings.open();
  });

  guardHandle('sys:catalog', () => sys.CATALOG);
  guardHandle('apps:list', (ev, force) => apps.listApps(!!force));
  guardHandle('app:version', () => app.getVersion());
  guardHandle('env:get', () => ({ vibrant: supportsVibrancy() }));
  guardOn('settings:close', () => settings.close());
  guardOn('app:quit', () => deps.quitApp());
}

module.exports = { registerIpc };

