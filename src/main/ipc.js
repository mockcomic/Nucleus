'use strict';
const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const actions = require('./actions');
const autostart = require('./autostart');
const apps = require('./apps');
const sys = require('./sys');
const { supportsVibrancy } = require('./windows');

/**
 * deps = { store, hotkeyMgr, overlay, settings, tray, getState, setState,
 *          registerHotkey, toggleWheel, quitApp, isQuitting }
 */
function registerIpc(deps) {
  const { store, overlay, settings, tray } = deps;

  const broadcast = (channel, payload) => settings.send(channel, payload);

  /* ---- wheel overlay events ---- */
  ipcMain.on('wheel:dismiss', () => overlay.hide());

  ipcMain.on('wheel:segment-click', async (e, item) => {
    overlay.hide();
    const cfg = store.get();
    const isKeyAction = item && (item.type === 'macro' || (item.type === 'sys' &&
      ['screenshot', 'show_desktop', 'clipboard_history', 'emoji_picker', 'mute', 'volume_up', 'volume_down'].includes(String(item.value).toLowerCase())));
    if (isKeyAction) await new Promise((r) => setTimeout(r, 120)); // let the former window regain focus
    try {
      await actions.executeAction(item, { quit: () => deps.quitApp() });
    } catch (err) {
      tray.balloon(`${item && item.label ? item.label : 'Action'} failed`, String(err && err.message || err), 'error');
    }
  });

  /* ---- config ---- */
  ipcMain.handle('config:get', () => ({
    config: JSON.parse(JSON.stringify(store.get())),
    hotkeyError: store.hotkeyError || null,
    importedFrom: store.importedFrom || null,
    broken: !!store.broken
  }));

  ipcMain.handle('config:set', (ev, cfg) => {
    const merged = store.set(cfg);
    store.broken = false;   // a successful write means config.json is healthy again
    return { ok: true, config: JSON.parse(JSON.stringify(merged)), hotkeyError: store.hotkeyError || null };
  });

  ipcMain.handle('config:export', async (ev) => {
    const w = settings.win;
    const r = await dialog.showSaveDialog(w, {
      title: 'Export config', defaultPath: 'radial-wheel-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    fs.writeFileSync(r.filePath, JSON.stringify(store.get(), null, 2), 'utf8');
    return { ok: true, path: r.filePath };
  });

  ipcMain.handle('config:import', async () => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Import config', filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    try {
      const raw = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
      const merged = store.set(raw);
      store.broken = false;
      return { ok: true, config: merged, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: 'Invalid config file: ' + (err.message || err) };
    }
  });

  ipcMain.handle('config:reset', () => {
    const merged = store.set({}); // validate({}) == defaults
    store.broken = false;
    return { ok: true, config: merged, hotkeyError: store.hotkeyError || null };
  });

  ipcMain.handle('config:open-folder', () => shell.openPath(path.dirname(store.file())));

  /* ---- hotkey ---- */
  ipcMain.handle('hotkey:set', (ev, spec) => {
    const prev = store.get();
    const res = deps.registerHotkey(spec, { persist: false });
    if (!res.ok) return { ok: false, error: res.error };
    store.set({ ...JSON.parse(JSON.stringify(prev)), hotkey: spec });
    return { ok: true, accel: res.accel };
  });

  /* ---- autostart ---- */
  ipcMain.handle('autostart:get', () => ({
    enabled: store.get().behavior.autostart,
    registered: autostart.get()
  }));
  ipcMain.handle('autostart:set', (ev, on) => {
    const r = autostart.set(on);
    const merged = store.set({ ...JSON.parse(JSON.stringify(store.get())) }); // keep flag authoritative
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, verified: r.verified };
  });

  /* ---- misc ---- */
  ipcMain.handle('dialog:pick-file', async (ev, opts) => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: opts.title || 'Choose a file',
      properties: ['openFile'],
      filters: opts.extensions && opts.extensions.length
        ? [{ name: 'Programs', extensions: opts.extensions }, { name: 'All files', extensions: ['*'] }]
        : undefined
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('action:preview', async (ev, item) => {
    try {
      await actions.executeAction(item, { quit: () => deps.quitApp() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  ipcMain.handle('overlay:show', () => { deps.toggleWheel(true); return { ok: true }; });

  ipcMain.handle('sys:catalog', () => sys.CATALOG);
  ipcMain.handle('apps:list', (ev, force) => apps.listApps(!!force));
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('env:get', () => ({ vibrant: supportsVibrancy() }));
  ipcMain.on('settings:close', () => settings.close());
  ipcMain.on('app:quit', () => deps.quitApp());
}

module.exports = { registerIpc };
