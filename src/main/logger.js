'use strict';
/* Application file logging — the exe equivalent of the dev console.
   Every line lands on stdout/stderr (visible when launched via `npm run start`)
   AND in %APPDATA%\Nucleus\logs\nucleus-YYYY-MM-DD.log, so a
   packaged run that shows no terminal still leaves a debuggable trail.
   Renderer pages have no console anyone can read in a packaged build — their
   console.* and window errors ride an IPC channel into the SAME file (see
   forwardRenderer + the preload console hook).

   One file per day; the N oldest are pruned on each new day. A per-file byte
   cap stops a pathological loop from filling the disk: once hit, only the
   summary line keeps flowing. The logger is total: any write failure
   (unwritable userData) degrades to console-only, never throws, never dies.

   Levels: debug < info < warn < error. Packaged builds default to info;
   dev builds also print debug. Override per run:
     NUCLEUS_LOG_LEVEL=debug   (the legacy RADIALWHEEL_LOG_LEVEL is honored too; also --log-level=debug)
   The verify ritual greps this file for the `[nucleus] ready` marker. */

const fs = require('fs');
const path = require('path');

/* Lazy on purpose: modules required from main.js's require chain can load
   before electron exposes `app`, so every access goes through this. With no
   app yet, the logger degrades to console-only and catches up on first init. */
function appSafe() { try { return require('electron').app; } catch { return undefined; } }

const TAG = '[nucleus]';
const KEEP_DAYS = 14;             // prune daily files older than this many
const MAX_FILE_BYTES = 8 * 1024 * 1024; // per-day cap; overflow lines are dropped
const MAX_LINE_CHARS = 2000;      // one serialized argument list, clamped

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVEL_TAG = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

/* ------------------------------- configuration ------------------------------ */

function requestedLevel() {
  const fromArgv = (process.argv.find((a) => /^--log-level=/i.test(a)) || '').split('=')[1];
  const want = String(fromArgv || process.env.NUCLEUS_LOG_LEVEL || process.env.RADIALWHEEL_LOG_LEVEL || '').toLowerCase();
  if (LEVELS[want] != null) return want;
  /* dev builds want the chatty lines (hotkey probes, mouse-hook stats); a
     resident packaged build should only accrue what matters: info and up. */
  return 'info';
}

/* --------------------------------- internals -------------------------------- */

let dir = null;            // null => console-only (not yet/pathless/init-failed)
let dirWarned = false;
let day = '';              // YYYY-MM-DD of the open file
let bytesWritten = 0;
let capped = false;        // hit MAX_FILE_BYTES — further writes are skipped
let threshold = LEVELS.info;
let debugAllowed = false;  // dev builds print debug to the console too
let depth = 0;             // re-entrancy guard: a logger failure must not recurse

function stamp(d) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    '.' + p(d.getMilliseconds(), 3);
}

function dayName(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `nucleus-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`;
}

function safeName(c) {
  try { return c.constructor && c.constructor.name; } catch { return 'unknown'; }
}

function one(arg) {
  if (typeof arg === 'string') return arg;
  if (arg instanceof Error) return (arg.stack || arg.message) || String(arg);
  if (typeof arg === 'bigint') return String(arg);
  if (typeof arg === 'symbol') return String(arg);
  if (typeof arg === 'function') return `[Function ${arg.name || 'anonymous'}]`;
  try {
    return JSON.stringify(arg, (_k, v) => (typeof v === 'bigint' ? String(v) : v));
  } catch {
    return `[unserializable ${safeName(arg)}]`;
  }
}

function serialize(args) {
  let s;
  try {
    s = Array.prototype.map.call(args, one).join(' ');
  } catch {
    s = '[unloggable arguments]';
  }
  if (s === undefined) s = '[no arguments]';
  if (s.length > MAX_LINE_CHARS) s = s.slice(0, MAX_LINE_CHARS) + ` … [+${s.length - MAX_LINE_CHARS} chars]`;
  return s.replace(/\r?\n/g, ' | ');   // one event per line — log files stay grep-able
}

function openToday() {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, dayName(new Date()));
  try { bytesWritten = fs.statSync(file).size; } catch { bytesWritten = 0; }
  capped = bytesWritten >= MAX_FILE_BYTES;
  return file;
}

function pruneOldFiles(today) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  // the radial-wheel prefix is the pre-rename file shape — prune those too
  const daily = names.filter((n) => /^(?:nucleus|radial-wheel)-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
  const doomed = daily.slice(0, Math.max(0, daily.length - KEEP_DAYS + (today ? 0 : 1)));
  for (const n of doomed) {
    if (today && n === today) continue;
    try { fs.rmSync(path.join(dir, n), { force: true }); } catch { /* best effort */ }
  }
}

let activeFile = '';
function writeToDisk(line) {
  if (!ensureDir() || capped) return;
  const name = dayName(new Date());
  if (name !== day || !activeFile) {      // new day (or first write): (re)open
    day = name;
    try { activeFile = openToday(); } catch { activeFile = ''; return; }
    pruneOldFiles(name);
    if (capped) {
      try { process.stdout.write(`${TAG} log file hit ${Math.round(MAX_FILE_BYTES / 1048576)} MB — file logging paused for today\n`); } catch { /* ignore */ }
      return;
    }
  }
  bytesWritten += line.length + 1;
  fs.appendFileSync(activeFile, line + '\n');   // sync: lines survive a hard kill
}

function emit(level, prefix, args) {
  if (LEVELS[level] < threshold) return;
  if (level === 'debug' && !debugAllowed) return;
  if (depth > 0) return;                  // logging inside the logger: bail out
  depth++;
  try {
    const line = `${stamp(new Date())} ${LEVEL_TAG[level]} ${prefix ? prefix + ' ' : ''}${TAG} ${serialize(args)}`;
    const to = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    try { to.write(line + '\n'); } catch { /* pipe closed (detached launch) */ }
    writeToDisk(line);
  } catch { /* the logger must never be the thing that crashes the app */ }
  finally { depth--; }
}

/* ---------------------------------- public API -------------------------------- */

/* Resolve (once) the logs dir under userData. Safe to call before whenReady:
   returns null when the app isn't exposed yet, and the next call retries. */
function ensureDir() {
  if (dir) return dir;
  const app = appSafe();
  if (!app) return null;
  try {
    dir = path.join(app.getPath('userData'), 'logs');
    day = '';
    return dir;
  } catch (err) {
    dir = null;
    if (!dirWarned) {
      dirWarned = true;
      try { process.stderr.write(`${TAG} file logging disabled (${err && err.message})\n`); } catch { /* nothing left */ }
    }
    return null;
  }
}

function init() {
  const want = requestedLevel();
  threshold = LEVELS[want] != null ? LEVELS[want] : LEVELS.info;
  const app = appSafe();
  debugAllowed = app ? !app.isPackaged : false;
  return ensureDir();
}

function dir_() { return ensureDir(); }

function debug(...a) { emit('debug', null, a); }
function info(...a) { emit('info', null, a); }
function warn(...a) { emit('warn', null, a); }
function error(...a) { emit('error', null, a); }

/* The dist build number, stamped into src/main/build-info.js by
   scripts/bump-build.mjs (electron-builder strips the package.json `build`
   block from the packaged app, so the app cannot read it from there). Absent
   file — a dev tree that never ran dist — and the seed "0" both mean
   "never packaged" → plain versions. */
function buildNumber() {
  try {
    const n = require('./build-info').buildNumber;
    const s = typeof n === 'string' || typeof n === 'number' ? String(n) : '';
    return /^\d+$/.test(s) && parseInt(s, 10) > 0 ? s : null;
  } catch { return null; }
}

/* One boot banner per process: version + where the log lives. Call inside
   whenReady — app.getVersion()/userData are guaranteed by then. */
function banner() {
  try {
  const app = appSafe();
  const ver = app && app.getVersion ? app.getVersion() : '?';
  const bn = buildNumber();
  const pack = app && app.isPackaged ? 'packaged' : 'dev';
  info(`starting — v${ver}${bn ? ` (build ${bn})` : ''} (electron ${process.versions.electron}, ${process.platform} ${process.arch} ${typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : ''}, ${pack})`);
  const d = ensureDir();
  if (d) info(`logging to ${path.join(d, dayName(new Date()))} (level: ${debugAllowed && threshold <= LEVELS.debug ? 'debug' : 'info'} and up)`);
  else warn('log file unavailable — console output only');
  } catch { /* diagnostics never break startup */ }
}

/* IPC entry ('log:line', payload) from the preload console hook. Untrusted
   text: stringified, clamped, newline-flattened like everything else. */
function forwardRenderer(payload) {
  try {
    if (!payload || typeof payload !== 'object') return;
    const lvl = LEVELS[payload.level] != null ? payload.level : 'info';
    const page = String(payload.page || 'renderer').replace(/[^\w-]/g, '').slice(0, 24) || 'renderer';
    const where = payload.source ? ` (${String(payload.source).replace(/[\r\n]/g, ' ').slice(0, 160)}${payload.line ? ':' + (payload.line | 0) : ''})` : '';
    emit(lvl, `[renderer:${page}]${where}`, [payload.args]);
  } catch { /* never let a bad log payload break IPC */ }
}

module.exports = { init, dir: dir_, debug, info, warn, error, banner, forwardRenderer, buildNumber, TAG };
