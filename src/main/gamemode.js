'use strict';
/* Gaming mode: while a game or fullscreen application owns the foreground, the
   wheel pauses itself (hotkey unregistered, overlay hidden) and un-pauses when
   it closes. The pure decision logic below is Electron- and FFI-free so it can
   be unit-tested; the Win32 side lives in macro.js (the sanctioned FFI module)
   and is injected into GameModeWatcher as `probe()`. */
const { EventEmitter } = require('events');

const POLL_MS = 1500;      // foreground sampling interval while enabled
const PAUSE_TICKS = 2;     // consecutive positive ticks before pausing (focus-blip hysteresis)
const MAX_APPS = 64;       // cap on the always-pause app list
const APP_NAME_RE = /^[\w .\-\u0080-\uffef]{1,64}$/;
const WS_CHILD = 0x40000000;

/* Normalize one user-supplied entry to a lowercase exe basename
   ("C:\Games\Foo.exe" -> "foo.exe"); junk becomes null. */
function cleanAppName(raw) {
  if (typeof raw !== 'string') return null;   // numbers/objects are config junk
  let s = raw.trim().toLowerCase();
  if (!s) return null;
  const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (slash >= 0) s = s.slice(slash + 1);
  s = s.replace(/["']/g, '').trim();
  if (!s || !APP_NAME_RE.test(s)) return null;
  return s;
}

/** Config sanitation for behavior.gameMode: { enabled, apps[] }, never throws. */
function sanitizeGameMode(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = { enabled: src.enabled === true, apps: [] };
  if (Array.isArray(src.apps)) {
    const seen = new Set();
    for (const it of src.apps) {
      const name = cleanAppName(it);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.apps.push(name);
      if (out.apps.length >= MAX_APPS) break;
    }
  }
  return out;
}

/** Does rect a = [l,t,r,b] cover rect b entirely? */
function rectCovers(a, b) {
  return !!(a && b) && a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];
}

/** Case-insensitive basename match against the (already sanitized) app list. */
function matchAppList(exe, apps) {
  if (!exe || !Array.isArray(apps)) return false;
  const e = String(exe).toLowerCase();
  return apps.some((a) => String(a).toLowerCase() === e);
}

/**
 * Pure verdict for one poll.
 * probe — { pid, exe, winRect, monRect, style } from macro.foregroundProbe(),
 *         or null when the foreground could not be read (fail OPEN: never
 *         pauses on FFI failure / non-Windows, mirroring macro.isDown).
 * Pause when the foreground process is on the app list, or (except explorer.exe,
 * our own pid, and child windows) it covers its monitor entirely — exclusive or
 * borderless-fullscreen games. A merely *maximized* window never matches:
 * Windows insets maximized frames ~8 px off the monitor edge.
 */
function shouldPause(probe, gameMode, ourPid) {
  if (!gameMode || !gameMode.enabled) return false;
  if (!probe) return false;
  if (probe.pid && probe.pid === ourPid) return false;   // our overlay / Settings windows
  const exe = String(probe.exe || '').toLowerCase();
  if (matchAppList(exe, gameMode.apps)) return true;     // explicit list wins, even windowed
  if (exe === 'explorer.exe') return false;              // desktop shell is not a game
  if (probe.style !== undefined && (probe.style & WS_CHILD)) return false;
  return rectCovers(probe.winRect, probe.monRect);
}

/** Why a tick is positive, for the tray label: the exe, or "fullscreen". */
function pauseReason(probe, gameMode) {
  if (!probe) return null;
  const exe = String(probe.exe || '').toLowerCase();
  return matchAppList(exe, gameMode.apps) ? exe : 'fullscreen';
}

/** Debounce: PAUSE_TICKS consecutive positives to pause, one negative to resume. */
class PauseLadder {
  constructor(pauseTicks = PAUSE_TICKS) {
    this.need = Math.max(1, pauseTicks);
    this.pos = 0;
    this.paused = false;
  }
  /** Returns 'pause' | 'resume' | null for this tick. */
  tick(positive) {
    if (this.paused) {
      if (positive) { this.pos = this.need; return null; }
      this.paused = false; this.pos = 0;
      return 'resume';
    }
    if (!positive) { this.pos = 0; return null; }
    this.pos++;
    if (this.pos >= this.need) { this.paused = true; return 'pause'; }
    return null;
  }
  reset() { this.pos = 0; this.paused = false; }
}

class GameModeWatcher extends EventEmitter {
  /**
   * getConfig — () => full config (fresh each tick, so toggling off mid-game resumes).
   * probe     — () => foreground probe | null; injectable for tests.
   * opts      — { ourPid, pollMs, pauseTicks }
   */
  constructor(getConfig, probe, opts = {}) {
    super();
    this.getConfig = getConfig;
    this.probe = probe || (() => require('./macro').foregroundProbe());
    this.ourPid = opts.ourPid !== undefined ? opts.ourPid : process.pid;
    this.pollMs = opts.pollMs || POLL_MS;
    this.ladder = new PauseLadder(opts.pauseTicks);
    this.timer = null;
    this.active = false;
    this.reason = null;
  }

  /** Call on startup and on every config change: (re)arms or disarms the poll. */
  configure() {
    const gm = this._gameMode();
    if (gm.enabled) {
      if (!this.timer) this.timer = setInterval(() => this._tick(), this.pollMs);
      return;
    }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    // Disabling must drop a live pause immediately (e.g. user needs the hotkey back).
    if (this.active) this._resume('disabled');
    this.ladder.reset();
  }

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.active = false;
    this.reason = null;
    this.ladder.reset();
  }

  _gameMode() {
    let cfg = null;
    try { cfg = this.getConfig(); } catch { /* store not ready */ }
    const bhv = (cfg && cfg.behavior) || {};
    return bhv.gameMode || { enabled: false, apps: [] };
  }

  _tick() {
    const gm = this._gameMode();
    if (!gm.enabled) {                                   // raced a disable between ticks
      if (this.timer) { clearInterval(this.timer); this.timer = null; }
      if (this.active) this._resume('disabled');
      this.ladder.reset();
      return;
    }
    let probe = null;
    try { probe = this.probe(); } catch { probe = null; } // fail-open on any probe error
    const step = this.ladder.tick(shouldPause(probe, gm, this.ourPid));
    if (step === 'pause' && !this.active) {
      this.active = true;
      this.reason = pauseReason(probe, gm);
      this.emit('pause', this.reason);
    } else if (step === 'resume' && this.active) {
      this._resume(this.reason);
    }
  }

  _resume(reason) {
    const was = this.reason;
    this.active = false;
    this.reason = null;
    this.emit('resume', reason || was);
  }
}

module.exports = {
  POLL_MS, PAUSE_TICKS,
  cleanAppName, sanitizeGameMode, rectCovers, matchAppList, shouldPause, pauseReason,
  PauseLadder, GameModeWatcher
};
