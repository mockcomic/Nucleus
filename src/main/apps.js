'use strict';
/* Installed-programs catalog for the Settings app picker.
   Sources:
     - Start Menu .lnk files (ProgramData + per-user): launchable as-is via ShellExecute
       (arguments, working dir, app user model id all handled by the shell).
     - Registry Uninstall hives (DisplayName + DisplayIcon exe) for apps without shortcuts.
   Cached in memory; JUNK filters updater/redistributable clutter. No Electron deps (testable standalone). */
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const JUNK = /(redistributable|\bruntime\b|driver(s)?\b|update for|hotfix|security update|language pack|previously installed|shared component|visual c\+\+|vc\+\+|vcredist|directx|net framework (targeting|multi-targeting|sdk)|\.net (core|shared)|templates|webview|toolkit|profiler|test runner|wql|remoting|installshield|sql server (setup|common|client))/i;

function walkLnk(dir, base, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkLnk(p, base, out);
    else if (/\.lnk$/i.test(e.name)) {
      const name = e.name.replace(/\.lnk$/i, '');
      if (/^\s*~|uninstall|website|readme|license|order/i.test(name)) continue;
      const category = path.relative(base, dir).replace(/\\/g, ' › ');
      out.push({ name, path: p, category, kind: 'menu' });
    }
  }
}

function execReg(key) {
  return new Promise((resolve) => {
    execFile('reg.exe', ['query', key, '/s', '/reg:64'],
      { timeout: 20000, maxBuffer: 48 * 1024 * 1024, windowsHide: true },
      (err, stdout) => resolve(stdout || ''));
  });
}

function parseUninstallDump(out, rootKey) {
  const results = [];
  let cur = null;
  const lines = out.split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) { continue; }
    if (!/^\s/.test(line)) {                       // subkey header line
      if (!line.startsWith(rootKey)) { cur = null; continue; }
      cur = { name: '', DisplayIcon: '', InstallLocation: '', WindowsInstaller: '' };
      results.push(cur);
      continue;
    }
    if (!cur) continue;
    const m = line.match(/^\s+(\S+)\s+REG_[A-Z_]+\s+(.*)$/);
    if (!m) continue;
    const [, key, val] = m;
    if (key === 'DisplayName') cur.name = val.trim();
    else if (key === 'DisplayIcon') cur.DisplayIcon = val.trim();
    else if (key === 'InstallLocation') cur.InstallLocation = val.trim();
    else if (key === 'WindowsInstaller') cur.WindowsInstaller = val.trim();
  }
  return results;
}

function exeFromIcon(icon) {
  // DisplayIcon forms: C:\a\b.exe  |  "C:\a\b.exe"  |  C:\a\b.exe,0  |  "C:\a\b.exe",12
  const m = String(icon || '').match(/["']?([^"',]+\.exe)["']?/i);
  if (!m) return null;
  const p = m[1].trim();
  try { if (fs.existsSync(p)) return p; } catch {}
  return null;
}

const ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'
];

let cache = null;

async function listApps(force = false) {
  if (cache && !force && Date.now() - cache.at < 5 * 60e3) return cache.items;

  const menu = [];
  const pd = process.env.ProgramData || 'C:\\ProgramData';
  walkLnk(path.join(pd, 'Microsoft\\Windows\\Start Menu\\Programs'), path.join(pd, 'Microsoft\\Windows\\Start Menu\\Programs'), menu);
  const ad = process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming');
  walkLnk(path.join(ad, 'Microsoft\\Windows\\Start Menu\\Programs'), path.join(ad, 'Microsoft\\Windows\\Start Menu\\Programs'), menu);

  const dumps = await Promise.all(ROOTS.map((r) => execReg(r).then((out) => parseUninstallDump(out, r))));
  const regEntries = dumps.flat();

  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
  const byName = new Map();
  for (const m of menu) {
    if (JUNK.test(m.name)) continue;
    const k = norm(m.name);
    if (k && !byName.has(k)) byName.set(k, { name: m.name, path: m.path, category: m.category, kind: 'menu' });
  }
  for (const r of regEntries) {
    if (!r.name || JUNK.test(r.name)) continue;
    // skip pure MSI apps (no launchable exe) — uninstallers masquerading as apps
    const exe = exeFromIcon(r.DisplayIcon);
    if (!exe) continue;
    const k = norm(r.name);
    if (k && !byName.has(k)) byName.set(k, { name: r.name, path: exe, category: 'installed', kind: 'reg' });
  }

  const items = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).slice(0, 600);
  cache = { at: Date.now(), items };
  return items;
}

module.exports = { listApps };
