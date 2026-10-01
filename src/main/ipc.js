'use strict';
const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const actions = require('./actions');
const autostart = require('./autostart');
const apps = require('./apps');
const dashboardIcons = require('./dashboard-icons');
const sys = require('./sys');
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
    'wheel:segment-click': ['wheel'], 'wheel:dismiss': ['wheel'],
    'welcome:done': ['welcome'], 'settings:close': ['settings'], 'app:quit': ['settings']
  };
  const SEND_CHANNELS = new Set(['config:flush', 'wheel:segment-click', 'wheel:dismiss', 'welcome:done', 'settings:close', 'app:quit']);
  const refused = (ch, ev) => {
    console.warn(`[radial-wheel] refused ${ch} from an untrusted frame`);
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
    if (!live) { console.warn('[radial-wheel] ignored segment click for unknown item', item && item.id); return; }
    item = live;
    // sys.ALIAS forms (volup, clipboard, …) canonicalize through the same map
    // sys.run() uses, so aliased key-actions get the focus-regain wait too.
    const sysKey = sys.ALIAS[String(item.value || '').toLowerCase()] || String(item.value || '').toLowerCase();
    const isKeyAction = item.type === 'macro' || (item.type === 'sys' &&
      ['screenshot', 'show_desktop', 'clipboard_history', 'emoji_picker', 'mute', 'volume_up', 'volume_down'].includes(sysKey));
    if (isKeyAction) await new Promise((r) => setTimeout(r, 120)); // let the former window regain focus
    try {
      await actions.executeAction(item, { quit: () => deps.quitApp() });
    } catch (err) {
      if (tray) tray.balloon(`${item && item.label ? item.label : 'Action'} failed`, String(err && err.message || err), 'error');
      else console.error('[radial-wheel] action failed:', item && item.label, err && err.message);
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
    catch (err) { console.error('[radial-wheel] exit-flush save failed:', err && err.message); }
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
    registered: autostart.get()
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

  /* ---- dashboard icons (logos for wheel items) ---- */
  dashboardIcons.configure(path.join(app.getPath('userData'), 'icons', 'dashboard'));
  const ringItems = (cfg) => (cfg && cfg.rings ? Object.values(cfg.rings) : [])
    .flatMap((a) => Array.isArray(a) ? a : []);
  guardHandle('icons:search', (ev, query) => dashboardIcons.searchIcons(query));
  guardHandle('icons:fetch', (ev, slug) => dashboardIcons.fetchIcon(slug));
  guardHandle('icons:data-url', (ev, slug) => dashboardIcons.dataUrlFor(slug));
  // Prime the disk cache so the wheel never has to wait on a download to show a logo.
  dashboardIcons.warm(ringItems(store.get()).map((it) => it.iconImage));
  store.on('changed', ({ config }) => dashboardIcons.warm(ringItems(config).map((it) => it.iconImage)));

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
      hasWheel
    };
  });
  guardOn('welcome:done', (_e, openSettings) => {
    // Every exit path lands here — so this handler owns all three consequences:
    // put the guide away, remember it was seen, hand off to Settings on request.
    welcome.close();
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

