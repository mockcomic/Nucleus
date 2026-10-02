'use strict';
/* First-time-use welcome window. A small fixed-size guide shown once per
   Windows user (state.json 'ftuSeen'), replayable from the tray. Frameless
   with a -webkit-app-region drag strip; the renderer owns all content and
   calls welcome:done on every exit path, and main answers that call by
   closing the window (so a bare X, Esc, Done and Open Settings all land
   here) plus marking it seen. */
const { app, BrowserWindow, screen } = require('electron');
const path = require('path');

const PRELOAD = path.join(__dirname, '..', 'preload', 'index.js');

const WELCOME_W = 560;
const WELCOME_H = 480;

class WelcomeWindow {
  constructor(deps) {
    this.deps = deps; // { getConfig, isQuitting }
    this.win = null;
  }

  open() {
    if (this.win && !this.win.isDestroyed()) {
      // Reuse (never re-load): walk a replayed guide back to step 1, since the
      // page kept whatever step the previous run ended on.
      this.send('welcome:reset');
      this.win.show(); this.win.focus(); return this.win;
    }
    // Center on the display the cursor is on — same "appears where the hand
    // is" logic the overlay uses, at window scale.
    const cur = screen.getCursorScreenPoint();
    const disp = screen.getDisplayMatching({ x: cur.x, y: cur.y, width: 1, height: 1 });
    const wa = disp.workArea;
    const x = Math.round(wa.x + (wa.width - WELCOME_W) / 2);
    const y = Math.round(wa.y + (wa.height - WELCOME_H) / 2);

    const colors = (this.deps.getConfig() || {}).appearance?.colors || {};
    this.win = new BrowserWindow({
      width: WELCOME_W, height: WELCOME_H, x, y,
      title: 'Radial Wheel — Welcome',
      backgroundColor: colors.bg || '#0f1419',
      frame: false, resizable: false, maximizable: false, fullscreenable: false,
      minimizable: true, skipTaskbar: false, alwaysOnTop: false,
      autoHideMenuBar: true, useContentSize: true, show: false,
      icon: path.join(app.getPath('userData'), 'icons', 'tray-32.png'),
      webPreferences: {
        preload: PRELOAD, contextIsolation: true, nodeIntegration: false,
        sandbox: true, devTools: !app.isPackaged
      }
    });
    this.win.setMenuBarVisibility(false);
    require('./windows').attachLogHooks(this.win, 'welcome');
    this.win.loadFile(path.join(__dirname, '..', 'renderer', 'welcome', 'index.html'));
    this.win.once('ready-to-show', () => {
      if (this.win && !this.win.isDestroyed()) { this.win.show(); this.win.focus(); }
    });
    this.win.on('close', (e) => {
      // Hide instead of destroy unless quitting — reopening must not re-load
      // the page, and the tray-resident app never dies with its windows.
      if (!this.deps.isQuitting()) { e.preventDefault(); this.hide(); }
    });
    return this.win;
  }

  isVisible() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  hide() { if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide(); }

  /* The FTU exit path (Done / Open Settings / Esc / ✕). Hiding is what actually
     takes it off screen — marking 'ftuSeen' does not — and the window survives so
     the tray replay costs nothing (see the 'close' handler above). */
  close() { this.hide(); }

  send(channel, payload) {
    if (this.win && !this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  destroy() { if (this.win && !this.win.isDestroyed()) this.win.destroy(); this.win = null; }
}

module.exports = { WelcomeWindow };
