'use strict';
/* Overlay (the wheel) + Settings window lifecycle. The overlay is created once at
   startup, kept hidden, then moved to the cursor and shown on demand for <100ms popups. */
const { app, BrowserWindow, screen } = require('electron');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');
const WHEEL_PAD = 26; // room for drop-shadow + hover lift
const log = require('./logger');

/* Renderer diagnostics → the log file. console.* rides the preload hook, but
   these webContents events catch what no page console call reports: Chromium's
   own network errors, a crashed render process, failed page loads. Idempotent
   per webContents so overlay re-ensure / window reuse never double-listens. */
function attachLogHooks(win, name) {
  const wc = win && win.webContents;
  if (!wc || wc.__rwLogHooks) return;
  wc.__rwLogHooks = true;
  const LEVELS = { logging: 'debug', verbose: 'debug', info: 'info', warning: 'warn', error: 'error' };
  wc.on('console-message', (e) => {
    // Older Electron shape: (event, level 0-3, message, line, sourceId).
    const d = (e && e.params) || e || {};
    const lvl = typeof d.level === 'string' ? (LEVELS[d.level] || 'info')
      : (Number(d.level) >= 3 ? 'error' : Number(d.level) === 2 ? 'warn' : Number(d.level) === 1 ? 'info' : 'debug');
    log.forwardRenderer({ level: lvl, page: name, args: d.message, source: d.sourceId || '', line: d.line });
  });
  wc.on('render-process-gone', (ev, d) => {
    log.error(`renderer '${name}' process gone: ${d && d.reason} (exit code ${d && d.exitCode})`);
  });
  wc.on('did-fail-load', (ev, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (isMainFrame) log.error(`renderer '${name}' failed to load: ${errorCode} ${errorDescription} (${validatedURL})`);
    else log.warn(`renderer '${name}' subresource failed: ${errorCode} ${errorDescription} (${validatedURL})`);
  });
}

/* Settings-window vibrancy gate: DWM acrylic needs Windows 11 22H2 (build 22621)
   with the OS "transparency effects" toggle on. Fail-soft — any doubt (old OS,
   reg read failure, exotic environment) lands on the solid opaque look. */
let _vibrant = null;
function supportsVibrancy() {
  if (_vibrant != null) return _vibrant;
  _vibrant = (() => {
    try {
      const build = parseInt(String(os.release()).split('.')[2], 10);
      if (!Number.isFinite(build) || build < 22621) return false;
      const out = execFileSync('reg',
        ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize', '/v', 'EnableTransparency'],
        { encoding: 'utf8', windowsHide: true, timeout: 2000 });
      return /EnableTransparency\s+REG_DWORD\s+0x1\b/i.test(out);
    } catch { return false; }
  })();
  return _vibrant;
}

class Overlay {
  constructor(deps) {
    this.deps = deps; // { getConfig }
    this.win = null;
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    this.win = new BrowserWindow({
      width: 120, height: 120, x: -32000, y: -32000,
      show: false, frame: false, transparent: true, resizable: false, movable: false,
      minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, alwaysOnTop: true, hasShadow: false, focusable: true,
      backgroundColor: '#00000000', useContentSize: true,
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: true, devTools: !app.isPackaged
      }
    });
    this.win.setAlwaysOnTop(true, 'screen-saver');
    attachLogHooks(this.win, 'wheel');
    this._loaded = false;
    this.win.webContents.on('did-finish-load', () => { this._loaded = true; });
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'wheel', 'index.html'));
    this.win.on('close', (e) => {
      if (!this.deps.isQuitting()) { e.preventDefault(); this.hide(); }
    });
    this.win.on('blur', () => {
      // ignore transient blur right after show() so the wheel doesn't self-dismiss
      if (this._shownAt && Date.now() - this._shownAt < 350) return;
      if (!this.deps.isQuitting()) this.hide();
    });
    this.win.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && (input.key === 'Escape' || input.key === 'Cancel')) {
        // Esc-dismiss is a user setting (Behavior → Dismiss with Esc); the live
        // config is the source of truth at the moment the key arrives.
        const bh = (this.deps.getConfig() || {}).behavior || {};
        if (bh.dismissOnEscape === false) return;
        this.hide();
        e.preventDefault();
      }
    });
    return this.win;
  }

  isVisible() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  showAtCursor() {
    const win = this.ensure();
    const cfg = this.deps.getConfig();
    const ap = cfg.appearance;
    const cur = screen.getCursorScreenPoint();
    const disp = screen.getDisplayMatching({ x: cur.x, y: cur.y, width: 1, height: 1 });

    const need = 2 * ap.outerRadius + WHEEL_PAD * 2;
    const fitMax = Math.min(disp.bounds.width, disp.bounds.height) - 16;
    const scale = Math.min(1, fitMax / need);
    const s = Math.max(64, Math.round(need * scale));

    let x = Math.round(cur.x - s / 2);
    let y = Math.round(cur.y - s / 2);
    x = Math.min(Math.max(x, disp.bounds.x), disp.bounds.x + Math.max(0, disp.bounds.width - s));
    y = Math.min(Math.max(y, disp.bounds.y), disp.bounds.y + Math.max(0, disp.bounds.height - s));

    win.setBounds({ x, y, width: s, height: s }, false);
    const payload = {
      config: JSON.parse(JSON.stringify(cfg)),
      scale,
      cursorLocal: { x: cur.x - x, y: cur.y - y }
    };
    const send = () => { if (!win.isDestroyed()) win.webContents.send('overlay:show', payload); };
    // If the pre-warm load hasn't finished (first summon right after launch,
    // or --show-wheel at 400 ms), queue the payload instead of firing it into
    // a page whose onShow listener does not exist yet — otherwise the send is
    // silently dropped and an empty (transparent) window shows.
    if (this._loaded) send();
    else win.webContents.once('did-finish-load', send);
    win.show();
    win.focus();
    this._shownAt = Date.now();
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

class SettingsWindow {
  constructor(deps) {
    this.deps = deps; // { isQuitting, getState, setState, bgColor? }
    this.win = null;
  }

  open() {
    if (this.win && !this.win.isDestroyed()) {
      this.win.show(); this.win.focus(); return this.win;
    }
    const st = this.deps.getState('settings', { width: 1120, height: 760 });
    const vibrant = supportsVibrancy();
    this.vibrant = vibrant;
    const opts = {
      width: st.width, height: st.height,
      x: typeof st.x === 'number' ? st.x : undefined,
      y: typeof st.y === 'number' ? st.y : undefined,
      minWidth: 920, minHeight: 640,
      title: 'Radial Wheel — Settings',
      backgroundColor: (this.deps.bgColor && this.deps.bgColor()) || '#0f1419',
      autoHideMenuBar: true,
      icon: path.join(app.getPath('userData'), 'icons', 'tray-32.png'),
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: true, devTools: !app.isPackaged
      }
    };
    if (vibrant) {
      // DWM paints acrylic behind the client area; the page keeps only the
      // sidebar/preview bay translucent (see settings.css html[data-vibrant]).
      // Opaque page layers (cards, modals, dropdowns, toasts) stay as they are.
      opts.backgroundColor = '#00000000';
      opts.backgroundMaterial = 'acrylic';
      opts.show = false;   // avoid a bare-backdrop flash before the page paints
    }
    this.win = new BrowserWindow(opts);
    attachLogHooks(this.win, 'settings');
    if (vibrant) {
      this.win.once('ready-to-show', () => {
        if (this.win && !this.win.isDestroyed()) this.win.show();
      });
    }
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'settings', 'index.html'));
    const persist = () => {
      if (!this.win || this.win.isDestroyed()) return;
      const b = this.win.getBounds();
      this.deps.setState('settings', b);
    };
    let t = null;
    const debouncedPersist = () => { clearTimeout(t); t = setTimeout(persist, 400); };
    this.win.on('resize', debouncedPersist);
    this.win.on('move', debouncedPersist);
    this.win.on('close', (e) => {
      persist();
      if (!this.deps.isQuitting()) { e.preventDefault(); this.win.hide(); }
    });
    return this.win;
  }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  close() { if (this.win && !this.win.isDestroyed()) this.win.close(); }
  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { Overlay, SettingsWindow, supportsVibrancy, attachLogHooks };
