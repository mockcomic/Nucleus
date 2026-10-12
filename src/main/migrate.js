'use strict';
/* One-time profile migration for the Radial Wheel → Nucleus rename.

   Electron derives userData from productName, so the rename moves the profile
   from %APPDATA%\Radial Wheel to %APPDATA%\Nucleus. On the first Nucleus
   launch we copy everything the new profile does not have yet (config, state,
   icons, backups) out of the old one, then drop a marker so the scan happens
   exactly once. The old directory is never deleted — an upgrade can always be
   rolled back, and nothing of the user's is thrown away.

   Plain fs, no Electron deps: unit-testable without a profile. Total by
   contract: any failure skips the file and never throws into startup. */
const fs = require('fs');
const path = require('path');

const LEGACY_DIR_NAME = 'Radial Wheel';
const MARKER = '.nucleus-migrated';

function copyNoOverwrite(srcDir, destDir, stats) {
  let entries;
  try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === MARKER) continue;
    const s = path.join(srcDir, e.name);
    const d = path.join(destDir, e.name);
    try {
      if (e.isDirectory()) {
        fs.mkdirSync(d, { recursive: true });
        copyNoOverwrite(s, d, stats);
      } else if (e.isFile()) {
        if (fs.existsSync(d)) continue;
        fs.copyFileSync(s, d);
        stats.files++;
      }
    } catch { stats.failed++; }
  }
}

/**
 * Copy appData/Radial Wheel -> userData when the legacy profile has a config
 * and the migration marker is absent. Returns { files, failed } when a
 * migration ran, null when nothing was to do. Never throws.
 */
function migrateProfile({ appData, userData }) {
  if (!appData || !userData) return null;
  const legacy = path.join(appData, LEGACY_DIR_NAME);
  if (legacy === userData) return null;
  try {
    if (fs.existsSync(path.join(userData, MARKER))) return null;
    if (!fs.existsSync(path.join(legacy, 'config.json'))) return null;
    fs.mkdirSync(userData, { recursive: true });
    const stats = { files: 0, failed: 0 };
    copyNoOverwrite(legacy, userData, stats);
    try { fs.writeFileSync(path.join(userData, MARKER), `migrated from ${legacy} ${new Date().toISOString()}\n`, 'utf8'); } catch { /* marker is best-effort; a rerun re-copies only missing files */ }
    return stats;
  } catch { return null; }
}

/* Stale launch targets left behind by the rename. A migrated config can still
   carry app segments whose value points at the OLD Start-Menu shortcut (or
   the old exe name) — the rename deleted those files, so firing the segment
   spawns `cmd start ""` on a path that no longer exists: silently nothing
   happens (the launch is fire-and-forget, so even ipc.js never sees an
   error). Rewrite only when the old path is truly gone AND the new-name file
   sits next to it — a user who pinned a same-named program from elsewhere
   keeps their choice untouched. */
const STALE_APP_TARGETS = [
  { re: /^radial[- ]wheel\.lnk$/i, replacement: 'Nucleus.lnk' },
  { re: /^radial[- ]wheel\.exe$/i, replacement: 'Nucleus.exe' }
];

function repairStaleAppTargets(userData, { exists = fs.existsSync } = {}) {
  const cfgPath = path.join(userData, 'config.json');
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); } catch { return 0; }
  let changed = 0;
  const fixList = (items) => {
    if (!Array.isArray(items)) return;
    for (const it of items) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'app' && typeof it.value === 'string') {
        const bare = it.value.replace(/^"|"$/g, '');
        const hit = STALE_APP_TARGETS.find((s) => s.re.test(path.basename(bare)));
        if (hit && !exists(bare)) {
          const next = path.join(path.dirname(bare), hit.replacement);
          if (exists(next)) { it.value = next; changed++; }
        }
      }
      fixList(it.children);   // folder/recent containers
    }
  };
  const rings = cfg && cfg.rings;
  if (rings && typeof rings === 'object') for (const v of Object.values(rings)) fixList(v);
  if (changed) { try { fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2)); } catch { return 0; } }
  return changed;
}

/* Electron wiring: run once at startup, log the outcome, never break boot. */
function runOnce(app) {
  let stats = null;
  try { stats = migrateProfile({ appData: app.getPath('appData'), userData: app.getPath('userData') }); } catch { return false; }
  /* The stale-target repair runs on EVERY boot (marker or not): an already
     migrated profile can still hold the dead shortcut, and it must be fixed
     before the ConfigStore ever reads config.json — main.js calls us first. */
  try {
    const n = repairStaleAppTargets(app.getPath('userData'));
    if (n) require('./logger').info(`repaired ${n} stale launch target(s) after the rename`);
  } catch { /* fail-soft like everything else here */ }
  if (!stats) return false;
  const msg = `profile migrated from %APPDATA%\\${LEGACY_DIR_NAME} — ${stats.files} file(s)${stats.failed ? `, ${stats.failed} failed` : ''}`;
  try { require('./logger').info(msg); } catch { console.log(`[nucleus] ${msg}`); }
  return true;
}

module.exports = { LEGACY_DIR_NAME, MARKER, migrateProfile, repairStaleAppTargets, runOnce };
