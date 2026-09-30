'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/* Wheel overlay surface */
contextBridge.exposeInMainWorld('wheelAPI', {
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  clickSegment: (item) => ipcRenderer.send('wheel:segment-click', item),
  dismiss: () => ipcRenderer.send('wheel:dismiss'),

  /* Settings surface */
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  setHotkey: (spec) => ipcRenderer.invoke('hotkey:set', spec),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (on) => ipcRenderer.invoke('autostart:set', on),
  pickFile: (opts) => ipcRenderer.invoke('dialog:pick-file', opts || {}),
  installedApps: (force) => ipcRenderer.invoke('apps:list', !!force),
  previewAction: (item) => ipcRenderer.invoke('action:preview', item),
  testWheel: () => ipcRenderer.invoke('overlay:show'),
  exportConfig: () => ipcRenderer.invoke('config:export'),
  importConfig: () => ipcRenderer.invoke('config:import'),
  resetConfig: () => ipcRenderer.invoke('config:reset'),
  openConfigFolder: () => ipcRenderer.invoke('config:open-folder'),
  sysCatalog: () => ipcRenderer.invoke('sys:catalog'),
  appVersion: () => ipcRenderer.invoke('app:version'),
  closeSettings: () => ipcRenderer.send('settings:close'),
  requestQuit: () => ipcRenderer.send('app:quit'),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, cfg) => cb(cfg))

});
