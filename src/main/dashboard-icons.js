'use strict';
/* Dashboard Icons (https://dashboardicons.com — github.com/homarr-labs/dashboard-icons)
   search + download cache for wheel item logos.

   The config stores only the icon *slug* (item.iconImage); the bytes live in
   userData/icons/dashboard so exported configs stay small and survive a move
   to another machine — missing files are re-downloaded on demand.

   Metadata source of truth is the repo's metadata.json, keyed by slug:
     { base: 'svg'|'png', aliases: [], categories: [], colors: {dark, light} }
   Icons are served from the jsDelivr CDN mirror, exactly like the site does:
     https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/<kind>/<slug>.<kind>

   No Electron deps: configure() injects the cache dir, and the pure matchers
   are unit-testable under plain node (tests/unit/dashboard-icons.test.js). */
const fs = require('fs');
const path = require('path');
const { readCapped } = require('./capped-fetch');

const REPO = 'homarr-labs/dashboard-icons';
const METADATA_URL = 'https://raw.githubusercontent.com/' + REPO + '/main/metadata.json';
const METADATA_TTL = 24 * 3600e3;         // re-check the catalog once a day
const METADATA_MAX_BYTES = 8 * 1024 * 1024;
const ICON_MAX_BYTES = 512 * 1024;         // a logo never needs to be bigger
const FETCH_TIMEOUT = 12000;
const SEARCH_LIMIT = 24;
const MIME = { svg: 'image/svg+xml', png: 'image/png' };
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/;

let cacheDir = null;                       // set by configure() from the main process

function configure(dir) {
  cacheDir = dir;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* best-effort; fetch will report */ }
}

/* ------------------------------ pure helpers ------------------------------ */
function sanitizeSlug(raw) {
  if (typeof raw !== 'string') return null;        // only real strings become slugs
  const s = raw.trim().toLowerCase();
  if (!SLUG_RE.test(s) || s.includes('..')) return null;
  return s;
}

/* "OBS Studio" -> "obs-studio" — the direct-guess form users can also type. */
function slugify(text) {
  return String(text == null ? '' : text)
    .normalize('NFKD').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 100);
}

/* Comparison form: accents folded, anything non-alphanumeric becomes a space. */
function normalize(s) {
  return String(s == null ? '' : s)
    .normalize('NFKD').toLowerCase()
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

function iconUrl(slug, kind) {
  return `https://cdn.jsdelivr.net/gh/${REPO}/${kind}/${slug}.${kind}`;
}

function entryKind(entry) { return entry && entry.base === 'png' ? 'png' : 'svg'; }

/* Token ranking over metadata. Every token must hit something (slug, alias,
   or category) for the candidate to surface; strength orders the results.
   Dark/light/wordmark variants hide behind their parent icon. */
function searchMetadata(metadata, query, limit = SEARCH_LIMIT) {
  const tokens = normalize(query).split(' ').filter(Boolean);
  if (!metadata || typeof metadata !== 'object' || !tokens.length) return [];

  const variantOf = new Map();
  for (const [slug, e] of Object.entries(metadata)) {
    for (const group of ['colors', 'wordmark']) {
      for (const v of Object.values((e && e[group]) || {})) {
        if (typeof v === 'string' && v && v !== slug) variantOf.set(v, slug);
      }
    }
  }

  const scored = [];
  for (const [slug, e] of Object.entries(metadata)) {
    const nslug = normalize(slug);
    const aliases = Array.isArray(e && e.aliases) ? e.aliases.map(normalize) : [];
    const cats = Array.isArray(e && e.categories) ? e.categories.map(normalize) : [];
    let score = 0;
    for (const t of tokens) {
      let best = 0;
      if (nslug === t) best = 32;
      else if (nslug.startsWith(t)) best = 24;
      else if (nslug.includes(t)) best = 14;
      if (best < 28) {
        for (const a of aliases) {
          const v = a === t ? 28 : a.startsWith(t) ? 20 : a.includes(t) ? 12 : 0;
          if (v > best) best = v;
        }
      }
      if (!best) {
        for (const c of cats) {
          const v = c === t ? 10 : c.includes(t) ? 6 : 0;
          if (v > best) best = v;
        }
      }
      if (!best) { score = 0; break; }           // all tokens must match
      score += best;
    }
    if (score > 0) scored.push({ slug, score, kind: entryKind(e), categories: (e && e.categories) || [] });
  }
  scored.sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));

  const out = [];
  const taken = new Set();
  for (const r of scored) {
    const parent = variantOf.get(r.slug);
    if (parent && taken.has(parent)) continue;   // hide dagster-dark when dagster is shown
    taken.add(r.slug);
    out.push({ slug: r.slug, kind: r.kind, categories: r.categories, url: iconUrl(r.slug, r.kind) });
    if (out.length >= limit) break;
  }
  return out;
}

/* ------------------------------ disk cache -------------------------------- */
function metaPath() { return cacheDir && path.join(cacheDir, '_metadata.json'); }
function iconPath(slug, kind) { return cacheDir && path.join(cacheDir, `${slug}.${kind}`); }

function cachedDataUrl(slug) {
  if (!cacheDir) return null;
  for (const kind of ['svg', 'png']) {
    try {
      const p = iconPath(slug, kind);
      const st = fs.statSync(p);
      if (st.size > 0 && st.size <= ICON_MAX_BYTES) {
        return { kind, dataUrl: dataUrl(kind, fs.readFileSync(p)) };
      }
    } catch { /* miss */ }
  }
  return null;
}

/* Existence-only probe: warm() must not pay the read+base64 cost of
   cachedDataUrl just to decide whether to fetch (that ran for EVERY cached
   icon, up to ICON_MAX_BYTES each, on every single config change). */
function iconOnDisk(slug) {
  if (!cacheDir) return false;
  for (const kind of ['svg', 'png']) {
    try {
      const st = fs.statSync(iconPath(slug, kind));
      if (st.size > 0 && st.size <= ICON_MAX_BYTES) return true;
    } catch { /* miss */ }
  }
  return false;
}

function writeCache(slug, kind, buf) {
  if (!cacheDir) return;
  try {
    fs.mkdirSync(cacheDir, { recursive: true });
    const p = iconPath(slug, kind);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, buf);
    fs.renameSync(tmp, p);
    pruneCache();
  } catch { /* cache is an optimization; the dataUrl still works without it */ }
}

/* LRU-ish cap on the whole icon dir (per-file caps alone let it grow with
   every distinct slug ever fetched). Oldest-mtime files go first. */
const CACHE_TOTAL_MAX = 48 * 1024 * 1024;
function pruneCache() {
  if (!cacheDir) return;
  let total = 0;
  const files = [];
  for (const name of fs.readdirSync(cacheDir)) {
    if (name.endsWith('.tmp')) { try { fs.unlinkSync(path.join(cacheDir, name)); } catch {} continue; }
    try {
      const st = fs.statSync(path.join(cacheDir, name));
      if (!st.isFile()) continue;
      total += st.size;
      files.push({ name, size: st.size, mtime: st.mtimeMs });
    } catch { /* vanished */ }
  }
  files.sort((a, b) => a.mtime - b.mtime);
  for (const f of files) {
    if (total <= CACHE_TOTAL_MAX) break;
    try { fs.unlinkSync(path.join(cacheDir, f.name)); total -= f.size; } catch { /* in flight */ }
  }
}

function dataUrl(kind, buf) {
  return `data:${MIME[kind]};base64,${buf.toString('base64')}`;
}

/* ------------------------------ network ----------------------------------- */
async function fetchBuffer(url, maxBytes) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
    redirect: 'follow',
    headers: { 'user-agent': 'nucleus-launcher (dashboard icon fetch)' }
  });
  if (!res.ok) return null;
  const len = Number(res.headers.get('content-length'));
  if (len > maxBytes) return null;
  // Cap enforced while streaming, not after buffering (see capped-fetch.js).
  const got = await readCapped(res, maxBytes);
  if (!got.buf || !got.buf.length) return null;
  return got.buf;
}

let metaMem = null;                        // { at, data }

function readDiskMeta() {
  const p = metaPath();
  if (!p) return null;
  try {
    // The network path caps the metadata payload; the disk path must too, or
    // one corrupted/huge local file gets JSON.parsed on every load.
    const st = fs.statSync(p);
    if (st.size > METADATA_MAX_BYTES) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

async function loadMetadata() {
  if (metaMem && Date.now() - metaMem.at < METADATA_TTL) return metaMem.data;
  if (cacheDir && metaMem == null) {
    try {
      const st = fs.statSync(metaPath());
      if (Date.now() - st.mtimeMs < METADATA_TTL) {
        const data = readDiskMeta();
        if (data) { metaMem = { at: st.mtimeMs, data }; return data; }
      }
    } catch { /* no cache yet */ }
  }
  try {
    const buf = await fetchBuffer(METADATA_URL, METADATA_MAX_BYTES);
    if (buf) {
      const data = JSON.parse(buf.toString('utf8'));
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        metaMem = { at: Date.now(), data };
        if (cacheDir) {
          try {
            fs.mkdirSync(cacheDir, { recursive: true });
            const p = metaPath(), tmp = p + '.tmp';
            fs.writeFileSync(tmp, buf);
            fs.renameSync(tmp, p);
          } catch { /* best-effort */ }
        }
        return data;
      }
    }
  } catch { /* offline — fall through to stale copies */ }
  if (metaMem) return metaMem.data;       // stale is better than nothing
  const disk = readDiskMeta();
  if (disk) { metaMem = { at: 0, data: disk }; return disk; }
  return null;
}

/* Slug-per-slug request dedupe: wheel warm + settings fetch can overlap. */
const inflight = new Map();

async function fetchIcon(slugRaw) {
  const slug = sanitizeSlug(slugRaw);
  if (!slug) return { ok: false, error: 'Invalid icon name' };
  const hit = cachedDataUrl(slug);
  if (hit) return { ok: true, slug, kind: hit.kind, dataUrl: hit.dataUrl };
  if (inflight.has(slug)) return inflight.get(slug);
  const job = (async () => {
    // metadata knows the true base (some icons are png-only); default to svg-first.
    const kinds = [];
    const meta = metaMem && metaMem.data;
    const entry = meta && typeof meta === 'object' ? meta[slug] : null;
    if (entry) kinds.push(entryKind(entry));
    for (const k of ['svg', 'png']) if (!kinds.includes(k)) kinds.push(k);
    for (const kind of kinds) {
      try {
        const res = await fetch(iconUrl(slug, kind), {
          signal: AbortSignal.timeout(FETCH_TIMEOUT),
          redirect: 'follow',
          headers: { 'user-agent': 'nucleus-launcher (dashboard icon fetch)' }
        });
        if (!res.ok) continue;
        // jsDelivr answers unknown files with a text/plain 404 body — reject
        // anything that is not actually an image of the expected type.
        const ctype = String(res.headers.get('content-type') || '').toLowerCase();
        if (!ctype.startsWith(MIME[kind])) continue;
        const len = Number(res.headers.get('content-length'));
        if (len > ICON_MAX_BYTES) continue;
        const got = await readCapped(res, ICON_MAX_BYTES);
        const buf = got.buf;
        if (!buf || !buf.length) continue;   // overflow, mid-stream failure, or empty
        writeCache(slug, kind, buf);
        return { ok: true, slug, kind, dataUrl: dataUrl(kind, buf) };
      } catch { /* try the next format / report below */ }
    }
    return { ok: false, error: `Could not download “${slug}” — offline or not in dashboardicons.com` };
  })();
  inflight.set(slug, job);
  try { return await job; } finally { inflight.delete(slug); }
}

/* Cache-first read for the wheel overlay; downloads on miss so configs moved
   to a fresh machine repopulate their icon files automatically. */
function dataUrlFor(slugRaw) {
  const slug = sanitizeSlug(slugRaw);
  if (!slug) return Promise.resolve({ ok: false, error: 'Invalid icon name' });
  const hit = cachedDataUrl(slug);
  if (hit) return Promise.resolve({ ok: true, slug, kind: hit.kind, dataUrl: hit.dataUrl });
  return fetchIcon(slug);
}

async function searchIcons(query) {
  const q = String(query == null ? '' : query).trim();
  if (!q) return { ok: true, results: [], offline: false };
  const meta = await loadMetadata();
  let results = meta ? searchMetadata(meta, q) : [];
  if (!results.length) {
    // Direct-slug guess (works offline from cache, and for exact names when
    // the metadata catalog is unavailable); a successful probe caches the file.
    const guess = sanitizeSlug(slugify(q));
    if (guess) {
      const got = await dataUrlFor(guess);
      if (got.ok) results = [{ slug: guess, kind: got.kind, categories: [], url: iconUrl(guess, got.kind), guess: true }];
    }
  }
  return { ok: true, results, offline: !meta };
}

/* Fire-and-forget priming so icons are on disk before the wheel pops. */
function warm(slugs) {
  for (const s of slugs || []) {
    const slug = sanitizeSlug(s);
    if (slug && !iconOnDisk(slug)) dataUrlFor(slug).catch(() => { /* the overlay falls back to the glyph */ });
  }
}

module.exports = {
  configure, searchIcons, fetchIcon, dataUrlFor, warm, loadMetadata,
  // pure, exported for tests
  sanitizeSlug, slugify, normalize, searchMetadata, iconUrl, entryKind,
  METADATA_TTL, ICON_MAX_BYTES, SEARCH_LIMIT, MIME
};
