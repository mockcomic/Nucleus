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

/* The overlay's whole surface — a handful of channels, nothing more. */
const wheelSurface = {
  onShow: (cb) => ipcRenderer.on('overlay:show', (_e, payload) => cb(payload)),
  clickSegment: (item) => ipcRenderer.send('wheel:segment-click', item),
  dismiss: () => ipcRenderer.send('wheel:dismiss'),
  // Ask main to enlarge the transparent window (flyout beyond the outer ring).
  growCanvas: (reachPx) => ipcRenderer.send('wheel:grow', reachPx),
  // "A type-to-filter query is on screen" — while true, main lets Esc reach
  // the page so the first press clears the query instead of dismissing. The
  // volume-mixer panel rides the same flag: while it is open, Esc belongs to
  // the page (first press closes the panel, second dismisses the wheel).
  setFiltering: (on) => ipcRenderer.send('wheel:filter', !!on),
  iconDataUrl: invoke('icons:data-url'),
  // The `mixer` segment's in-wheel volume panel: reads are ungated catalog-
  // class lookups; the three writers are frame-gated to the wheel page in main
  // and clamp volume/pid/endpoint-id before anything reaches Core Audio. The
  // device pickers switch the SYSTEM default output/input device — granted to
  // the overlay deliberately, alongside the level writers (see the PRIVILEGED
  // map in main/ipc.js and the owner-list assertions in
  // tests/unit/ipc-gating.test.js).
  audioAvailable: invoke('audio:available'),
  audioDevices: invoke('audio:devices'),
  audioLevels: invoke('audio:levels'),
  audioSessions: invoke('audio:sessions'),
  audioSetDefault: invoke('audio:set-default'),
  audioSetVolume: invoke('audio:set-volume'),
  audioSetSession: invoke('audio:set-session')
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
  // Custom segment art: both answer the installed {ok, key, dataUrl} so the row
  // can paint immediately. The open dialog lives in main, not here.
  pickIconImage: invoke('icons:pick-image'),
  addIconFromUrl: invoke('icons:add-url'),
  previewAction: invoke('action:preview'),
  testWheel: invoke('overlay:show'),
  exportConfig: invoke('config:export'),
  exportBundle: invoke('config:export-bundle'),
  importConfig: invoke('config:import'),
  resetConfig: invoke('config:reset'),
  clearUsage: invoke('usage:clear'),
  // Advanced → Usage: fire counts joined to the live config (main owns the data).
  usageStats: invoke('usage:stats'),
  // Advanced → Restore a backup…: the rolling config backups and their picker.
  listBackups: invoke('config:backups'),
  restoreBackup: invoke('config:restore-backup'),
  openConfigFolder: invoke('config:open-folder'),
  openLogsFolder: invoke('log:open-folder'),
  sysCatalog: invoke('sys:catalog'),
  // Audio: Settings-window controls for endpoints and the mixer. The three
  // writers (setDefault/setVolume/setSession) are Settings-gated in main;
  // the reads are plain lookups like sysCatalog.
  audioAvailable: invoke('audio:available'),
  audioDevices: invoke('audio:devices'),
  audioLevels: invoke('audio:levels'),
  audioSessions: invoke('audio:sessions'),
  audioSetDefault: invoke('audio:set-default'),
  audioSetVolume: invoke('audio:set-volume'),
  audioSetSession: invoke('audio:set-session'),
  // type: 'setting' — the app-setting dropdown (read-only catalog; the toggle
  // itself runs in main when the segment fires).
  appSettingsCatalog: invoke('appsettings:catalog'),
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
    finish: (payload) => {
      if (payload && typeof payload === 'object') {
        ipcRenderer.send('welcome:done', {
          openSettings: !!payload.openSettings,
          applyAutostart: typeof payload.applyAutostart === 'boolean' ? payload.applyAutostart : null
        });
      } else {
        ipcRenderer.send('welcome:done', !!payload);
      }
    },
    onConfigChanged: (cb) => ipcRenderer.on('config:changed', (_e, payload) => cb(payload)),
    onReset: (cb) => ipcRenderer.on('welcome:reset', () => cb())
  });
}

/* ---- renderer diagnostics → main's log file ----
   A packaged app has no console anyone can read; page console.* and thrown
   errors would evaporate. The real console methods stay untouched — pages
   call window.console.error etc., so we swap those properties with thin
   shims that forward a stringified line to main ('log:line') and delegate
   to the original. Runs in the main world, so it can inspect page values
   (Error stacks); everything is try/caught: diagnostics never break the UI,
   and send() is synchronous so crash-time lines still land. Chromium's own
   console-message events (uncaught exceptions, network errors) are hooked
   separately on the webContents side. */
(() => {
  const page = ((location.pathname.match(/renderer\/(\w+)\//) || [])[1]) || 'page';
  const fmt = (v, d) => {
    try {
      if (typeof v === 'string') return v;
      if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
      if (v === undefined) return 'undefined';
      if (typeof v === 'function') return '[Function]';
      if (typeof v === 'object' && v !== null) {
        if (d > 1) return Array.isArray(v) ? '[Array]' : '[Object]';
        return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? String(x) : x)) ?? String(v);
      }
      return String(v);
    } catch { return '[unformattable]'; }
  };
  const send = (level, args) => {
    try {
      ipcRenderer.send('log:line', {
        level, page,
        args: Array.prototype.map.call(args, (a) => fmt(a, 0)).join(' ').slice(0, 1500)
      });
    } catch { /* diagnostics are never allowed to break the page */ }
  };
  const hook = (win) => {
    try {
      const c = win.console; if (!c || c.__rwHooked) return;
      c.__rwHooked = true;
      for (const m of ['log', 'info', 'warn', 'error', 'debug']) {
        const orig = typeof c[m] === 'function' ? c[m].bind(c) : null;
        c[m] = (...a) => {
          send(m === 'log' ? 'info' : m, a);   // page console.log is info-level
          if (orig) { try { orig(...a); } catch { /* ignore */ } }
        };
      }
    } catch { /* frozen console etc. — stay silent */ }
  };
  hook(window);
})();
