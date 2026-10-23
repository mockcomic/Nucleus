'use strict';
/* Update check against GitHub Releases — check + notify, never self-install.

   The app asks the Releases API for the latest published release, decides
   whether it is newer than the running copy, and hands the RESULT to the
   surfaces that show it (tray balloon/menu, Settings footer). Opening the
   update means opening the release page in the browser: the download URL is
   never fetched by the app and the renderer can never steer openExternal —
   the release URL is rebuilt here from the tag, fixed-repo doctrine (see
   donate.js for the same rule).

   Version rule (product decision): a higher x.y.z always counts as an update.
   When the published release carries the SAME x.y.z (the release ritual ships
   b-number builds at one version), a strictly newer published-at timestamp
   still counts — classified 'build' so the UI can say "new build" instead of
   "new version". An unparseable tag with a newer date is also a 'build'.

   Fail-soft everywhere: no network, a private repo, a lying host or a dead
   API must look exactly like "no update info", never a broken app. The last
   good answer is cached under userData so a restart shows it instantly
   (sanitized again on read-back — the cache file is data, not authority).

   The pure half (parse/compare/sanitize) has no Electron or network deps and
   is unit-tested against a fake fetch in tests/unit/update.test.js. */
const fs = require('fs');
const path = require('path');
const { shell } = require('electron');
const { readCapped } = require('./capped-fetch');
const log = require('./logger');

const REPO = 'mockcomic/radial-wheel';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';
const API_URL = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const FETCH_TIMEOUT = 12000;
const JSON_MAX_BYTES = 256 * 1024;      // one release JSON never needs to be bigger
const TAG_RE = /^[\w.\-+]{1,100}$/;
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
      assets.push({ name, url, size: Number.isFinite(+a.size) ? +a.size : null });
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

/* ------------------------------- fetch + state ---------------------------- */

let infoCachePath = null;          // set by configure() from the main process
let latest = null;                 // last sanitized release (null = none)
let lastCheckMs = 0;               // epoch of the last completed check
let lastError = null;              // message of the last failed check
let status = 'idle';               // idle | checking | ready | error
let checking = null;               // in-flight promise, so concurrent checks share one request

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
    over a transient network blip — the next successful check replaces it). */
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

module.exports = {
  REPO, RELEASES_PAGE, API_URL,
  parseVersion, compareVersions, decide, releaseUrl, sanitizeRelease,
  configure, check, snapshot, openRelease,
  /* Test-only state wipe (the module is a singleton like the other main-side
     services; unit tests need each scenario to start from a blank slate). */
  _reset() { latest = null; lastCheckMs = 0; lastError = null; status = 'idle'; checking = null; infoCachePath = null; },
  _internals: () => ({ latest, lastCheckMs, status })
};
