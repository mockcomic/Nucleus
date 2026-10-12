'use strict';
/* Export PACKAGES — config.json plus the bytes of every custom segment icon it
   references, in ONE human-inspectable JSON file. The plain config export stays
   for the re-downloadable world (dashboard logos, URL-sourced art); a package
   is what carries art the user picked from disk, whose bytes live only under
   userData/icons/custom and would otherwise degrade to glyphs on another
   machine.

   Format (deliberately JSON, not zip — icon formats are already compressed and
   a zip dependency buys nothing here):

     { "bundle": "nucleus", "version": 1,
       "config": { …config.json verbatim… },
       "icons":  { "custom:<hash>.<kind>": { "b64": "…", "url": "origin?" } } }

   Integrity on import: keys are content-addressed, so every payload is
   re-hashed through custom-icons.keyFor() — a claimed key that does not match
   its bytes is skipped (that segment falls back to its glyph, the documented
   fail-soft), never installed under a lie. install() re-sniffs the bytes, so a
   foreign file inside the package cannot reach the wheel either.

   No Electron deps (custom-icons is plain node too) — unit-testable directly. */
const crypto = require('crypto');
const customIcons = require('./custom-icons');

/* Item walk mirroring config.js walkItems (which lives behind an Electron
   require) — rings + profile rings, folder children, depth-first. Keep the
   two in step; tests/unit/bundle.test.js pins the profile/child coverage. */
function walkItems(cfg, fn) {
  const groups = [];
  if (cfg && cfg.rings && typeof cfg.rings === 'object') groups.push(cfg.rings);
  if (cfg && Array.isArray(cfg.profiles)) {
    for (const p of cfg.profiles) if (p && p.rings && typeof p.rings === 'object') groups.push(p.rings);
  }
  const down = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      if (fn(it) === false) return false;
      if (Array.isArray(it.children) && it.children.length && down(it.children) === false) return false;
    }
    return true;
  };
  for (const rings of groups) {
    for (const k of Object.keys(rings)) if (down(rings[k]) === false) return;
  }
}

const BUNDLE_ID = 'nucleus';
/* Packages exported before the Radial Wheel → Nucleus rename carry the old
   id; importing them must keep working, exporting uses the new one. */
const LEGACY_BUNDLE_IDS = ['radial-wheel'];
const BUNDLE_VERSION = 1;
const ICON_TOTAL_MAX = 48 * 1024 * 1024;   // mirrors custom-icons DIR_TOTAL_MAX
const BUNDLE_FILE_MAX = 64 * 1024 * 1024;  // read guard applied by the caller (ipc.js)

/* Walk every item collecting custom-icon keys (rings, profiles, folder
   children). Deduped — two segments sharing one artwork cost one copy. */
function collectIconKeys(config) {
  const keys = new Set();
  walkItems(config, (it) => {
    const key = customIcons.sanitizeKey(it && it.iconImage);
    if (key) keys.add(key);
  });
  return [...keys];
}

/**
 * Build the package object for `config`.
 * deps = { readBytes(key) -> Buffer|null, sourceFor(key) -> url|null }
 * (main wires both to custom-icons; tests inject fakes).
 * Returns { ok:true, bundle, icons, skipped[] } or { ok:false, error }.
 * The size cap aborts the WHOLE export naming every oversized file — a
 * silently truncated package would import as a half-decorated wheel.
 */
function buildBundle(config, deps = {}) {
  const readBytes = deps.readBytes || customIcons.readBytes;
  const sourceFor = deps.sourceFor || customIcons.sourceFor;
  const keys = collectIconKeys(config);
  const icons = {};
  const skipped = [];
  let total = 0;
  for (const key of keys) {
    const buf = readBytes(key);
    if (!buf || !buf.length) { skipped.push(key); continue; }        // gone from the cache — the importing machine gets glyphs
    if (buf.length > customIcons.FILE_MAX_BYTES) { skipped.push(key); continue; }
    total += buf.length;
    const entry = { b64: buf.toString('base64') };
    const url = sourceFor(key);
    if (url) entry.url = url;                                          // re-downloadable origin rides along
    icons[key] = entry;
  }
  if (total > ICON_TOTAL_MAX) {
    return { ok: false, error: `The custom icons total ${(total / 1048576).toFixed(1)} MB — over the ${(ICON_TOTAL_MAX / 1048576) | 0} MB package cap (${skipped.length} missing, ${keys.length} referenced).` };
  }
  return {
    ok: true,
    icons: Object.keys(icons).length,
    skipped,
    bundle: { bundle: BUNDLE_ID, version: BUNDLE_VERSION, config: JSON.parse(JSON.stringify(config)), icons }
  };
}

/* Cheap shape gate on import: is this file a package (vs a plain config)? */
function looksLikeBundle(raw) {
  return !!(raw && typeof raw === 'object' && [BUNDLE_ID, ...LEGACY_BUNDLE_IDS].includes(raw.bundle));
}

/**
 * Install every package icon into the local content-addressed cache.
 * Returns { installed, skipped[] } — per-icon failures are skips, never
 * aborts (the config import proceeds; the wheel renders glyphs for those).
 */
function importIcons(bundleObj) {
  let installed = 0;
  const skipped = [];
  const icons = bundleObj && bundleObj.icons && typeof bundleObj.icons === 'object' ? bundleObj.icons : {};
  for (const [claimedKey, entry] of Object.entries(icons)) {
    const key = customIcons.sanitizeKey(claimedKey);
    if (!key || !entry || typeof entry !== 'object' || typeof entry.b64 !== 'string') { skipped.push(String(claimedKey).slice(0, 40)); continue; }
    let buf;
    try {
      // strict:false would let a padded/alphabet-mangled string decode to
      // junk; base64url variants are rejected too — the writer is us.
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(entry.b64)) throw new Error('bad base64');
      buf = Buffer.from(entry.b64, 'base64');
    } catch { skipped.push(key); continue; }
    const got = customIcons.install(buf, { url: typeof entry.url === 'string' ? entry.url : null });
    if (!got.ok) { skipped.push(key); continue; }
    // Content-addressed integrity: the bytes must hash to the key claimed.
    const recomputed = customIcons.keyFor(buf, got.kind);
    if (recomputed !== key) {
      skipped.push(key);
      // install() may have just written the honest-keyed copy — harmless to
      // leave (LRU prunes it); the CLAIMED key stays unclaimed, so the segment
      // that referenced it degrades to its glyph exactly as designed.
      continue;
    }
    installed++;
  }
  return { installed, skipped };
}

/* Small helper for callers that want a stable fingerprint of the bytes they
   are about to trust (currently unused by ipc — kept for test symmetry with
   custom-icons.keyFor). */
function hashBuf(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

module.exports = {
  BUNDLE_ID, LEGACY_BUNDLE_IDS, BUNDLE_VERSION, ICON_TOTAL_MAX, BUNDLE_FILE_MAX,
  collectIconKeys, buildBundle, looksLikeBundle, importIcons, hashBuf
};
