'use strict';
/* Login-at-startup via Electron's first-party API. The truth shown in the UI is the
   config value (source of truth); the registry write is verified best-effort.

   Only an installed NSIS copy may ADD a login item. A portable exe, an unpacked
   build, or `electron.exe` from a dev tree all move or disappear, and a Run key
   pointing at them is both a broken startup entry and the persistence pattern
   scanners flag. Turning startup OFF still targets this process's own exe, so a
   dev or portable launch cannot delete the installed app's entry — they share
   %APPDATA%\Radial Wheel. */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const ARGS = ['--hidden'];

/** True when this process is the NSIS-installed app, not portable / unpacked / dev. */
function allowsLoginItem({ packaged, portableFile, hasUninstaller }) {
  return packaged === true && !portableFile && hasUninstaller === true;
}

/** electron-builder names the NSIS uninstaller "Uninstall <product>.exe". */
function hasUninstallerBeside(exePath) {
  let names;
  try { names = fs.readdirSync(path.dirname(exePath)); }
  catch { return false; }
  return names.some((n) => /^uninstall .+\.exe$/i.test(n));
}

function allowed() {
  return allowsLoginItem({
    packaged: !!(app && app.isPackaged),
    portableFile: process.env.PORTABLE_EXECUTABLE_FILE,
    hasUninstaller: hasUninstallerBeside(process.execPath)
  });
}

function set(enabled) {
  const on = !!enabled;
  if (on && !allowed()) {
    return { ok: false, error: 'Startup is only available in the installed app.', enabled: true };
  }
  try {
    app.setLoginItemSettings({ openAtLogin: on, args: ARGS, path: process.execPath });
    const st = app.getLoginItemSettings({ args: ARGS });
    return { ok: true, verified: !!st.openAtLogin, enabled: on };
  } catch (e) {
    return { ok: false, error: e.message, enabled: on };
  }
}

function get() {
  try {
    return app.getLoginItemSettings({ args: ARGS }).openAtLogin;
  } catch {
    return null; // unknown — UI falls back to the config flag
  }
}

module.exports = { set, get, allowed, allowsLoginItem, hasUninstallerBeside };
