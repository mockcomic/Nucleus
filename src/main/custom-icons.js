'use strict';
/* Custom segment icons — artwork the user chose themselves: a file picked from
   disk, or an image URL pasted in Settings. Companion to the system glyph
   (item.icon) and the dashboardicons.com logo (item.iconImage slug).

   Like the dashboard cache, the config stores only an opaque KEY in
   item.iconImage — `custom:<sha256-16>.<kind>` — and the bytes live under
   userData/icons/custom. Exported configs stay small and never carry a
   megabyte of base64. Keys are content-addressed, so re-picking the same
   artwork is a no-op and two segments sharing one file share one copy.

   The difference from a dashboard slug: a slug names a public CDN, a custom
   key names bytes this app owns. A file picked from disk therefore cannot
   re-download itself onto a second machine — it degrades to the segment's
   glyph, never to a blank plate (the fail-soft the logo cache already relies
   on). A URL-picked icon records its origin in _sources.json, so a fresh
   install re-fetches it on the first summon with no user action.

   Images arrive from outside the trust boundary (a dialog pick, a pasted URL),
   so the bytes — never the extension or the server's content-type — decide
   what we accept: sniffImage() is the gate. SVG is allowed because Chromium
   loads an <img>-referenced SVG as a non-scriptable image document; the
   extra <script>/onload rejection below is belt-and-braces, not the defence.

   No Electron deps: configure() injects the cache dir, so the store and its
   pure matchers are unit-testable under plain node
   (tests/unit/custom-icons.test.js). */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { readCapped } = require('./capped-fetch');

const PREFIX = 'custom:';
const KEY_RE = /^custom:([a-f0-9]{16})\.([a-z]{3,4})$/;
const KINDS = {                                   // key suffix → data-URL mime
  png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  bmp: 'image/bmp', ico: 'image/x-icon', svg: 'image/svg+xml'
};
const FILE_MAX_BYTES = 2 * 1024 * 1024;           // a segment icon is drawn at ~26 px
const DIR_TOTAL_MAX = 48 * 1024 * 1024;           // whole-cache cap, LRU by mtime
const INDEX_MAX_ENTRIES = 400;                    // _sources.json growth guard
const FETCH_TIMEOUT = 12000;
const URL_MAX_LEN = 2000;
const SVG_PROBE_BYTES = 4096;
/* Formats offered in the Browse… dialog; the real check is the magic-byte
   sniff, so a mislabelled extension is still accepted (or rejected). */
const PICK_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];

let cacheDir = null;                              // set by configure() from main

function configure(dir) {
  cacheDir = dir;
  indexMem = null;                                // re-pointable: never serve an index from the old dir
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort; callers report */ }
}

/* ------------------------------ pure helpers ------------------------------ */

/* Only well-formed keys are honoured — the hash is hex and the suffix must be
   a known kind, so a key can never name a path outside the cache dir. Case is
   folded first (like sanitizeSlug): a hand-edited or imported config spelling
   the key upper-case must still find its artwork. */
function sanitizeKey(raw) {
  if (typeof raw !== 'string') return null;
  const k = raw.trim().toLowerCase();
  const m = KEY_RE.exec(k);
  if (!m || !KINDS[m[2]]) return null;
  return k;
}

function isCustomKey(raw) { return sanitizeKey(raw) !== null; }

function keyFor(buf, kind) {
  const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  return `${PREFIX}${hash}.${kind}`;
}

function startsWith(buf, bytes, at = 0) {
  if (buf.length < at + bytes.length) return false;
  for (let i = 0; i < bytes.length; i++) if (buf[at + i] !== bytes[i]) return false;
  return true;
}

/* Text that only claims to be SVG is rejected outright: an XML prolog or an
   <svg> root within the probe window, and no script surface at all. */
function looksLikeSvg(buf) {
  const body = buf.slice(0, SVG_PROBE_BYTES).toString('utf8');
  const head = body.replace(/^\uFEFF/, '').trimStart().toLowerCase();
  if (!head.startsWith('<svg') && !head.startsWith('<?xml')) return false;
  const low = body.toLowerCase();
  if (!low.includes('<svg')) return false;
  return !/<\s*script|javascript\s*:|\son[a-z]+\s*=/i.test(body);
}

/* The one authority on what an accepted icon is. Returns a KINDS key or null. */
function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 6 || buf.length > FILE_MAX_BYTES) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return 'jpg';
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return 'gif';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && buf.slice(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46])) return null;   // RIFF that is not WebP (wav/avi)
  if (startsWith(buf, [0x00, 0x00, 0x01, 0x00]) || startsWith(buf, [0x00, 0x00, 0x02, 0x00])) return 'ico';
  if (startsWith(buf, [0x42, 0x4d])) return 'bmp';
  if (looksLikeSvg(buf)) return 'svg';
  return null;
}

/* Paste-box hygiene: http(s) only, no embedded credentials (they would be
   written into config.json for ever), and a sane length. */
function validateUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > URL_MAX_LEN) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  if (!/[a-z0-9]/i.test(u.hostname)) return null;
  return u.href;
}

function dataUrl(kind, buf) {
  return `data:${KINDS[kind]};base64,${buf.toString('base64')}`;
}

/* ------------------------------ disk store -------------------------------- */
function filePath(keyRaw) {
  const key = sanitizeKey(keyRaw);
  if (!key || !cacheDir) return null;
  return path.join(cacheDir, key.slice(PREFIX.length));   // hash.kind — traversal-proof by construction
}

function existingFile(p, maxBytes = FILE_MAX_BYTES) {
  if (!p) return null;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size === 0 || st.size > maxBytes) return null;
    return p;
  } catch { return null; }
}

function readCache(keyRaw) {
  const p = filePath(keyRaw);
  if (!p) return null;
  try {
    const buf = fs.readFileSync(p);
    const kind = sniffImage(buf);
    if (!kind) return null;                       // a foreign/corrupt file is a miss, not a crash
    return { kind, dataUrl: dataUrl(kind, buf) };
  } catch { return null; }
}

function onDisk(keyRaw) { return !!existingFile(filePath(keyRaw)); }

/* Raw bytes for the export-package builder (bundle.js): the cache file, but
   only if the SNIFF still passes — a foreign/corrupt file in the cache is a
   miss, never smuggled into a package. */
function readBytes(keyRaw) {
  const p = filePath(keyRaw);
  if (!p) return null;
  try {
    const buf = fs.readFileSync(p);
    return sniffImage(buf) ? buf : null;
  } catch { return null; }
}

function writeStore(keyRaw, buf) {
  const p = filePath(keyRaw);
  if (!p) return false;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    if (existingFile(p)) return true;             // content-addressed: same bytes, same file
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);                        // never leave a half-written icon
    prune();
    return true;
  } catch { /* the dataUrl still works for this screen — the next read reports a miss */ return false; }
}

/* --------------------------- URL origin index ----------------------------- */
/* key → { url, added }. Lets a config exported to another machine rebuild its
   pasted-URL icons; disk-picked icons have no entry and stay glyph-only there. */
function indexPath() { return cacheDir && path.join(cacheDir, '_sources.json'); }
let indexMem = null;                              // { at, data }

function loadIndex() {
  if (indexMem) return indexMem.data;
  const p = indexPath();
  let data = {};
  if (p) {
    try {
      const st = fs.statSync(p);
      // The write path caps the entry count; the read path must cap the bytes
      // too, or one corrupted local file gets JSON.parsed on every resolve.
      if (st.size > 1024 * 1024) throw new Error('too big');
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) data = raw;
    } catch { data = {}; }                          // missing/corrupt → no origins, never a throw
  }
  indexMem = { at: Date.now(), data };
  return data;
}

function saveIndex(data) {
  const p = indexPath();
  if (!p) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, p);
    indexMem = { at: Date.now(), data };
  } catch { /* origins are a convenience; losing them costs a re-paste */ }
}

function rememberSource(key, url) {
  const data = loadIndex();
  data[key] = { url, added: Date.now() };
  const keys = Object.keys(data);
  if (keys.length > INDEX_MAX_ENTRIES) {           // oldest entries go first
    keys.sort((a, b) => ((data[a] && data[a].added) || 0) - ((data[b] && data[b].added) || 0));
    for (const k of keys.slice(0, keys.length - INDEX_MAX_ENTRIES)) delete data[k];
  }
  saveIndex(data);
}

function sourceFor(keyRaw) {
  const key = sanitizeKey(keyRaw);
  if (!key) return null;
  const e = loadIndex()[key];
  const url = e && validateUrl(e.url);
  return url || null;
}

/* Reverse lookup: pasting a URL that is already stored must not re-download. */
function keyForUrl(url) {
  const data = loadIndex();
  let best = null;
  for (const [key, e] of Object.entries(data)) {
    if (!e || e.url !== url) continue;
    if (!onDisk(key)) continue;
    best = key;
  }
  return best;
}

/* ------------------------------ cache cap --------------------------------- */
/* Re-downloadable icons (URL-sourced) are evicted before anything the user
   picked from disk — losing one of those costs the user a file they may no
   longer have. Oldest mtime first inside each class; .tmp litter goes always. */
function prune() {
  if (!cacheDir) return;
  let total = 0;
  const volatile = [], owned = [];
  for (const name of fs.readdirSync(cacheDir)) {
    const p = path.join(cacheDir, name);
    if (name.endsWith('.tmp')) { try { fs.unlinkSync(p); } catch { /* in flight */ } continue; }
    if (name === '_sources.json') continue;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) continue;
      total += st.size;
      (sourceFor(PREFIX + name) ? volatile : owned).push({ p, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished between readdir and stat */ }
  }
  if (total <= DIR_TOTAL_MAX) return;
  const evict = (list) => {
    list.sort((a, b) => a.mtime - b.mtime);
    for (const f of list) {
      if (total <= DIR_TOTAL_MAX) break;
      try { fs.unlinkSync(f.p); total -= f.size; } catch { /* in flight */ }
    }
  };
  evict(volatile);
  evict(owned);
}

/* ------------------------------ ingestion --------------------------------- */
/* Sniff, size-check, store, and hand back the key plus a ready data URL. */
function install(buf, { url = null } = {}) {
  if (!Buffer.isBuffer(buf) || !buf.length) return { ok: false, error: 'No image data' };
  if (buf.length > FILE_MAX_BYTES) {
    return { ok: false, error: `Icon must be under ${Math.round(FILE_MAX_BYTES / 1048576)} MB — that image is ${(buf.length / 1048576).toFixed(1)} MB` };
  }
  const kind = sniffImage(buf);
  if (!kind) return { ok: false, error: 'Unsupported image — use a PNG, JPG, GIF, WebP, BMP, ICO or SVG file' };
  const key = keyFor(buf, kind);
  if (!writeStore(key, buf)) return { ok: false, error: 'Could not write to the icon folder — check disk space and permissions' };
  if (url) rememberSource(key, url);
  return { ok: true, key, kind, bytes: buf.length, dataUrl: dataUrl(kind, buf) };
}

/* `src` is a path this module was told to read by main's own open dialog — the
   renderer never supplies paths (see ipc.js: the dialog and the read are one
   privileged round trip, so there is no arbitrary-file-read primitive here). */
function addFile(src) {
  if (typeof src !== 'string' || !src.trim()) return { ok: false, error: 'No file chosen' };
  let st;
  try { st = fs.statSync(src); } catch { return { ok: false, error: 'Could not read that file — it may have moved' }; }
  if (!st.isFile()) return { ok: false, error: 'That is not a file' };
  if (st.size === 0) return { ok: false, error: 'That file is empty' };
  if (st.size > FILE_MAX_BYTES) {
    return { ok: false, error: `Icon must be under ${Math.round(FILE_MAX_BYTES / 1048576)} MB — that file is ${(st.size / 1048576).toFixed(1)} MB` };
  }
  let buf;
  try { buf = fs.readFileSync(src); } catch (err) {
    return { ok: false, error: 'Could not read that file — ' + String((err && err.message) || err) };
  }
  return install(buf);
}

async function fetchImage(url) {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      redirect: 'follow',
      headers: { 'user-agent': 'nucleus-launcher (custom icon fetch)' }
    });
    if (!res.ok) return { error: `The server answered ${res.status}` };
    const len = Number(res.headers.get('content-length'));
    if (len > FILE_MAX_BYTES) return { error: 'That image is larger than ' + Math.round(FILE_MAX_BYTES / 1048576) + ' MB' };
    // Cap enforced while streaming: the header check is only a cheap up-front
    // reject, and a lying server must not be able to buffer an oversized body
    // into main before we notice (readCapped cancels the stream at the cap).
    const got = await readCapped(res, FILE_MAX_BYTES);
    if (got.overflow) return { error: 'That image is larger than ' + Math.round(FILE_MAX_BYTES / 1048576) + ' MB' };
    if (got.failed) return { error: 'Could not download that URL — the transfer failed' };
    const buf = got.buf;
    if (!buf.length) return { error: 'That URL returned no data' };
    // The bytes decide, not the server's content-type: plenty of static hosts
    // serve pngs as octet-stream, and a lying header must not matter.
    if (!sniffImage(buf)) return { error: 'That URL is not a supported image (PNG, JPG, GIF, WebP, BMP, ICO or SVG)' };
    return { buf };
  } catch (err) {
    return { error: 'Could not download that URL — ' + String((err && err.message) || err) };
  }
}

async function addUrl(raw) {
  const url = validateUrl(raw);
  if (!url) return { ok: false, error: 'Enter a full image URL starting with http:// or https://' };
  const known = keyForUrl(url);
  if (known) {
    const hit = readCache(known);
    if (hit) return { ok: true, key: known, kind: hit.kind, reused: true, dataUrl: hit.dataUrl };
  }
  const got = await fetchImage(url);
  if (got.error) return { ok: false, error: got.error };
  return install(got.buf, { url });
}

/* Cache-first read for the wheel overlay, the Settings rows, and the live
   preview; a missing URL-sourced icon re-fetches itself, a missing disk-picked
   one reports a miss so the caller falls back to the glyph. */
const inflight = new Map();                        // dedupe overlay + settings resolving the same key

function dataUrlFor(keyRaw) {
  const key = sanitizeKey(keyRaw);
  if (!key) return Promise.resolve({ ok: false, error: 'Not a custom icon' });
  const hit = readCache(key);
  if (hit) return Promise.resolve({ ok: true, key, kind: hit.kind, dataUrl: hit.dataUrl });
  if (inflight.has(key)) return inflight.get(key);
  const url = sourceFor(key);
  if (!url) return Promise.resolve({ ok: false, error: 'Icon file is missing — pick the image again' });
  const job = addUrl(url).then((r) => {
    return r.ok ? { ok: true, key: r.key, kind: r.kind, dataUrl: r.dataUrl } : r;
  }).finally(() => { inflight.delete(key); });
  inflight.set(key, job);
  return job;
}

/* Fire-and-forget priming so the wheel never waits on a download to show art.
   Only URL-sourced keys can be primed — a disk-picked file that vanished is
   gone until the user picks it again. */
function warm(keys) {
  for (const k of keys || []) {
    const key = sanitizeKey(k);
    if (!key || onDisk(key) || inflight.has(key)) continue;
    if (!sourceFor(key)) continue;
    dataUrlFor(key).catch(() => { /* the overlay falls back to the glyph */ });
  }
}

module.exports = {
  configure, addFile, addUrl, dataUrlFor, warm, install,
  // read-side helpers for the export-package builder (bundle.js)
  readBytes, sourceFor,
  // pure, exported for tests
  sanitizeKey, isCustomKey, keyFor, sniffImage, validateUrl, looksLikeSvg, KINDS,
  PREFIX, FILE_MAX_BYTES, DIR_TOTAL_MAX, PICK_EXTENSIONS, FETCH_TIMEOUT
};
