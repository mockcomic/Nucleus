'use strict';
/* System tray: resident icon, quick menu, error balloons. */
const { Tray, Menu, nativeImage, app } = require('electron');
const hotkeys = require('./hotkeys');
const log = require('./logger');

class TrayManager {
  constructor(icons, handlers) {
    this.handlers = handlers;
    this.image = nativeImage.createFromPath(icons.tray32);
    if (this.image.isEmpty()) {
      // A blank tray icon is the only visible symptom of a missing/corrupt
      // PNG under userData — make noise in the log, and stay functional.
      log.warn('tray icon missing or empty:', icons && icons.tray32);
    }
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
    // safeDisp() renders mouse triggers too: "Middle click", not "mmiddle".
    let tip = cfg ? `Nucleus — ${safeDisp(cfg.hotkey)}` : 'Nucleus';
    const game = this.handlers.getGameMode ? this.handlers.getGameMode() : null;
    if (this.paused) tip += ' — paused';
    else if (game && game.active) tip += ` — Game mode: paused (${game.reason || 'game'})`;
    return tip;
  }

  update() {
    if (!this.tray) return;
    this.tray.setToolTip(this._tip());
    this._rebuildMenu();
  }

  _rebuildMenu() {
    if (!this.tray) return;
    const cfg = this.getCfg();
    const game = this.handlers.getGameMode ? this.handlers.getGameMode() : null;
    const template = [
      // The hotkey shown here is the SUMMON trigger — it belongs on "Show
      // wheel", not on "Open Settings" (the old label implied the hotkey
      // opened Settings, which it never does).
      { label: `Show wheel  (${safeDisp(cfg.hotkey)})`, click: () => this.handlers.onShowWheel() },
      { label: 'Open Settings', click: () => this.handlers.onOpenSettings() },
      { label: 'Show welcome…', click: () => this.handlers.onShowWelcome() },
      { type: 'separator' },
      { label: 'Reload config from disk', click: () => this.handlers.onReload() },
      { label: 'Open logs…', click: () => this.handlers.onOpenLogs && this.handlers.onOpenLogs() },
      { label: 'Pause hotkey', type: 'checkbox', checked: this.paused, click: (mi) => { this.paused = mi.checked; this.handlers.onPauseToggle(mi.checked); } }
    ];
    // Gaming mode shows itself (and why) but needs no interaction — "Show wheel"
    // above stays enabled as the deliberate escape hatch.
    if (game && game.active) template.push({ label: `Game mode: paused (${game.reason || 'game'})`, enabled: false });
    template.push({ type: 'separator' }, { label: 'Quit Nucleus', click: () => this.handlers.onQuit() });
    this.tray.setContextMenu(Menu.buildFromTemplate(template));
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
