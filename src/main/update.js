'use strict';
/* Update check against GitHub Releases — check, ASK, then (on yes) download
   the published installer. Nothing is ever installed without an explicit yes.

   The app asks the Releases API for the latest published release, decides
   whether it is newer than the running copy, and hands the RESULT to the
   surfaces that show it (tray balloon/menu, Settings footer). main.js turns an
   'available' into a yes/no prompt; a yes comes back HERE to stream the asset
   GitHub publishes to the Downloads folder, verify its checksum and run it
   detached. The download URL is never taken from the page and the renderer can
   never steer openExternal or the spawn — the release URL is rebuilt from the
   tag and every asset URL passes ASSET_URL_RE, fixed-repo doctrine (see
   donate.js for the same rule). The public home for downloads is the RELEASES
   page: the GitHub Pages site is not published, so nothing points at it.

   Version rule (product decision): a higher x.y.z always counts as an update.
   When the published release carries the SAME x.y.z (the release ritual ships
   b-number builds at one version), a strictly newer published-at timestamp
   still counts — classified 'build' so the UI can say "new build" instead of
   "new version". An unparseable tag with a newer date is also a 'build'.

   Fail-soft everywhere: no network, a private repo, a lying host or a dead
   API must look exactly like "no update info", never a broken app. The last
   good answer is cached under userData so a restart shows it instantly
   (sanitized again on read-back — the cache file is data, not authority).

   The pure half (parse/compare/sanitize/pick) has no Electron or network deps;
   downloadUpdate() takes an injected fetch and writes with plain fs, so
   tests/unit/update.test.js covers the whole thing without the net. */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { shell } = require('electron');
const { readCapped } = require('./capped-fetch');
const log = require('./logger');

/* The renamed repo is the authority — the old `mockcomic/radial-wheel` URL
   only still answers because GitHub redirects renamed repos, and a redirect
   is one more thing that can break an update check. */
const REPO = 'mockcomic/Nucleus';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
const API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const FETCH_TIMEOUT = 12000;
const DOWNLOAD_TIMEOUT = 10 * 60000;    // a ~100 MB asset over a slow link
const JSON_MAX_BYTES = 256 * 1024;      // one release JSON never needs to be bigger
const DOWNLOAD_MAX_BYTES = 512 * 1024 * 1024;   // enforced DURING the transfer
const TAG_RE = /^[\w.\-+]{1,100}$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
/* GitHub serves release assets from these two hosts; anything else in the
   JSON (a fork of the API response, a hostile proxy) is dropped. */
const ASSET_HOSTS = ['objects.githubusercontent.com', 'github.com', 'codeload.github.com'];
const ASSET_URL_RE = /^https:\/\/(?:objects\.githubusercontent\.com|github\.com\/[^/]+\/[^/]+\/releases\/download\/[^?#]*|codeload\.githubusercontent\.com)\/[^\s]+$/;

/* ------------------------------ pure helpers ------------------------------ */

/** 'v1.2.3' / '1.2.3' / '1.2.3-beta.1' → {maj,min,pat} | null. Strict-enough:
    a leading v and an optional -suffix are tolerated, nothing else. */
function parseVersion(str) {
  const m = /^v?(\d{1,4})\.(\d{1,4})\.(\d{1,4})(?:[-+][\w.\-+]*)?$/.exec(String(str == null ? '' : str).trim());
  if (!m) return null;
  return { maj: +m[1], min: +m[2], pat: +m[3] };
}

/** -1 / 0 / 1 like a comparator. Nulls sort lowest (an unparseable version is
    never "newer" than a parseable one). */
function compareVersions(a, b) {
  const x = a || { maj: -1, min: -1, pat: -1 };
  const y = b || { maj: -1, min: -1, pat: -1 };
  for (const k of ['maj', 'min', 'pat']) {
    if (x[k] !== y[k]) return x[k] > y[k] ? 1 : -1;
  }
  return 0;
}

/** The whole verdict, as pure data:
    { upToDate } | { available, kind: 'version'|'build', ... } | { none } | { failed }.
    latest = sanitizeRelease() output (null when the last answer had nothing
    usable); localVersion = running app.getVersion() string; appPublishMs =
    mtime of the app directory (the caller's proxy for "when was THIS build
    made"); nowMs = clock, injected so tests do not race the wall. */
function decide(latest, localVersion, appPublishMs, nowMs) {
  const local = parseVersion(localVersion);
  if (!latest) return { status: 'none' };
  const cmp = compareVersions(latest.version, local);
  if (cmp > 0) return { status: 'available', kind: 'version', info: latest };
  if (cmp < 0) return { status: 'upToDate', info: latest };
  // Equal (or both unparseable): the publish-date fallback. A published
  // release NEWER than this running build counts; anything older or equal
  // does not. No clock at all → no claim either way.
  const publishedMs = Date.parse(latest.publishedAt || '');
  if (!Number.isFinite(publishedMs)) return { status: 'upToDate', info: latest };
  if (!Number.isFinite(appPublishMs)) return { status: 'upToDate', info: latest };
  if (publishedMs > appPublishMs) {
    // Same x.y.z (or versionless) but newer bytes: a build update.
    return { status: 'available', kind: 'build', info: latest };
  }
  void nowMs;
  return { status: 'upToDate', info: latest };
}

/** Rebuild (never trust) the release page URL from owner/repo/tag. */
function releaseUrl(tag) {
  return `https://github.com/${REPO}/releases/tag/${encodeURIComponent(tag)}`;
}

/** GitHub API release JSON → the only fields the app may use, or null.
    Unknown fields are dropped, not passed through. */
function sanitizeRelease(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const tag = typeof raw.tag_name === 'string' ? raw.tag_name.trim() : '';
  if (!TAG_RE.test(tag)) return null;
  const publishedAt = typeof raw.published_at === 'string' && Number.isFinite(Date.parse(raw.published_at))
    ? raw.published_at : null;
  if (!publishedAt) return null;                       // the date rule needs the date
  const draft = raw.draft === true;
  const prerelease = raw.prerelease === true;
  const assets = [];
  if (Array.isArray(raw.assets)) {
    for (const a of raw.assets) {
      const name = a && typeof a.name === 'string' ? a.name.trim() : '';
      const url = a && typeof a.browser_download_url === 'string' ? a.browser_download_url.trim() : '';
      if (!TAG_RE.test(name)) continue;
      if (!ASSET_URL_RE.test(url)) continue;
      try {
        const host = new URL(url).host;
        if (!ASSET_HOSTS.includes(host)) continue;
      } catch { continue; }
      /* GitHub publishes `digest: "sha256:<hex>"` per asset — the ONLY thing a
         downloaded file is checked against. Absent (older release, proxy that
         strips it) stays null and the download reports unverified. */
      const d = typeof a.digest === 'string' ? a.digest.trim().toLowerCase() : '';
      const sha256 = /^sha256:[a-f0-9]{64}$/.test(d) ? d.slice(7)
        : (SHA256_RE.test(d) ? d : null);
      assets.push({ name, url, size: Number.isFinite(+a.size) ? +a.size : null, sha256 });
      if (assets.length >= 16) break;                  // generous ceiling, bounded parsing
    }
  }
  return {
    tag,
    version: parseVersion(tag),
    versionLabel: tag.replace(/^v/i, ''),
    url: releaseUrl(tag),
    name: typeof raw.name === 'string' ? raw.name.slice(0, 120) : tag,
    publishedAt,
    draft,
    prerelease,
    assets
  };
}

/* ------------------------------ asset picker ------------------------------ */

/** Which published file to hand this particular install, from the SANITIZED
    asset list only. An NSIS install takes the setup exe; a portable build
    (PORTABLE_EXECUTABLE_DIR is set by electron-builder's bootstrapper) takes
    the portable exe. Preference, never a requirement: with no exact match any
    .exe will do, and with no .exe at all the first asset — the release page
    stays the fallback either way. */
function chooseAsset(release, wantPortable) {
  const list = (release && Array.isArray(release.assets)) ? release.assets : [];
  const want = wantPortable ? /-portable\.exe$/i : /-setup\.exe$/i;
  return list.find((a) => want.test(a.name))
    || list.find((a) => /\.exe$/i.test(a.name))
    || list[0]
    || null;
}

/* ------------------------------- fetch + state ---------------------------- */

let infoCachePath = null;          // set by configure() from the main process
let latest = null;                 // last sanitized release (null = none)
let lastCheckMs = 0;               // epoch of the last completed check
let lastError = null;              // message of the last failed check
let status = 'idle';               // idle | checking | ready | error
let checking = null;               // in-flight promise, so concurrent checks share one request
let download = null;               // last/ongoing installer download (see downloadUpdate)

function configure(dir) {
  infoCachePath = dir ? path.join(dir, 'update-info.json') : null;
  loadCache();
}

/* Read the cache back through the SAME sanitizer — a hand-edited or stale
   file can at worst yield null, never smuggle a field the API contract lacks. */
function loadCache() {
  if (!infoCachePath) return;
  try {
    const raw = JSON.parse(fs.readFileSync(infoCachePath, 'utf8'));
    if (raw && typeof raw === 'object') {
      latest = sanitizeRelease(raw.release || null);
      if (raw.lastCheckMs === +raw.lastCheckMs && raw.lastCheckMs > 0) lastCheckMs = raw.lastCheckMs;
      if (latest) status = 'ready';
    }
  } catch { /* absent/garbage = first check tells the whole story */ }
}

function saveCache() {
  if (!infoCachePath || !latest) return;
  try {
    fs.mkdirSync(path.dirname(infoCachePath), { recursive: true });
    const tmp = infoCachePath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ lastCheckMs, release: latest }, null, 1), 'utf8');
    fs.renameSync(tmp, infoCachePath);   // same atomic discipline as the config store
  } catch { /* cache is a convenience, never a requirement */ }
}

/** One request to the Releases API. fetchImpl/clock injectable for tests. */
async function check(opts = {}) {
  const doFetch = opts.fetch || fetch;
  const appVersion = typeof opts.appVersion === 'string' ? opts.appVersion : '';
  const appPublishMs = Number.isFinite(+opts.appPublishMs) ? +opts.appPublishMs : NaN;
  const nowMs = typeof opts.now === 'function' ? opts.now() : Date.now();
  if (checking) return checking;                        // share one in-flight check
  status = 'checking';
  checking = (async () => {
    try {
      const res = await doFetch(API_URL, {
        headers: {
          Accept: 'application/vnd.github+json',
          // GitHub's API rejects UA-less requests; version-tagged so a flood
          // of checks is attributable in server logs.
          'User-Agent': 'Nucleus/' + (appVersion || 'dev') + ' (update-check)'
        },
        signal: AbortSignal.timeout ? AbortSignal.timeout(FETCH_TIMEOUT) : undefined,
        cache: 'no-store'
      });
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      const got = await readCapped(res, JSON_MAX_BYTES);
      if (got.overflow) throw new Error('release metadata over byte cap');
      if (got.failed || !got.buf) throw new Error('unreadable response');
      const rel = sanitizeRelease(JSON.parse(got.buf.toString('utf8')));
      lastCheckMs = nowMs;
      lastError = null;
      /* Download state belongs to the release it was fetched for: once GitHub
         reports a different tag (or none), an old progress percentage or a
         stale checksum failure says nothing about what is on offer now. */
      if (download && (!rel || download.tag !== rel.tag)) download = null;
      if (!rel) {
        latest = null;
        status = 'ready';
        log.info('update check: no usable release on ' + REPO);
        return { ok: true, status: 'none' };
      }
      if (rel.draft || rel.prerelease) {
        // /releases/latest already excludes these; belt-and-braces so a proxy
        // returning the wrong record cannot offer a pre-release as an update.
        latest = null;
        status = 'ready';
        return { ok: true, status: 'none' };
      }
      latest = rel;
      status = 'ready';
      saveCache();
      const v = decide(rel, appVersion, appPublishMs, nowMs);
      if (v.status === 'available') log.info(`update check: ${v.kind} update available (${rel.tag})`);
      else if (v.status === 'upToDate') log.info(`update check: up to date (latest ${rel.tag})`);
      return { ok: true, ...v };
    } catch (err) {
      lastError = String((err && err.message) || err);
      status = 'error';
      log.warn('update check failed: ' + lastError);
      return { ok: false, status: 'error', error: lastError };
    } finally {
      checking = null;
    }
  })();
  return checking;
}

/** Snapshot for the tray menu and the Settings chip. Purely local data.
    A failed check with no release ever seen shows 'error'; a failed check
    AFTER a good one keeps showing the last-known answer (prefer stale truth
    over a transient network blip — the next successful check replaces it).
    `download` rides along so every surface can show the same progress (or the
    same failure) without asking main about it. */
function snapshot(appVersion, appPublishMs) {
  const dec = latest ? decide(latest, appVersion, appPublishMs, Date.now()) : null;
  let st;
  if (status === 'checking') st = 'checking';
  else if (dec) st = dec.status;
  else st = status === 'error' ? 'error' : 'none';
  return {
    ok: true,
    status: st,
    kind: (dec && dec.kind) || null,
    info: latest ? { tag: latest.tag, version: latest.versionLabel, url: latest.url, name: latest.name, publishedAt: latest.publishedAt, assets: latest.assets } : null,
    download: download ? { ...download } : null,
    lastCheckMs,
    error: st === 'error' ? lastError : null
  };
}

/** Open a release page. `url` is honored ONLY when it matches what main
    sanitized — the renderer can never steer openExternal to an arbitrary
    site (fixed-target doctrine); anything else opens the fixed releases page. */
async function openRelease(url) {
  const target = (latest && typeof url === 'string' && url === latest.url) ? url : RELEASES_PAGE;
  try {
    const err = await shell.openExternal(target);
    return err ? { ok: false, error: String(err) } : { ok: true, url: target };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

/* ------------------------- download + hand-off ---------------------------- */

function setDownload(patch) {
  download = Object.assign({}, download || {}, patch);
  return download;
}

/** Stream one sanitized asset to `destDir`, verify it against the published
    sha256, and leave the finished file on disk (nothing is executed here).
    Bytes are capped DURING the transfer (same discipline as readCapped) and a
    failure always cleans up its .part. Injectable fetch + real fs into a caller
    chosen folder, so this is unit-testable with a fake response. */
async function downloadUpdate(opts = {}) {
  const asset = opts.asset;
  if (!asset || typeof asset.url !== 'string' || !ASSET_URL_RE.test(asset.url)
      || typeof asset.name !== 'string' || !TAG_RE.test(asset.name)) {
    return { ok: false, error: 'no downloadable file in that release' };
  }
  const destDir = typeof opts.destDir === 'string' ? opts.destDir : '';
  if (!destDir) return { ok: false, error: 'no Downloads folder to write to' };
  const doFetch = opts.fetch || fetch;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const maxBytes = Number.isFinite(+opts.maxBytes) && +opts.maxBytes > 0 ? +opts.maxBytes : DOWNLOAD_MAX_BYTES;
  const base = path.basename(asset.name);                    // TAG_RE-checked: no path, no dots-dot
  const finalPath = path.join(destDir, base);
  const partPath = finalPath + '.part';
  const total = Number.isFinite(+asset.size) && +asset.size > 0 ? +asset.size : null;

  setDownload({ tag: opts.tag || null, name: base, pct: 0, bytes: 0, total, path: finalPath, error: null, done: false });
  let out = null;
  let bytes = 0;
  let lastPct = -1;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const res = await doFetch(asset.url, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Nucleus/update-download' },
      signal: AbortSignal.timeout ? AbortSignal.timeout(DOWNLOAD_TIMEOUT) : undefined,
      cache: 'no-store'
    });
    if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
    if (!res.body) throw new Error('empty response');
    const hash = crypto.createHash('sha256');
    out = fs.createWriteStream(partPath);
    for await (const part of res.body) {
      const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part);
      bytes += chunk.length;
      if (bytes > maxBytes) throw new Error('download over byte cap');
      hash.update(chunk);
      if (out.write(chunk) === false) {                        // honor backpressure
        await new Promise((r) => out.once('drain', r));
      }
      const pct = total ? Math.min(100, Math.floor(bytes / total * 100)) : null;
      if (pct !== lastPct) {
        lastPct = pct;
        setDownload({ pct, bytes });
        if (onProgress) { try { onProgress({ pct, bytes, total }); } catch { /* cosmetic */ } }
      }
    }
    await new Promise((r) => out.end(r));
    out = null;
    const digest = hash.digest('hex');
    if (asset.sha256 && digest !== asset.sha256) throw new Error('checksum mismatch');
    try { fs.rmSync(finalPath, { force: true }); } catch { /* a re-download replaces it */ }
    fs.renameSync(partPath, finalPath);                        // same folder, so atomic
    setDownload({ pct: 100, bytes, error: null, done: true, verified: !!asset.sha256 });
    log.info('update download: ' + finalPath + (asset.sha256 ? ' (sha256 verified)' : ' (no published checksum)'));
    return { ok: true, path: finalPath, size: bytes, sha256: digest, verified: !!asset.sha256 };
  } catch (err) {
    const msg = String((err && err.message) || err);
    if (out) { try { out.destroy(); } catch { /* already gone */ } }
    try { fs.rmSync(partPath, { force: true }); } catch { /* nothing to clean */ }
    setDownload({ error: msg, done: true, pct: null });
    log.warn('update download failed: ' + msg);
    return { ok: false, error: msg };
  }
}

/** Launch a downloaded installer/portable exe DETACHED and return immediately:
    the caller quits Nucleus so the update can replace the running files. The
    path is one this module just wrote (never a renderer string), and no shell
    is involved, so a filename with spaces cannot be re-parsed into arguments.
    `opts.spawn` is injectable so the unit test never starts a real process. */
function runUpdate(filePath, opts = {}) {
  if (typeof filePath !== 'string' || !/\.exe$/i.test(filePath)) return { ok: false, error: 'not an update file' };
  const spawnImpl = opts.spawn || spawn;
  try {
    const child = spawnImpl(filePath, [], { detached: true, stdio: 'ignore' });
    if (child && typeof child.unref === 'function') child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
}

module.exports = {
  REPO, RELEASES_PAGE, API_URL,
  parseVersion, compareVersions, decide, releaseUrl, sanitizeRelease, chooseAsset,
  configure, check, snapshot, openRelease, downloadUpdate, runUpdate,
  /* Test-only state wipe (the module is a singleton like the other main-side
     services; unit tests need each scenario to start from a blank slate). */
  _reset() { latest = null; lastCheckMs = 0; lastError = null; status = 'idle'; checking = null; infoCachePath = null; download = null; },
  _internals: () => ({ latest, lastCheckMs, status, download })
};
