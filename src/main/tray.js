'use strict';
/* System tray: resident icon, quick menu, error balloons. */
const { Tray, Menu, nativeImage, app } = require('electron');
const hotkeys = require('./hotkeys');

class TrayManager {
  constructor(icons, handlers) {
    this.handlers = handlers;
    this.image = nativeImage.createFromPath(icons.tray32);
    this.tray = null;
    this.paused = false;
  }

  build(getCfg) {
    this.getCfg = getCfg;
    this.tray = new Tray(this.image);
    this.tray.setToolTip(this._tip());
    this.tray.on('double-click', () => this.handlers.onOpenSettings());
    this._rebuildMenu();
  }

  _tip() {
    const cfg = this.getCfg ? this.getCfg() : null;
    return cfg ? `Radial Wheel — ${cfg.hotkey}` : 'Radial Wheel';
  }

  update() {
    if (!this.tray) return;
    this.tray.setToolTip(this._tip());
    this._rebuildMenu();
  }

  _rebuildMenu() {
    if (!this.tray) return;
    const cfg = this.getCfg();
    const menu = Menu.buildFromTemplate([
      { label: 'Show wheel', accelerator: undefined, click: () => this.handlers.onShowWheel() },
      { label: `Open Settings  (${hotkeys.parse ? safeDisp(cfg.hotkey) : cfg.hotkey})`, click: () => this.handlers.onOpenSettings() },
      { type: 'separator' },
      { label: 'Reload config from disk', click: () => this.handlers.onReload() },
      { label: 'Pause hotkey', type: 'checkbox', checked: this.paused, click: (mi) => { this.paused = mi.checked; this.handlers.onPauseToggle(mi.checked); } },
      { type: 'separator' },
      { label: 'Quit Radial Wheel', click: () => this.handlers.onQuit() }
    ]);
    this.tray.setContextMenu(menu);
  }

  balloon(title, content, type = 'info') {
    if (!this.tray) return;
    try {
      this.tray.displayBalloon({ title, content, iconType: type === 'error' ? 'error' : 'info', largeIcon: false });
    } catch { /* balloons are best-effort */ }
  }

  destroy() { if (this.tray) { this.tray.destroy(); this.tray = null; } }
}

function safeDisp(spec) {
  try { return hotkeys.HotkeyManager.display(hotkeys.parse(spec)); }
  catch { return spec; }
}

module.exports = { TrayManager };
