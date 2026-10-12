'use strict';
/* Post-launch placement of freshly-opened APP WINDOWS.

   behavior.appOpenPosition ('default' | 'cursor' | 'center', Settings →
   Hotkey & Behavior): 'default' leaves window placement to the app itself —
   today's behavior and the safe off-switch. 'cursor'/'center' arm a short
   watcher around each wheel-launched program/file/link: we snapshot every
   process that already owns a top-level window, poll EnumWindows for a few
   seconds, and slide the first GENUINELY NEW window (a pid absent from the
   snapshot) under the cursor or into the work-area centre of the cursor's
   monitor with SetWindowPos. The radial wheel itself is unaffected — the
   overlay always pops at the pointer (windows.js).

   Deliberate limits, so the feature never fights an app:
   - Only NEW windows move. An app raising an already-open window (a browser
     new-tab, a single-instance re-click) was in the snapshot → untouched.
   - A maximized or minimized first window is the app asserting its own
     placement → the watch gives up on it silently.
   - The window must sit STILL for STABLE_POLLS sweeps before moving, so apps
     that position themselves a beat after showing (browsers restoring their
     saved frame) are moved from their final spot, not an intermediate one.
   - One window moved per launch; concurrent launches cannot both claim a
     pid (shared claimed set, stale entries pruned at each arm).
   - All coordinates stay PHYSICAL pixels end to end (GetPhysicalCursorPos /
     GetMonitorInfoW / SetWindowPos) — mixing those with Electron's DIP-space
     screen API on a 150%-scaled display would jump windows by the scale
     factor, so the electron screen API is never consulted here.

   FFI discipline (see .dsh/skills/win32-koffi): koffi is only ever reached
   through macro.ffi's guarded passthroughs; no koffi, non-win32, a failed
   declaration, or any Win32 throw degrades to NO placement (the app keeps
   its own chosen spot) — never an error to the user. */
const log = require('./logger');
const macro = require('./macro');

const POLL_MS = 120;            // EnumWindows sweep cadence
const WATCH_MS = 5000;          // window in which a launched app's window must appear
const STABLE_POLLS = 3;         // ~360 ms of unchanged geometry before the move fires
const GWL_STYLE = -16;
const WS_CHILD_STYLE = 0x40000000;
const WS_MAXIMIZE_STYLE = 0x01000000;
const SWP_FLAGS = 0x0001 /* NOSIZE */ | 0x0004 /* NOZORDER */ | 0x0010 /* NOACTIVATE */;
const MONITOR_DEFAULTTONEAREST = 2;

/* --------------------------- pure geometry (unit-tested) --------------------------- */
/* The point a window of this mode should land its CENTER on: the captured
   cursor for 'cursor', the work-area centre (taskbar excluded) for 'center'.
   Plain {x,y}/{x,y,width,height} rects in; plain {x,y} out — no FFI, no electron. */
function targetCenter(mode, cursor, work) {
  if (mode === 'center' && work) {
    return { x: work.x + work.width / 2, y: work.y + work.height / 2 };
  }
  return { x: cursor.x, y: cursor.y };
}

/* Top-left that centers the win rect on `target`, clamped fully inside the
   monitor's bounds (a window larger than the monitor clamps to the origin,
   never a negative-width nonsense range). */
function computeMoveTarget(win, target, bounds) {
  let x = Math.round(target.x - win.width / 2);
  let y = Math.round(target.y - win.height / 2);
  x = Math.min(Math.max(x, bounds.x), bounds.x + Math.max(0, bounds.width - win.width));
  y = Math.min(Math.max(y, bounds.y), bounds.y + Math.max(0, bounds.height - win.height));
  return { x, y };
}

/* ------------------------------- FFI surface -------------------------------------- */
let F = null, F_FAILED = false, _enumCb = null;
let sweep = null;   // scratch state the EnumWindows proc reads; only live during a sweep

function funcs() {
  if (F) return F;
  if (F_FAILED || process.platform !== 'win32' || !macro.available) return null;
  try {
    const ffi = macro.ffi;
    F = {
      EnumWindows: ffi.declareUser32('int32 __stdcall EnumWindows(void* lpEnumFunc, intptr_t lParam)'),
      IsWindowVisible: ffi.declareUser32('int32 __stdcall IsWindowVisible(void* hWnd)'),
      IsIconic: ffi.declareUser32('int32 __stdcall IsIconic(void* hWnd)'),
      GetWindowTextLengthW: ffi.declareUser32('int32 __stdcall GetWindowTextLengthW(void* hWnd)'),
      GetWindowLongW: ffi.declareUser32('int32 __stdcall GetWindowLongW(void* hWnd, int32 nIndex)'),
      GetWindowThreadProcessId: ffi.declareUser32('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)'),
      GetWindowRect: ffi.declareUser32('int32 __stdcall GetWindowRect(void* hWnd, void* lpRect)'),
      SetWindowPos: ffi.declareUser32('int32 __stdcall SetWindowPos(void* hWnd, void* hWndInsertAfter, int32 x, int32 y, int32 cx, int32 cy, uint32 uFlags)'),
      GetPhysicalCursorPos: ffi.declareUser32('int32 __stdcall GetPhysicalCursorPos(void* lpPoint)'),
      // POINT {LONG x; LONG y} is 8 bytes: the MS x64 ABI passes it as ONE
      // integer register (x low dword, y high). Declaring the parameter as a
      // packed int64 avoids koffi's by-value struct support entirely; the
      // app is x64-only, so this is the whole contract.
      MonitorFromPoint: ffi.declareUser32('int32 __stdcall MonitorFromPoint(int64 pt, uint32 dwFlags)'),
      GetMonitorInfoW: ffi.declareUser32('int32 __stdcall GetMonitorInfoW(void* hMonitor, void* lpmi)')
    };
    const proto = ffi.proto('int32 __stdcall RwPlaceEnumProc(void* hWnd, intptr_t lParam)');
    _enumCb = ffi.register(enumProc, ffi.pointer(proto));   // pinned for the process lifetime
  } catch (err) {
    F_FAILED = true; F = null; _enumCb = null;
    log.debug('winplace: FFI unavailable —', (err && err.message) || err);
  }
  return F;
}

function packPoint(p) { return p.y * 0x100000000 + (p.x >>> 0); }

/* One window per enumeration; every bail-out says "continue" — a window that
   cannot be inspected is skipped, never fatal. Runs synchronously on the
   caller's stack inside EnumWindows (single-threaded scratch, no tearing). */
function enumProc(hWnd) {
  const s = sweep;
  if (!s) return 1;
  try {
    if (!hWnd) return 1;
    const pidBuf = Buffer.alloc(4);
    F.GetWindowThreadProcessId(hWnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    if (!pid || pid === process.pid) return 1;            // never touch our own overlay/settings
    if (s.mode === 'pids') { s.pids.add(pid); return 1; } // snapshot: every owner counts, even windowless-then-shown
    if (s.known.has(pid) || s.claimed.has(pid)) return 1; // not freshly launched → none of our business
    if (!F.IsWindowVisible(hWnd) || !F.GetWindowTextLengthW(hWnd)) return 1;
    const style = F.GetWindowLongW(hWnd, GWL_STYLE) >>> 0;
    if (style & WS_CHILD_STYLE) return 1;
    const rectBuf = Buffer.alloc(16);
    if (!F.GetWindowRect(hWnd, rectBuf)) return 1;
    const l = rectBuf.readInt32LE(0), t = rectBuf.readInt32LE(4);
    const w = rectBuf.readInt32LE(8) - l, h = rectBuf.readInt32LE(12) - t;
    if (w <= 0 || h <= 0) return 1;
    s.cands.push({ hWnd, pid, l, t, width: w, height: h,
      max: (style & WS_MAXIMIZE_STYLE) !== 0, iconic: !!F.IsIconic(hWnd) });
  } catch { /* skip this window on any FFI hiccup */ }
  return 1;
}

function enumerate(state) {
  sweep = state;
  try { F.EnumWindows(_enumCb, 0); } finally { sweep = null; }
  return state.mode === 'pids' ? state.pids : state.cands;
}

/* pids the currently-active watches already moved or gave up on, with their
   arm time so a recycled pid is not starved forever by a stale claim. */
const claimed = new Map();   // pid -> Date.now() at claim

function snapshotKnownPids() {
  return enumerate({ mode: 'pids', pids: new Set(), claimed: null });
}

/* ------------------------------- the watcher --------------------------------------- */
/**
 * Arm a placement watch if (and only if) the live setting says so. Call
 * BEFORE the launch happens (beginWatch snapshots synchronously; new windows
 * cannot exist before the spawn anyway). Returns true when a watch is active
 * — false means placement is off/unavailable and the launch proceeds
 * untouched. Never throws, never blocks past one EnumWindows pass.
 */
function beginWatch(ctx) {
  const mode = ctx && (ctx.appOpenPosition === 'cursor' || ctx.appOpenPosition === 'center')
    ? ctx.appOpenPosition : null;
  if (!mode) return false;
  const f = funcs();
  if (!f) { log.info('winplace: watch not armed (no FFI surface)'); return false; }
  try {
    const pt = Buffer.alloc(8);
    if (!f.GetPhysicalCursorPos(pt)) { log.info('winplace: watch not armed (cursor position unavailable)'); return false; }
    const cursor = { x: pt.readInt32LE(0), y: pt.readInt32LE(4) };
    // Prune claims older than the watch budget: they can only be from dead
    // watches, and an old pid must be claimable by a later launch.
    const now = Date.now();
    for (const [pid, at] of claimed) if (now - at > WATCH_MS) claimed.delete(pid);
    const liveClaims = new Set(claimed.keys());
    const known = snapshotKnownPids();
    if (!known) return false;
    const st = { mode, cursor, known, claimed: liveClaims, cand: null, stable: 0, until: Date.now() + WATCH_MS };
    const timer = setInterval(() => {
      try { sweepOnce(st, timer); } catch (err) { stop(timer); log.warn('winplace: sweep failed —', (err && err.message) || err); }
    }, POLL_MS);
    if (timer.unref) timer.unref();   // never hold the tray app open
    log.info(`winplace: watch armed [${mode}] — looking for a new window within ${WATCH_MS / 1000}s`);
    return true;
  } catch (err) {
    log.debug('winplace: watch arm failed —', (err && err.message) || err);
    return false;
  }
}

function stop(timer) { clearInterval(timer); }

function sweepOnce(st, timer) {
  if (Date.now() > st.until) {
    if (!st.cand) log.info('winplace: no new window within the watch — an already-open app raising its existing window is not an "opening" (this is by design)');
    else log.info('winplace: watch expired before the new window settled — left it where the app put it');
    stop(timer);
    return;
  }
  const cands = enumerate({ mode: 'cands', known: st.known, claimed: st.claimed, cands: [] });

  if (!st.cand) {
    const hit = cands.find((c) => !c.max && !c.iconic);
    // A new pid whose only window opens maximized/minimized chose its own
    // spot; claim the pid so a sibling watch skips it too, and keep watching
    // only while there is still time (a later plain window still counts).
    if (hit) { st.cand = { pid: hit.pid, l: hit.l, t: hit.t, width: hit.width, height: hit.height, hWnd: hit.hWnd }; st.stable = 0; }
    else if (cands.length && !st.maxedLogged) {
      st.maxedLogged = true;
      log.info(`winplace: new window (pid ${cands[0].pid}) opened maximized/minimized — the app chose its own placement`);
    }
    return;
  }
  const same = cands.find((c) => c.pid === st.cand.pid);
  if (!same) { st.cand = null; st.stable = 0; return; }     // vanished before it settled — re-look
  if (same.max || same.iconic) { claimed.set(st.cand.pid, Date.now()); st.cand = null; return; }
  if (same.l !== st.cand.l || same.t !== st.cand.t || same.width !== st.cand.width || same.height !== st.cand.height) {
    st.cand = { pid: same.pid, l: same.l, t: same.t, width: same.width, height: same.height, hWnd: same.hWnd };
    st.stable = 0;
    return;
  }
  st.stable++;
  if (st.stable < STABLE_POLLS) return;

  // Settle on the geometry, then move. Monitor resolved from the captured
  // cursor: BOTH modes target the pointer's screen (the window may have
  // opened on another one; the move walks it over).
  const hmon = F.MonitorFromPoint(packPoint(st.cursor), MONITOR_DEFAULTTONEAREST);
  const mi = Buffer.alloc(40);
  mi.writeUInt32LE(40, 0);
  if (!hmon || !F.GetMonitorInfoW(hmon, mi)) { stop(timer); return; }
  const rectAt = (off) => ({
    x: mi.readInt32LE(off), y: mi.readInt32LE(off + 4),
    width: mi.readInt32LE(off + 8) - mi.readInt32LE(off),
    height: mi.readInt32LE(off + 12) - mi.readInt32LE(off + 4)
  });
  const bounds = rectAt(4);           // MONITORINFO.rcMonitor
  const work = rectAt(20);            // MONITORINFO.rcWork
  const target = targetCenter(st.mode, st.cursor, work);
  const { x, y } = computeMoveTarget(st.cand, target, bounds);
  claimed.set(st.cand.pid, Date.now());
  if (F.SetWindowPos(st.cand.hWnd, 0, x, y, 0, 0, SWP_FLAGS)) {
    log.info(`winplace: moved new window (pid ${st.cand.pid}) to ${x},${y} [${st.mode}]`);
  } else {
    log.info(`winplace: SetWindowPos refused for pid ${st.cand.pid} — window left where the app put it`);
  }
  stop(timer);
}

module.exports = { beginWatch, targetCenter, computeMoveTarget };
