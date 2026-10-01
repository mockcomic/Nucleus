'use strict';
/* Global mouse-button summon trigger, implemented as a WH_MOUSE_LL low-level
   mouse hook (Electron's globalShortcut is keyboard-only).

   Three things this file has to get right at once:

   1. THE HOOK BODY IS ON THE SYSTEM'S INPUT CRITICAL PATH. Windows calls the
      procedure on OUR thread (Electron's main thread, which pumps messages) and
      holds up every mouse event in the session until it returns. So the hot path
      is a handful of integer compares and NOTHING ELSE: no Electron API, no
      allocation-heavy work, no throwing. Real work (moving/showing the overlay)
      is deferred with setImmediate() to after the hook returns. If the body ever
      stalls past the OS LowLevelHooksTimeout, Windows silently drops the hook —
      that is why every bail-out here calls CallNextHookEx (fail-open: a stuck
      hook must never eat the user's clicks).

   2. SWALLOWING IS PAIRED. A low-level hook can only hide an event by returning
      non-zero, so hiding the press without hiding its release would hand the
      target app a stray button-up. `state.suppressed` therefore carries the
      decision from the down event to the matching up event.

   3. NO LEAKED HOOK. clear() unhooks the moment the trigger stops being a mouse
      button (keyboard hotkey, tray pause, gaming mode) and shutdown() runs at
      quit — a hook that outlives us would keep stealing clicks.

   All Win32 access goes through macro.ffi (the one sanctioned koffi load site,
   see .dsh/skills/win32-koffi): if koffi did not load, nothing here installs and
   setTrigger() returns a human error so the Settings UI can suggest a keyboard
   hotkey instead. */
const IS_WIN = process.platform === 'win32';
const macro = require('./macro');

const WH_MOUSE_LL = 14;
const WM_XBUTTONDOWN = 0x020b;
const WM_XBUTTONUP = 0x020c;
const LLMHF_INJECTED = 0x0001;

/* MSLLHOOKSTRUCT field offsets on x64
   (POINT pt {LONG x,LONG y} @0, DWORD mouseData @8, DWORD flags @12). */
const OFF_MOUSE_DATA = 8;
const OFF_FLAGS = 12;
const XBUTTON1 = 1; // browser-style "Back"
const XBUTTON2 = 2; // browser-style "Forward"

/** The recordable buttons: canonical spec token -> wire details.
 *  Left/right deliberately absent — see hotkeys.js MOUSE_KEYS. */
const TRIGGERS = {
  mmiddle: { vk: 0x04, down: 0x0207, up: 0x0208, xdata: null, label: 'Middle click' },
  mback: { vk: 0x05, down: WM_XBUTTONDOWN, up: WM_XBUTTONUP, xdata: XBUTTON1, label: 'Back button' },
  mfwd: { vk: 0x06, down: WM_XBUTTONDOWN, up: WM_XBUTTONUP, xdata: XBUTTON2, label: 'Forward button' }
};

/* Keyboard modifiers that may accompany a mouse trigger, as VK codes for
   GetAsyncKeyState (macro.isDown). */
const MOD_VKS = { ctrl: 0x11, alt: 0x12, shift: 0x10, super: 0x5b, win: 0x5b, cmd: 0x5b, meta: 0x5b };

/* --------------------------------- FFI state ------------------------------- */
let _CallNextHookEx = null, _SetWindowsHookExW = null, _UnhookWindowsHookEx = null;
let _cbHandle = null;      // koffi-registered callback; pinned, reused across installs
let _hook = null;          // live HHOOK, or null when nothing is installed
let _ffiError = null;      // first install failure, for the user-facing message

/* Manual-verification hatch: with RADIAL_WHEEL_TEST_INPUT=1, presses injected
   through SendInput (which arrive flagged LLMHF_INJECTED) are accepted like real
   ones, so a scripted click can drive the trigger during development. Read ONCE
   at load so the hook body never touches process.env, and never enabled by the
   app itself: an end user's hook always ignores synthesized input. (Automated
   injection is not a reliable check anyway — SendInput from a sandboxed shell may
   never reach the hook — so the real evidence is --mouse-hook-probe with a hand
   on the mouse.) */
const TEST_INPUT = /^(1|true|yes)$/i.test(String(process.env.RADIAL_WHEEL_TEST_INPUT || ''));

/* Cheap counters for diagnostics/log lines: is the hook actually being called,
   and what has it done? Integer increments only — still off the critical path. */
const stats = { calls: 0, lastMsg: 0, seen: 0, fired: 0, swallowed: 0, injectedIgnored: 0, lastFlags: 0, lastXdata: 0, lastInjected: false, buttons: {} };
const WM_MOUSEMOVE = 0x0200;
const WM_MOUSEWHEEL = 0x020a;

/* The decision the hook body makes per event. Only ONE button is ever armed, so
   two booleans beat a Set: `held` is the auto-repeat guard, `suppressed` carries
   the swallow decision from the press to its release. */
const state = {
  armed: false,
  down: 0, up: 0, xdata: null,
  mods: [],
  clickThrough: false,
  acceptInjected: false,
  held: false,
  suppressed: false
};
let _onFire = null;
let _token = null;       // which button is armed, for diagnostics

const PASS = Object.freeze({ next: true, swallow: false, fire: false });
const SWALLOW = Object.freeze({ next: false, swallow: true, fire: false });
const FIRE_THROUGH = Object.freeze({ next: true, swallow: false, fire: true });
const FIRE_SWALLOW = Object.freeze({ next: false, swallow: true, fire: true });

function modsDown(mods, isDown) {
  for (const m of mods) {
    // Canonical spec names arrive as 'Ctrl'/'Alt'/'Shift'/'Super'; the table is
    // lowercase. An unknown token is treated as NOT held (fail-closed: a trigger
    // we cannot evaluate must not fire).
    const vk = MOD_VKS[String(m).toLowerCase()];
    if (!vk || !isDown(vk)) return false;
  }
  return true;
}

/**
 * Extract the XBUTTON id (1 = Back, 2 = Forward) from MSLLHOOKSTRUCT.mouseData.
 *
 * MSDN says the id sits in the LOW-order word (XBUTTON1 0x0001 / XBUTTON2 0x0002),
 * but real drivers are not that tidy: several vendor stacks deliver it in the
 * HIGH-order word instead (observed in the field as mouseData === 0x00010000,
 * where the correct low-word value would be 0x00000001). Apps that only read the
 * low word silently ignore those buttons — which is exactly what a user with such
 * a mouse sees: side buttons that "do nothing" anywhere. Accept either placement
 * so both conventions summon; a zero in both still means "not our button".
 */
function xbuttonId(raw) {
  const low = (raw >>> 0) & 0xFFFF;
  return low !== 0 ? low : ((raw >>> 0) >>> 16);
}

/**
 * Pure half of the hook, exported for node:test as _hookStep.
 * Mutates the passed `st` (that IS the state machine) and returns what the hook
 * body should do with the event. `ev` is { msg, xdata?, injected? }; `isDown(vk)`
 * is the async-key-state probe, injectable so tests never touch FFI.
 *
 * Deliberately allocation-free on the hot path: the two constant returns cover
 * "not our event".
 */
function hookStep(st, ev, isDown) {
  if (!st.armed) return PASS;
  const isDownMsg = ev.msg === st.down;
  const isUpMsg = ev.msg === st.up;
  if (!isDownMsg && !isUpMsg) return PASS;                                  // some other button/wheel move
  if (ev.injected && !st.acceptInjected) return PASS;                       // never feed on synthesized input
  if (!isDownMsg) {
    // Release. Paired by MESSAGE alone, never by mouseData: drivers that omit or
    // mangle the release's button id must not leave `held`/`suppressed` stuck —
    // that would silently kill the trigger after one press. Worst case a stray
    // release of the sibling XBUTTON consumes a pending swallow, and the target
    // app sees an orphan button-up (harmless: no app acts on a release alone).
    const swallow = st.suppressed;
    st.suppressed = false;
    st.held = false;
    return swallow ? SWALLOW : PASS;
  }
  // Press: this is where Back and Forward are told apart.
  if (st.xdata !== null && xbuttonId(ev.xdata) !== st.xdata) return PASS;
  const wasHeld = st.held;
  st.held = true;                                                           // up will clear it again
  if (wasHeld) return PASS;                                                 // auto-repeat while held down
  if (st.mods.length && !modsDown(st.mods, isDown || macro.isDown)) return PASS; // chord not complete
  if (st.clickThrough) return FIRE_THROUGH;
  st.suppressed = true;
  return FIRE_SWALLOW;
}

/* -------------------------------- hook body -------------------------------- */
function hookProc(nCode, wParam, lParam) {
  try {
    if (nCode < 0) return _CallNextHookEx(_hook, nCode, wParam, lParam);    // must pass through
    const st = state;
    if (!st.armed) return _CallNextHookEx(_hook, nCode, wParam, lParam);    // keyboard-only trigger
    const msg = Number(wParam) >>> 0;
    // `calls` counts EVERY event the proc was handed, matched or not, and
    // `lastMsg` remembers its message id. That is what distinguishes "the hook
    // is live but this button never arrives" (driver remaps the button / another
    // app's hook swallowed it first) from "the hook never runs at all".
    stats.calls++; stats.lastMsg = msg;
    // Histogram of BUTTON events only (moves/wheel would drown it): tells a
    // support session whether a given button reaches the hook at all, and under
    // which message id — vendor drivers sometimes remap Back/Forward to a left
    // click or a keyboard scan, which never appears as WM_XBUTTON*.
    if (msg !== WM_MOUSEMOVE && msg !== WM_MOUSEWHEEL) {
      stats.buttons[msg] = (stats.buttons[msg] || 0) + 1;
    }
    // Two integer compares decide almost every system-wide event before we
    // touch lParam at all. XBUTTONs are the one exception we peek at even when
    // they are not the armed button, so the audit can report which button id the
    // device actually reports (drivers disagree about Back vs Forward wiring).
    const isX = msg === WM_XBUTTONDOWN || msg === WM_XBUTTONUP;
    if (msg !== st.down && msg !== st.up && !isX) return _CallNextHookEx(_hook, nCode, wParam, lParam);
    const flags = macro.ffi.decode(lParam, OFF_FLAGS, 'uint32');
    const xdata = (st.xdata !== null || isX) ? macro.ffi.decode(lParam, OFF_MOUSE_DATA, 'uint32') : 0;
    const injected = (flags & LLMHF_INJECTED) !== 0;
    if (injected && !st.acceptInjected) stats.injectedIgnored++;
    // Decoded field audit: for an XBUTTON trigger the mouseData comparison is the
    // one thing that can silently reject a real press, so keep the raw values.
    stats.lastFlags = flags >>> 0;
    stats.lastXdata = (xdata >>> 0);
    stats.lastInjected = injected;
    const d = hookStep(st, { msg, xdata, injected }, macro.isDown);
    if (msg === st.down || msg === st.up) stats.seen++;   // events for the ARMED button
    if (d.swallow) stats.swallowed++;
    if (d.fire) {
      stats.fired++;
      if (TEST_INPUT) console.log('[radial-wheel] mouse trigger fired');       // verification evidence
      const cb = _onFire;
      if (cb) setImmediate(() => { try { cb(); } catch { /* the trigger must never break the app */ } });
    }
    return d.next ? _CallNextHookEx(_hook, nCode, wParam, lParam) : 1;
  } catch {
    // Fail-open, stated: on any internal error the click goes to the app and no
    // summon happens. The alternative (throwing out of a hook proc) is undefined
    // behaviour on the user's entire mouse input path.
    try { return _CallNextHookEx(_hook, nCode, wParam, lParam); } catch { return 0; }
  }
}

/* ------------------------------- install / tear ---------------------------- */
function ensureHook() {
  if (_hook) return true;
  if (!IS_WIN || !macro.ffi.available) {
    _ffiError = macro.ffi.loadError || (IS_WIN ? 'input bridge unavailable' : 'not on Windows');
    return false;
  }
  try {
    if (!_cbHandle) {
      _CallNextHookEx = macro.ffi.declareUser32('int32 __stdcall CallNextHookEx(void* hhk, int32 nCode, uintptr wParam, void* lParam)');
      _SetWindowsHookExW = macro.ffi.declareUser32('void* __stdcall SetWindowsHookExW(int32 idHook, void* lpfn, void* hMod, uint32 dwThreadId)');
      _UnhookWindowsHookEx = macro.ffi.declareUser32('int32 __stdcall UnhookWindowsHookEx(void* hhk)');
      const proto = macro.ffi.proto('int64 __stdcall MouseLlProc(int nCode, uintptr wParam, void* lParam)');
      _cbHandle = macro.ffi.register(hookProc, macro.ffi.pointer(proto));
    }
    // hMod is ignored for WH_MOUSE_LL; dwThreadId 0 = watch every thread.
    _hook = _SetWindowsHookExW(WH_MOUSE_LL, _cbHandle, null, 0);
    if (!_hook) { _ffiError = 'SetWindowsHookExW(WH_MOUSE_LL) was refused'; return false; }
    return true;
  } catch (e) {
    _hook = null;
    _ffiError = (e && e.message) ? e.message : String(e);
    return false;
  }
}

function resetTransient() {
  state.held = false;
  state.suppressed = false;
}

/** Uninstall the hook but keep the pinned callback for a later re-install. */
function clear() {
  state.armed = false;
  _onFire = null;
  _token = null;
  stats.calls = 0; stats.lastMsg = 0; stats.buttons = {};
  stats.lastFlags = 0; stats.lastXdata = 0; stats.lastInjected = false;
  stats.seen = 0; stats.fired = 0; stats.swallowed = 0; stats.injectedIgnored = 0;
  resetTransient();
  if (_hook) {
    try { if (_UnhookWindowsHookEx(_hook) === 0) _ffiError = 'UnhookWindowsHookEx failed'; } catch { /* best-effort */ }
    _hook = null;
  }
}

/**
 * Arm the trigger for one mouse button.
 * token       'mmiddle' | 'mback' | 'mfwd'
 * mods        keyboard modifiers from the spec, canonical names ('Ctrl','Alt','Shift','Super')
 * clickThrough  false (default) swallows the press+release from the target app
 * onFire      called (deferred, off the hook stack) on a qualifying press
 * Returns {ok} or {ok:false, error}.
 */
function setTrigger(token, mods, clickThrough, onFire) {
  const t = TRIGGERS[token];
  if (!t) { clear(); return { ok: false, error: `unknown mouse button '${token}'` }; }
  clear();                                     // drop any previous mouse registration first
  state.down = t.down;
  state.up = t.up;
  state.xdata = t.xdata;
  state.mods = (Array.isArray(mods) ? mods : [])
    .map((m) => String(m).toLowerCase())
    .filter((m) => MOD_VKS[m] !== undefined);
  state.clickThrough = clickThrough === true;
  state.acceptInjected = TEST_INPUT;             // dev/verification hatch only
  _onFire = typeof onFire === 'function' ? onFire : null;
  _token = token;
  _ffiError = null;
  if (!ensureHook()) {
    const why = _ffiError || (macro.ffi.loadError || 'unavailable');
    clear();
    return { ok: false, error: `Mouse-button hotkeys need the Windows input bridge, which is unavailable (${why}). Pick a keyboard hotkey instead.` };
  }
  resetTransient();
  state.armed = true;
  return { ok: true };
}

/** Full teardown (app quit): unhook AND release the pinned native callback. */
function shutdown() {
  clear();
  if (_cbHandle) { macro.ffi.unregister(_cbHandle); _cbHandle = null; }
  _CallNextHookEx = _SetWindowsHookExW = _UnhookWindowsHookEx = null;
}

const active = () => !!(_hook && state.armed);
const getStats = () => ({ ...stats, armed: state.armed, installed: !!_hook, token: _token });

module.exports = { TRIGGERS, setTrigger, clear, shutdown, active, getStats, _hookStep: hookStep, _xbuttonId: xbuttonId };
