'use strict';
/* App-specific wheel profiles: which profile (if any) owns the wheel right now.
   Pure decision logic — Electron- and FFI-free so it can be unit-tested. The
   foreground probe is produced by macro.foregroundProbe() (same shape the
   gaming-mode watcher consumes: { pid, exe, … } or null) and injected by the
   caller, exactly like GameModeWatcher's injectable probe.

   Profiles are evaluated in list order; the FIRST profile whose apps list
   contains the foreground exe basename wins. A null probe (FFI failure,
   non-Windows) resolves to no profile — the default wheel always remains the
   fail-open answer. Our own windows (Settings preview pops, welcome test
   button) must never activate a profile, so our pid is excluded the same way
   gaming mode excludes it. */
const { matchAppList } = require('./gamemode');

/** True when the profile has at least one real segment to show. */
function hasRings(profile) {
  if (!profile || !profile.rings || typeof profile.rings !== 'object') return false;
  return Object.values(profile.rings).some((a) => Array.isArray(a) && a.length);
}

/**
 * probe  — { pid, exe, … } from macro.foregroundProbe(), or null.
 * Returns the matching profile object, or null (= show the default wheel).
 */
function pickProfile(config, probe, ourPid) {
  if (!config || !Array.isArray(config.profiles) || !config.profiles.length) return null;
  if (!probe) return null;                                            // fail OPEN: no probe → default wheel
  if (probe.pid && ourPid && probe.pid === ourPid) return null;       // our own windows
  const rawExe = String(probe.exe || '').toLowerCase();
  if (!rawExe) return null;
  // foregroundProbe hands us a lowercase BASENAME already; tolerate a caller
  // (or a future probe variant) that hands over the full path.
  const slash = Math.max(rawExe.lastIndexOf('/'), rawExe.lastIndexOf('\\'));
  const exe = slash >= 0 ? rawExe.slice(slash + 1) : rawExe;
  if (!exe) return null;
  for (const p of config.profiles) {
    if (!p || !Array.isArray(p.apps) || !p.apps.length) continue;     // empty app list never activates
    if (!hasRings(p)) continue;                                       // empty profile falls back, not to a blank wheel
    if (matchAppList(exe, p.apps)) return p;
  }
  return null;
}

module.exports = { pickProfile, hasRings };
