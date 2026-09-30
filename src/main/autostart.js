'use strict';
/* Login-at-startup via Electron's first-party API. The truth shown in the UI is the
   config value (source of truth); the registry write is verified best-effort. */
const { app } = require('electron');

const ARGS = ['--hidden'];

function set(enabled) {
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, args: ARGS, path: process.execPath });
    const st = app.getLoginItemSettings({ args: ARGS });
    return { ok: true, verified: !!st.openAtLogin, enabled: !!enabled };
  } catch (e) {
    return { ok: false, error: e.message, enabled: !!enabled };
  }
}

function get() {
  try {
    return app.getLoginItemSettings({ args: ARGS }).openAtLogin;
  } catch {
    return null; // unknown — UI falls back to the config flag
  }
}

module.exports = { set, get };
