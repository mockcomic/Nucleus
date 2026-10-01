'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* Per-page API scoping (defense-in-depth): each renderer gets ONLY the
   channels it legitimately uses. A compromised overlay or welcome page can
   no longer reach setConfig / previewAction / requestQuit through a stray
   XSS, because those functions were never bridged into its world.
   location.pathname distinguishes the pages: .../renderer/<page>/index.html
   (same shape packaged under asar and unpacked in dev). */
const page = (() => {
  try { return String(location.pathname).replace(/\\/g, '/'); }
  catch { return ''; }
})();
const on = (name) => page.includes('/renderer/' + name + '/');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const send = (ch) => (...args) => ipcRenderer.send(ch, ...args);

/* The overlay's whole surface — four channels, nothing more. */
const wheelSurface = {
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  clickSegment: (item) => ipcRenderer.send('wheel:segment-click', item),
  dismiss: () => ipcRenderer.send('wheel:dismiss'),
  iconDataUrl: invoke('icons:data-url')
};

/* The settings window's full surface (settings.js codes against
   window.wheelAPI, so the complete object is exposed under BOTH names there). */
const settingsSurface = {
  getConfig: invoke('config:get'),
  // Fire-and-forget exit flush: send() is synchronous into main, so the last
  // debounced edits still land when the window is torn down at app quit.
  flushConfig: send('config:flush'),
  setConfig: invoke('config:set'),
  setHotkey: invoke('hotkey:set'),
  getAutostart: invoke('autostart:get'),
  setAutostart: invoke('autostart:set'),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pick-file', opts || {}),
  installedApps: (force) => ipcRenderer.invoke('apps:list', !!force),
  searchIcons: invoke('icons:search'),
  fetchIcon: invoke('icons:fetch'),
  iconDataUrl: invoke('icons:data-url'),
  previewAction: invoke('action:preview'),
  testWheel: invoke('overlay:show'),
  exportConfig: invoke('config:export'),
  importConfig: invoke('config:import'),
  resetConfig: invoke('config:reset'),
  openConfigFolder: invoke('config:open-folder'),
  sysCatalog: invoke('sys:catalog'),
  appVersion: invoke('app:version'),
  env: invoke('env:get'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  requestQuit: () => ipcRenderer.send('app:quit'),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg))
};

if (on('settings')) {
  contextBridge.exposeInMainWorld('wheelAPI', Object.assign({}, wheelSurface, settingsSurface));
  contextBridge.exposeInMainWorld('settingsAPI', settingsSurface);
} else {
  // Overlay (and any stray page): the slim surface only. Welcome gets nothing
  // beyond welcomeAPI — it never touched wheelAPI.
  contextBridge.exposeInMainWorld('wheelAPI', on('wheel') ? wheelSurface : {});
}

/* First-time-use welcome surface — welcome page only. */
if (on('welcome')) {
  contextBridge.exposeInMainWorld('welcomeAPI', {
    getConfig: invoke('config:get'),
    info: invoke('welcome:info'),
    setHotkey: invoke('hotkey:set'),
    testWheel: invoke('overlay:show'),
    finish: (openSettings) => ipcRenderer.send('welcome:done', !!openSettings),
    onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, payload) => cb(payload)),
    onReset: (cb) => ipcRenderer.on('welcome:reset', () => cb())
  });
}
