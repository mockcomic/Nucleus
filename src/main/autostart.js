'use strict';
/* Login-at-startup via Electron's first-party API. The truth shown in the UI is the
   config value (source of truth); the registry write is verified best-effort.

   Only an installed NSIS copy may ADD a login item. A portable exe, an unpacked
   build, or `electron.exe` from a dev tree all move or disappear, and a Run key
   pointing at them is both a broken startup entry and the persistence pattern
   scanners flag.

   Deletion is the dangerous half on Windows: Electron's
   setLoginItemSettings({openAtLogin:false}) deletes the HKCU Run value by NAME
   alone — the `path` option is ignored on that branch (browser_win.cc) — and
   every copy of this app shares one name because main.js pins
   app.setAppUserModelId('local.radialwheel'). A portable/dev launch that
   cleared "its own" entry would therefore wipe the INSTALLED copy's login item
   — which is exactly how start-on-login kept disappearing. So every disable
   goes through an ownership check first: read the stored command line (macro
   .readRunValue, read-only FFI) and delete only when it points at THIS process's
   own exe. When the value cannot be read at all, fail closed: leave it alone. */
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const macro = require('./macro');
const log = require('./logger');

const ARGS = ['--hidden'];
/* Electron writes the Run value under the process AUMID (browser_win.cc's
   GetAppUserModelID); setAppUserModelId('local.radialwheel') makes that the
   name for every copy. The 'electron.app.<productName>' form is probed too, so
   entries created before the AUMID was pinned (or by a copy that failed to set
   it) can still be claimed or cleaned up instead of orphaning. */
const AUMID_VALUE_NAME = 'local.radialwheel';

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

/** Run-value names this app may own: the pinned AUMID, plus the AUMID fallback. */
function ownedValueNames() {
  const names = [AUMID_VALUE_NAME];
  try {
    const n = app && typeof app.getName === 'function' ? String(app.getName() || '') : '';
    if (n) names.push(`electron.app.${n}`);
  } catch { /* no getName — the AUMID name alone is still correct */ }
  return [...new Set(names)];
}

/* Test seam: unit tests inject a fake reader; production lazily goes through
   macro's guarded advapi32 probe. Reader contract (mirror macro.readRunValue):
   {state:'value', data} | {state:'absent'} | {state:'error'}. */
let runValueReader = null;
function _setRunValueReader(fn) { runValueReader = typeof fn === 'function' ? fn : null; }
function probe(name) {
  const reader = runValueReader || ((n) => (macro && macro.regProbeAvailable ? macro.readRunValue(n) : { state: 'error', code: 'unavailable' }));
  try { return reader(name); }
  catch { return { state: 'error', code: 'throw' }; }
}

const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();

/** Mirror Electron's Run-value quoting (AddQuoteForArg): the exe path always
 *  gets quoted (a Windows path contains '\'), args quoted only if they carry
 *  space/quote/backslash. 'C:\Dir\My App.exe' + ['--hidden'] ->
 *  '"C:\Dir\My App.exe" --hidden'. */
function expectedRunCommand(exePath, args) {
  const parts = [`"${exePath}"`];
  for (const a of args || []) parts.push(/[\s"\\]/.test(a) ? `"${a}"` : a);
  return parts.join(' ');
}

/** True when a stored Run command line refers to THIS exe: the exact expected
 *  command, or the bare exe path — quoted or unquoted (tolerating whatever an
 *  older Electron wrote), whitespace-normalized, case-insensitive. */
function runEntryBelongsToExe(storedData, exePath, args) {
  if (typeof storedData !== 'string' || typeof exePath !== 'string' || !exePath) return false;
  const tail = (args || []).map((a) => (/[\s"\\]/.test(a) ? `"${a}"` : a)).join(' ');
  const cands = [
    expectedRunCommand(exePath, args),
    expectedRunCommand(exePath, []),
    tail ? `${exePath} ${tail}` : exePath,
    `"${exePath}"${tail ? ' ' + tail : ''}`,
    `"${exePath}"`,
    exePath
  ];
  const stored = norm(storedData);
  return cands.some((c) => c && norm(c) === stored);
}

/* Disable with ownership proof. Never guesses: `openAtLogin:false` in Electron
   is an unconditional DeleteValue by name, so we only invoke it for values we
   have just read and confirmed point at this exe. */
function disable() {
  const exe = process.execPath;
  const probes = ownedValueNames().map((name) => ({ name, r: probe(name) }));
  if (probes.some((p) => p.r.state === 'error')) {
    log.info('autostart: could not read the login item — leaving it untouched (config stays the source of truth)');
    return { ok: true, enabled: false, skipped: 'unverified' };
  }
  const mine = probes.filter((p) => p.r.state === 'value' && runEntryBelongsToExe(p.r.data, exe, ARGS));
  if (!mine.length) {
    if (probes.some((p) => p.r.state === 'value'))
      log.info('autostart: login item belongs to another executable — left alone');
    return { ok: true, enabled: false, skipped: probes.some((p) => p.r.state === 'value') ? 'foreign' : 'absent' };
  }
  for (const p of mine) app.setLoginItemSettings({ openAtLogin: false, path: exe, name: p.name });
  const verified = !mine.some((p) => probe(p.name).state === 'value');
  return { ok: true, enabled: false, verified, removed: mine.map((p) => p.name) };
}

/* Enable from the installed copy, then reclaim any stale entries this exe also
   owns under our legacy names, and verify by reading the stored command back
   (Electron 44's registry writes are silent-failure and its getLoginItemSettings
   is an exact-string match under the AUMID name only). */
function enable() {
  const exe = process.execPath;
  app.setLoginItemSettings({ openAtLogin: true, args: ARGS, path: exe });
  for (const name of ownedValueNames()) {
    if (name === AUMID_VALUE_NAME) continue;
    const r = probe(name);
    if (r.state === 'value' && runEntryBelongsToExe(r.data, exe, ARGS)) {
      try { app.setLoginItemSettings({ openAtLogin: false, path: exe, name }); } catch { /* best effort */ }
    }
  }
  const want = norm(expectedRunCommand(exe, ARGS));
  const main = probe(AUMID_VALUE_NAME);
  let verified;
  if (main.state === 'value') verified = norm(main.data) === want;
  else {
    try { verified = !!(app.getLoginItemSettings({ args: ARGS }) || {}).openAtLogin; }
    catch { verified = false; }
  }
  return { ok: true, enabled: true, verified };
}

function set(enabled) {
  const on = !!enabled;
  try {
    if (!on) return disable();
    if (!allowed()) {
      return { ok: false, error: 'Startup is only available in the installed app.', enabled: true };
    }
    return enable();
  } catch (e) {
    return { ok: false, error: e.message, enabled: on };
  }
}

/* "Is a login item registered FOR THIS EXE?" — our own read when it works (the
   only comparison we can trust for spaced paths on Electron 44), else Electron's
   exact-match answer, else null (unknown → UI falls back to the config flag). */
function get() {
  const exe = process.execPath;
  try {
    const states = ownedValueNames().map(probe);
    if (states.every((r) => r.state !== 'error'))
      return states.some((r) => r.state === 'value' && runEntryBelongsToExe(r.data, exe, ARGS));
  } catch { /* fall through to Electron */ }
  try {
    return app.getLoginItemSettings({ args: ARGS }).openAtLogin;
  } catch {
    return null; // unknown — UI falls back to the config flag
  }
}

module.exports = {
  set, get, allowed, allowsLoginItem, hasUninstallerBeside,
  expectedRunCommand, runEntryBelongsToExe, ownedValueNames,
  _setRunValueReader
};
