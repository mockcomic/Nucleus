'use strict';
/* Keyboard synthesis via user32.SendInput through koffi (raw buffers — no FFI struct
   declarations needed). Also drives volume/lock keycodes and the GetAsyncKeyState guard.
   If koffi fails to load, `available` stays false and key-based actions report clearly. */
const IS_WIN = process.platform === 'win32';

let koffi = null, user32 = null, kernel32 = null;
let available = false, loadError = null;
let _SendInput = null, _GetAsyncKeyState = null;

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
// sizeof(INPUT): 40 on x64/arm64, 28 on ia32 (ULONG_PTR shrinks the union).
// Electron 44 ships no ia32 Windows build, but keying the size off the arch
// keeps the FFI boundary honest if that ever changes.
const X64_INPUT_SIZE = process.arch === 'ia32' ? 28 : 40;

try {
  if (IS_WIN) {
    koffi = require('koffi');
    user32 = koffi.load('user32.dll');
    _SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, void* pInputs, int32 cbSize)');
    _GetAsyncKeyState = user32.func('int16 __stdcall GetAsyncKeyState(int vKey)');
    available = true;
  }
} catch (e) {
  available = false;
  loadError = e && e.message ? e.message : String(e);
}

/* Foreground-window probe for gaming mode (see gamemode.js). Declared in its own
   guarded block so a symbol hiccup here never takes SendInput down with it; if
   anything is missing, probeAvailable stays false and foregroundProbe() returns
   null — gaming mode then simply never pauses (fail-open, like macro.isDown). */
let probeAvailable = false;
let _GetForegroundWindow = null, _GetWindowRect = null, _GetWindowLongW = null,
    _MonitorFromWindow = null, _GetMonitorInfoW = null, _GetWindowThreadProcessId = null,
    _OpenProcess = null, _QueryFullProcessImageNameW = null, _CloseHandle = null;

const MONITOR_DEFAULTTONEAREST = 2;
const GWL_STYLE = -16;
const PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

try {
  if (available) {
    kernel32 = koffi.load('kernel32.dll');
    _GetForegroundWindow = user32.func('void* __stdcall GetForegroundWindow()');
    _GetWindowRect = user32.func('int32 __stdcall GetWindowRect(void* hWnd, void* lpRect)');
    _GetWindowLongW = user32.func('int32 __stdcall GetWindowLongW(void* hWnd, int32 nIndex)');
    _MonitorFromWindow = user32.func('void* __stdcall MonitorFromWindow(void* hWnd, uint32 flags)');
    _GetMonitorInfoW = user32.func('int32 __stdcall GetMonitorInfoW(void* hMonitor, void* lpmi)');
    _GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)');
    _OpenProcess = kernel32.func('void* __stdcall OpenProcess(uint32 dwDesiredAccess, int32 bInheritHandle, uint32 dwProcessId)');
    _QueryFullProcessImageNameW = kernel32.func('int32 __stdcall QueryFullProcessImageNameW(void* hProcess, uint32 dwFlags, void* lpExeName, void* lpdwSize)');
    _CloseHandle = kernel32.func('int32 __stdcall CloseHandle(void* hObject)');
    probeAvailable = true;
  }
} catch (e) {
  probeAvailable = false;
}

/* ---------------- COM (ole32) surface for the Core Audio module -------------
   audio.js drives the Windows Core Audio (MMDevice) interfaces through this
   same koffi instance — macro.js stays the single place koffi is loaded (see
   .dsh/skills/win32-koffi): consumers declare their own __stdcall prototypes
   through ffi.declareOle32() rather than loading DLLs themselves. Guarded like
   every other block here: a broken load flips comAvailable false and the
   audio features degrade to a clean user-facing error, never a crash.
   COM vtable arithmetic assumes 8-byte pointers, so ia32 is excluded (the
   Electron build ships x64 only; the guard keeps the FFI boundary honest). */
let ole32 = null, comAvailable = false, comLoadError = null;
try {
  if (available && process.arch !== 'ia32') {
    ole32 = koffi.load('ole32.dll');
    comAvailable = true;
  } else if (available) {
    comLoadError = '32-bit process: COM vtable layout unsupported here';
  }
} catch (e) {
  comAvailable = false;
  comLoadError = e && e.message ? e.message : String(e);
}

const readRect = (b, off) => [b.readInt32LE(off), b.readInt32LE(off + 4), b.readInt32LE(off + 8), b.readInt32LE(off + 12)];

/** Lowercase exe basename of a process id ('' when unreadable). Shared by the
 *  foreground probe and the window-focus enumeration. */
function readExeBase(pid) {
  try {
    const h = _OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
    if (!h) return '';
    try {
      const nameBuf = Buffer.alloc(1024);          // 512 WCHARs
      const sizeBuf = Buffer.alloc(4);
      sizeBuf.writeUInt32LE(512, 0);               // in/out, in characters
      if (_QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf)) {
        const n = sizeBuf.readUInt32LE(0);
        const full = nameBuf.toString('utf16le', 0, Math.max(0, n) * 2);
        const slash = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
        return (slash >= 0 ? full.slice(slash + 1) : full).toLowerCase();
      }
      return '';
    } finally {
      try { _CloseHandle(h); } catch { /* best-effort */ }
    }
  } catch {
    return '';
  }
}

/**
 * Snapshot of the foreground window for gaming-mode detection.
 * Returns { pid, exe, winRect, monRect, style } — exe is the lowercase process
 * basename ('' when unreadable), winRect/monRect are [l,t,r,b] — or null
 * whenever the probe is unavailable or any Win32 call fails (fail-open).
 */
function foregroundProbe() {
  if (!probeAvailable) return null;
  try {
    const hwnd = _GetForegroundWindow();
    if (!hwnd) return null;

    const rectBuf = Buffer.alloc(16);
    if (!_GetWindowRect(hwnd, rectBuf)) return null;
    const winRect = readRect(rectBuf, 0);

    const hmon = _MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
    if (!hmon) return null;
    const mi = Buffer.alloc(40);
    mi.writeUInt32LE(40, 0); // MONITORINFO.cbSize
    if (!_GetMonitorInfoW(hmon, mi)) return null;
    const monRect = readRect(mi, 4); // rcMonitor (offset 4, after cbSize)

    const style = _GetWindowLongW(hwnd, GWL_STYLE) >>> 0;

    const pidBuf = Buffer.alloc(4);
    _GetWindowThreadProcessId(hwnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);

    const exe = pid ? readExeBase(pid) : '';
    return { pid, exe, winRect, monRect, style };
  } catch {
    return null;
  }
}

/* ---------------- focus-existing-app (EnumWindows surface) ------------------
   Used by actions.js when behavior.focusExistingApp is on: raise the running
   program's window instead of spawning a duplicate. Same fail-soft discipline
   as every other block here: no koffi, non-win32, a failed declaration, or any
   Win32 throw makes focusAppWindowByExe answer false — the caller then simply
   launches the app as it always did. The EnumWindows callback runs synchronously
   on the calling thread inside EnumWindows, so the scratch state below cannot
   interleave between two focus attempts. */
let focusAvailable = false;
let _EnumWindows = null, _IsWindowVisible = null, _IsIconic = null, _GetWindowTextLengthW = null,
    _ShowWindow = null, _SetForegroundWindow = null, _BringWindowToTop = null,
    _AttachThreadInput = null, _GetCurrentThreadId = null;
let _focusCbHandle = null;         // pinned EnumWindows proc; registered once, reused forever
let _focusWant = null;             // basename sought by the current enumeration
let _focusHits = [];               // candidate windows the proc accepted
let _focusPidExe = null;           // pid -> exe basename memo, live only during one enumeration

const SW_RESTORE = 9;
const WS_CHILD_STYLE = 0x40000000;

try {
  if (available) {
    _EnumWindows = user32.func('int32 __stdcall EnumWindows(void* lpEnumFunc, intptr_t lParam)');
    _IsWindowVisible = user32.func('int32 __stdcall IsWindowVisible(void* hWnd)');
    _IsIconic = user32.func('int32 __stdcall IsIconic(void* hWnd)');
    _GetWindowTextLengthW = user32.func('int32 __stdcall GetWindowTextLengthW(void* hWnd)');
    _ShowWindow = user32.func('int32 __stdcall ShowWindow(void* hWnd, int32 nCmdShow)');
    _SetForegroundWindow = user32.func('int32 __stdcall SetForegroundWindow(void* hWnd)');
    _BringWindowToTop = user32.func('int32 __stdcall BringWindowToTop(void* hWnd)');
    _AttachThreadInput = user32.func('int32 __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int32 fAttach)');
    _GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()');
    focusAvailable = true;
  }
} catch {
  focusAvailable = false;
}

/* One window per EnumWindows callback: keep everything permissive — a window
   that cannot be inspected is skipped, never fatal, and the proc always says
   "continue". Runs on the caller's stack inside _EnumWindows. */
function focusEnumProc(hWnd, lParam) {
  try {
    if (!hWnd || !_IsWindowVisible(hWnd)) return 1;
    if (!_GetWindowTextLengthW(hWnd)) return 1;                 // untitled: tool windows, hidden parents
    if ((_GetWindowLongW(hWnd, GWL_STYLE) >>> 0) & WS_CHILD_STYLE) return 1;
    const rectBuf = Buffer.alloc(16);
    if (_GetWindowRect(hWnd, rectBuf)) {
      const [l, t, r, b] = readRect(rectBuf, 0);
      if (r - l <= 0 || b - t <= 0) return 1;                   // zero-size: never focusable in practice
    }
    const pidBuf = Buffer.alloc(4);
    _GetWindowThreadProcessId(hWnd, pidBuf);
    const pid = pidBuf.readUInt32LE(0);
    if (!pid || pid === process.pid) return 1;                  // never raise our own overlay/settings
    let base = _focusPidExe.get(pid);
    if (base === undefined) { base = readExeBase(pid); _focusPidExe.set(pid, base); }
    if (base && base === _focusWant) _focusHits.push({ hWnd, iconic: !!_IsIconic(hWnd) });
  } catch { /* skip this window on any FFI hiccup */ }
  return 1;
}

/**
 * Raise the existing top-level window of a running program.
 * exeBase — lowercase exe basename ('notepad.exe'); anything else answers
 * false without touching FFI. Returns true only when a window of that program
 * was found and a foreground request was accepted; false (windowless tray
 * app, program not running, focus refused, FFI absent) means the caller must
 * launch normally — the honest fallback, never a silently eaten action.
 */
function focusAppWindowByExe(exeBase) {
  if (!focusAvailable) return false;
  const want = String(exeBase || '').toLowerCase();
  if (!/^[^\s\\/]+\.exe$/.test(want)) return false;             // basename only; junk never reaches FFI
  _focusWant = want; _focusHits = []; _focusPidExe = new Map();
  try {
    if (!_focusCbHandle) {
      const proto = koffi.proto('int32 __stdcall RwFocusEnumProc(void* hWnd, intptr_t lParam)');
      _focusCbHandle = koffi.register(focusEnumProc, koffi.pointer(proto));   // pinned for the process lifetime
    }
    _EnumWindows(_focusCbHandle, 0);
    const hits = _focusHits;
    if (!hits.length) return false;
    // Prefer an already-shown window; otherwise restore the first minimized one.
    const pick = hits.find((h) => !h.iconic) || hits[0];
    if (pick.iconic) _ShowWindow(pick.hWnd, SW_RESTORE);
    if (_SetForegroundWindow(pick.hWnd)) return true;
    // Foreground-lock refusal: retry once with our input queue attached to the
    // current foreground thread (the classic AttachThreadInput trick), detach
    // in finally so a mid-retry throw can never leave the queues attached.
    const fgHwnd = _GetForegroundWindow();
    if (!fgHwnd) return false;
    const pidBuf = Buffer.alloc(4);
    const fgThread = _GetWindowThreadProcessId(fgHwnd, pidBuf);
    if (!fgThread) return false;
    let attached = false;
    try {
      attached = !!_AttachThreadInput(fgThread, _GetCurrentThreadId(), 1);
      _BringWindowToTop(pick.hWnd);
      return !!_SetForegroundWindow(pick.hWnd);
    } finally {
      if (attached) { try { _AttachThreadInput(fgThread, _GetCurrentThreadId(), 0); } catch { /* best-effort */ } }
    }
  } catch {
    return false;
  } finally {
    _focusWant = null; _focusHits = []; _focusPidExe = null;
  }
}

/* ---------------- registry probes (advapi32, read-only) ---------------------
   Read-only peek at a single HKCU Run value so the login-item disable path can
   verify OWNERSHIP before deleting (see autostart.js): Electron's
   setLoginItemSettings({openAtLogin:false}) deletes the Run value by NAME,
   ignoring `path`, and every copy of this app shares the 'local.radialwheel'
   name — so a portable/dev launch must never reach that delete without first
   seeing the stored command line. Deliberately read-only: writes/deletes stay
   with Electron's API.

   Fail-soft like everything else here: no koffi, non-win32, or ia32 (we cannot
   marshal a pointer-sized HKEY safely there) leaves regProbeAvailable false and
   every probe answers {state:'error'} — UNKNOWN, which callers must treat as
   "do not delete", never as "absent". */
let _RegGetValueW = null;
let regProbeAvailable = false;
const HKEY_CURRENT_USER = 0x80000001;
const RUN_KEY = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RRF_RT_REG_SZ = 0x00000002;
const ERROR_SUCCESS = 0, ERROR_FILE_NOT_FOUND = 2, ERROR_PATH_NOT_FOUND = 3;

try {
  if (available && process.arch !== 'ia32') {
    const advapi32 = koffi.load('advapi32.dll');
    _RegGetValueW = advapi32.func('int32 __stdcall RegGetValueW(uint64 hkey, str16 subKey, str16 value, uint32 dwFlags, void* pdwType, void* pvData, void* pcbData)');
    regProbeAvailable = true;
  }
} catch {
  _RegGetValueW = null;
  regProbeAvailable = false;
}

/** Read one REG_SZ under HKCU\Software\Microsoft\Windows\CurrentVersion\Run.
 *  Returns {state:'value', data} | {state:'absent'} (key/value genuinely
 *  missing) | {state:'error', code} (could not look — UNKNOWN, not absent). */
function readRunValue(valueName) {
  if (!regProbeAvailable || typeof valueName !== 'string' || !valueName) return { state: 'error', code: 'unavailable' };
  try {
    const sizeBuf = Buffer.alloc(4);
    let r = _RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, valueName, RRF_RT_REG_SZ, null, null, sizeBuf);
    if (r === ERROR_FILE_NOT_FOUND || r === ERROR_PATH_NOT_FOUND) return { state: 'absent' };
    if (r !== ERROR_SUCCESS) return { state: 'error', code: r };
    const cb = sizeBuf.readUInt32LE(0);
    if (cb <= 0 || cb > 8192) return { state: 'error', code: 'size' };   // sane cap for a Run command line
    const data = Buffer.alloc(cb + 2);                                    // slack for a NUL terminator
    sizeBuf.writeUInt32LE(cb + 2, 0);
    r = _RegGetValueW(HKEY_CURRENT_USER, RUN_KEY, valueName, RRF_RT_REG_SZ, null, data, sizeBuf);
    if (r !== ERROR_SUCCESS) return { state: 'error', code: r };
    const bytes = Math.min(sizeBuf.readUInt32LE(0), cb + 2) & ~1;         // whole UTF-16 units
    return { state: 'value', data: data.toString('utf16le', 0, bytes).replace(/\0+$/, '') };
  } catch (e) {
    return { state: 'error', code: (e && e.message) || 'throw' };
  }
}

const MOD_VK = { ctrl: 0x11, control: 0x11, alt: 0x12, option: 0x12, shift: 0x10, win: 0x5B, super: 0x5B, cmd: 0x5B, command: 0x5B };
const NAME_VK = {
  space: 0x20, enter: 0x0D, return: 0x0D, tab: 0x09, esc: 0x1B, escape: 0x1B,
  backspace: 0x08, delete: 0x2E, del: 0x2E, insert: 0x2D, ins: 0x2D,
  home: 0x24, end: 0x23, pgup: 0x21, pageup: 0x21, pgdn: 0x22, pagedown: 0x22,
  left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  volume_mute: 0xAD, mute: 0xAD, volume_down: 0xAE, volldn: 0xAE, volume_up: 0xAF, vollup: 0xAF,
  playpause: 0xB3, next: 0xB0, prev: 0xB1, stop: 0xB2,
  comma: 0xBC, period: 0xBE, minus: 0xBD, equal: 0xBB, slash: 0xBF, backslash: 0xDC,
  semicolon: 0xBA, quote: 0xDE, backtick: 0xC0, printscreen: 0x2C
};
const CHAR_VK = { '-': 0xBD, '=': 0xBB, '[': 0xDB, ']': 0xDD, '\\': 0xDC, ';': 0xBA, "'": 0xDE, ',': 0xBC, '.': 0xBE, '/': 0xBF, '`': 0xC0 };

function vkFor(token) {
  const t = String(token).trim().toLowerCase();
  if (MOD_VK[t] !== undefined) return MOD_VK[t];
  if (NAME_VK[t] !== undefined) return NAME_VK[t];
  if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) return 0x70 + (parseInt(t.slice(1), 10) - 1); // F1-F24 (0x70-0x87), same range hotkeys.js accepts
  if (t.length === 1) {
    const c = t.toUpperCase();
    if (/^[A-Z0-9]$/.test(c)) return c.charCodeAt(0);
    if (CHAR_VK[t] !== undefined) return CHAR_VK[t];
    throw new Error(`cannot synthesize key '${t}'`);
  }
  throw new Error(`unknown key '${t}'`);
}

function needInput() {
  if (!available) throw new Error('keyboard synthesis unavailable — ' + (loadError || 'not on Windows'));
}

function keyBuffer(vk, scan, flags) {
  const b = Buffer.alloc(X64_INPUT_SIZE);
  b.writeUInt32LE(INPUT_KEYBOARD, 0);
  b.writeUInt16LE(vk, 8);
  b.writeUInt16LE(scan, 10);
  b.writeUInt32LE(flags, 12);
  return b;
}

function sendInputs(buffers) {
  const n = buffers.length;
  const buf = Buffer.concat(buffers);
  const r = _SendInput(n, buf, X64_INPUT_SIZE);
  if (r !== n) throw new Error(`SendInput accepted ${r}/${n} events`);
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function keyEvent(vk, flags, scan = 0) {
  sendInputs([keyBuffer(vk, scan, flags)]);
  await sleep(KEY_PACE_MS);
}

/** Press+release one virtual key. The release is attempted whenever the press
 *  actually reached the OS (a keyup for an unpressed VK is a harmless no-op). */
async function sendVk(vk) {
  needInput();
  let down = false;
  try {
    await keyEvent(vk, 0);
    down = true;
  } finally {
    if (down) { try { await keyEvent(vk, KEYEVENTF_KEYUP); } catch { /* best effort */ } }
  }
}

/** Chord: press left-to-right, release in reverse. tokens like ['ctrl','alt','del'].
 *  The release pass runs in `finally`: a mid-chord SendInput failure (0/n,
 *  low-level hook, desktop switch) must never leave Ctrl/Alt/Win stuck down
 *  system-wide. vkFor() throws during mapping, BEFORE anything is injected. */
async function sendChord(tokens) {
  needInput();
  const vks = tokens.map(vkFor);
  const pressed = [];
  try {
    for (const vk of vks) { await keyEvent(vk, 0); pressed.push(vk); }
  } finally {
    for (let i = pressed.length - 1; i >= 0; i--) {
      try { await keyEvent(pressed[i], KEYEVENTF_KEYUP); } catch { /* best effort release */ }
    }
  }
}

/**
 * Macro runner. Syntax (same as the original engine):
 *   "ctrl+c, wait=0.2, ctrl+v"  — comma-separated steps, '+' for chords
 *   "type:hello world"          — literal typing via KEYEVENTF_UNICODE.
 *     A `type:` step CONSUMES THE REST OF THE SPEC verbatim, commas included
 *     (there is no unambiguous way to end literal text mid-string, so type:
 *     steps must come last). Naively splitting on ',' would corrupt this:
 *     `"type:a,b"` used to type "a" and then INJECT a stray B keypress.
 */
function splitSteps(text) {
  const first = /(^|,)\s*(type:)/i.exec(text);
  if (!first) return text.split(',');
  const afterComma = first.index + first[1].length;
  const lead = /^\s*/.exec(text.slice(afterComma));
  const typeStart = afterComma + lead[0].length;
  const before = text.slice(0, first.index);
  return (before ? before.split(',') : []).concat(text.slice(typeStart));
}

/* Hard bounds so NO caller — not even a compromised renderer driving
   action:preview — can push an unbounded workload into SendInput. The spec
   cap mirrors config.js's slice(0, 2048) on item.value, so a legitimately
   saved macro can never exceed it; typed text and chord tokens are substrings
   of the spec, so the spec cap bounds them too. The per-step wait clamp
   (Math.min(5, …)) stays; this adds a TOTAL wait budget. */
const MACRO_MAX_SPEC = 2048;
const MACRO_MAX_STEPS = 128;
const MACRO_MAX_TOTAL_WAIT_MS = 15000;
/* New-step bounds. A `hold=` can't out-run a `wait=` (same 5 s ceiling), and
   `repeat=` is the one construct that multiplies work, so it gets its own cap
   and its cost is charged against the SAME total budget below. */
const MACRO_MAX_REPEAT = 20;
const MACRO_MAX_HOLD_MS = 5000;
const MACRO_MIN_HOLD_MS = 50;
const MACRO_DEFAULT_HOLD_MS = 500;
const MACRO_MAX_SCROLL_NOTCHES = 25;
/* Pacing (see .dsh/skills/win32-koffi): fast target apps drop events when
   injected input arrives too quickly. */
const KEY_PACE_MS = 12;
const TYPE_PACE_MS = 8;
const CHORD_TAIL_MS = 20;
const MOUSE_PACE_MS = 12;
const DBLCLICK_GAP_MS = 40;

/* ------------------------------ step grammar -------------------------------
   Comma-separated steps; '+' joins a chord. Keyboard form is unchanged —
   everything below is additive, and an unrecognised step still falls through to
   the chord path so vkFor() reports unknown key names exactly as before.

     ctrl+c                    chord (or a lone key)
     wait=0.2                  pause, clamped to 5 s
     type:hello world          literal text; must be last (consumes the rest)
     click | rclick | mclick   mouse button at the CURRENT cursor position
     dblclick                  left down-up-down-up
     back | forward            XBUTTON1 / XBUTTON2 (browser back / forward)
     scroll=3                  wheel notches: positive = down, negative = up
     hold=ctrl+c=1.5           press, hold, release in reverse (secs optional)
     repeat=3:ctrl+v           run one step N times (no nesting, no wait/type)

   parseStep is SHAPE-only: it never resolves key names (that stays with vkFor at
   execution time, so _validateSpec keeps its bounds-only contract with
   tests/unit/macro-bounds.test.js) and it never injects anything. */
const MOUSE_BUTTON_STEPS = {
  click: 'left', lclick: 'left', leftclick: 'left',
  rclick: 'right', rightclick: 'right',
  mclick: 'middle', middleclick: 'middle',
  back: 'x1', backclick: 'x1', xbutton1: 'x1',
  forward: 'x2', fwdclick: 'x2', xbutton2: 'x2'
};
const DBLCLICK_STEPS = new Set(['dblclick', 'doubleclick']);

const secsToMs = (v, dflt) => {
  const secs = parseFloat(v);
  const ms = Number.isNaN(secs) ? dflt : Math.max(0, secs) * 1000;
  return Math.min(5000, ms);            // the historical `wait=` ceiling
};

/** Shape-classify one step. Throws a user-readable Error on a malformed NEW
 *  form (junk `scroll=` / `hold=` / `repeat=`); anything else is a chord. */
function parseStep(raw) {
  const step = String(raw || '').trim();
  if (!step) return null;

  const wm = step.match(/^wait\s*=\s*([0-9.]+)$/i);
  if (wm) return { kind: 'wait', ms: secsToMs(wm[1], 200) };

  if (/^type:/i.test(step)) return { kind: 'type', text: step.slice(5) };

  const sm = step.match(/^(?:scroll|wheel)\s*=\s*(-?[0-9.]+)$/i);
  if (sm) {
    const n = Math.round(parseFloat(sm[1]));
    if (!Number.isFinite(n)) throw new Error(`macro: '${step}' needs a whole number of notches, e.g. scroll=3 or scroll=-2`);
    if (Math.abs(n) > MACRO_MAX_SCROLL_NOTCHES) throw new Error(`macro: scroll may not exceed ${MACRO_MAX_SCROLL_NOTCHES} notches (${step})`);
    return { kind: 'scroll', notches: n };
  }
  if (/^(?:scroll|wheel)$/i.test(step)) return { kind: 'scroll', notches: 1 };

  const hm = step.match(/^hold\s*=\s*(.+?)(?:\s*=\s*([0-9.]+))?$/i);
  if (hm) {
    const keys = hm[1].trim();
    if (!keys || keys.includes(',') || keys.includes('=')) {
      throw new Error(`macro: '${step}' is malformed — use hold=<key or a+b chord>[=seconds], e.g. hold=f15=1.5`);
    }
    let ms = hm[2] === undefined ? MACRO_DEFAULT_HOLD_MS : secsToMs(hm[2], MACRO_DEFAULT_HOLD_MS);
    ms = Math.max(MACRO_MIN_HOLD_MS, Math.min(MACRO_MAX_HOLD_MS, ms));
    return { kind: 'hold', tokens: keys.split('+').map((t) => t.trim()).filter(Boolean), ms };
  }

  const rm = step.match(/^repeat\s*=\s*([0-9]+)\s*:\s*(.+)$/i);
  if (rm) {
    const n = parseInt(rm[1], 10);
    if (!Number.isFinite(n) || n < 1) throw new Error(`macro: '${step}' needs a repeat count of 1 or more`);
    if (n > MACRO_MAX_REPEAT) throw new Error(`macro: repeat may not exceed ${MACRO_MAX_REPEAT} (${step})`);
    const inner = parseStep(rm[2]);
    if (!inner) throw new Error(`macro: '${step}' has nothing to repeat`);
    if (inner.kind === 'repeat') throw new Error(`macro: repeat cannot wrap another repeat (${step})`);
    if (inner.kind === 'wait') throw new Error(`macro: repeat cannot wrap wait= — put the wait as its own step (${step})`);
    if (inner.kind === 'type') throw new Error(`macro: repeat cannot wrap type: — typed text already ends the macro (${step})`);
    return { kind: 'repeat', n, inner };
  }

  if (DBLCLICK_STEPS.has(step.toLowerCase())) return { kind: 'mouse', button: 'left', double: true };
  const mb = MOUSE_BUTTON_STEPS[step.toLowerCase()];
  if (mb) return { kind: 'mouse', button: mb, double: false };

  /* A step that LOOKS like one of the new forms but didn't parse must say so —
     falling through to the chord path would report the misleading
     "cannot synthesize key 'scroll=abc'" instead of the real mistake. */
  if (/^(?:scroll|wheel)\s*[=:]/i.test(step)) throw new Error(`macro: '${step}' needs a whole number of wheel notches, e.g. scroll=3 or scroll=-2`);
  if (/^hold\s*[=:]/i.test(step)) throw new Error(`macro: '${step}' is malformed — use hold=<key or a+b chord>[=seconds], e.g. hold=f15=1.5`);
  if (/^repeat\s*[=:]/i.test(step)) throw new Error(`macro: '${step}' is malformed — use repeat=<1-${MACRO_MAX_REPEAT}>:<step>, e.g. repeat=3:ctrl+v`);

  return { kind: 'chord', tokens: step.split('+') };
}

/* Conservative wall-clock cost of a parsed step, used ONLY to budget-check a
   spec before a single event is injected. Estimates the pacing the runner will
   actually apply (see sendChord/sendMacro), so an elaborate macro can never
   hold the resident process in a 15 s-plus injection queue. */
function stepCostMs(st) {
  switch (st.kind) {
    case 'wait': case 'hold': return st.ms;
    case 'repeat': return st.n * stepCostMs(st.inner);
    case 'chord': return st.tokens.length * 2 * KEY_PACE_MS + CHORD_TAIL_MS;
    case 'mouse': return (st.double ? 4 : 2) * MOUSE_PACE_MS;
    case 'scroll': return MOUSE_PACE_MS;
    default: return 0;                       // type: is bounded by MACRO_MAX_SPEC
  }
}

/* ------------------------- mouse injection (MOUSEINPUT) --------------------
   INPUT layout on x64 (40 bytes, see X64_INPUT_SIZE): DWORD type @0, then the
   union @8 — MOUSEINPUT is dx i32 @8, dy i32 @12, mouseData u32 @16, dwFlags
   u32 @20, time u32 @24, dwExtraInfo uptr @32. dx/dy stay 0 and MOUSEEVENTF_
   ABSOLUTE is never set, so every click lands under the CURRENT cursor — the
   wheel is already hidden by then (ipc.js), which means the target is whatever
   sat beneath it. That is the same contract every other macro recorder has.
   Our own WH_MOUSE_LL hook ignores injected events (mousehook.js hookStep →
   LLMHF_INJECTED), so a synthesized click can never summon the wheel. */
const INPUT_MOUSE = 0;
const ME_LEFTDOWN = 0x0002, ME_LEFTUP = 0x0004;
const ME_RIGHTDOWN = 0x0008, ME_RIGHTUP = 0x0010;
const ME_MIDDLEDOWN = 0x0020, ME_MIDDLEUP = 0x0040;
const ME_XDOWN = 0x0080, ME_XUP = 0x0100;
const ME_WHEEL = 0x0800;
const WHEEL_DELTA = 120;
const XBUTTON1 = 1, XBUTTON2 = 2;
const BUTTON_FLAGS = {
  left: [ME_LEFTDOWN, ME_LEFTUP],
  right: [ME_RIGHTDOWN, ME_RIGHTUP],
  middle: [ME_MIDDLEDOWN, ME_MIDDLEUP],
  x1: [ME_XDOWN, ME_XUP],
  x2: [ME_XDOWN, ME_XUP]
};

function mouseBuffer(flags, mouseData = 0) {
  const b = Buffer.alloc(X64_INPUT_SIZE);
  b.writeUInt32LE(INPUT_MOUSE, 0);
  b.writeUInt32LE(mouseData >>> 0, 16);
  b.writeUInt32LE(flags >>> 0, 20);
  return b;
}

async function mouseEvent(flags, mouseData = 0) {
  sendInputs([mouseBuffer(flags, mouseData)]);
  await sleep(MOUSE_PACE_MS);
}

/** One button press+release. Mirrors sendVk's rule: the up event is attempted
 *  whenever the down event actually reached the OS, and a button whose press
 *  failed is never "released" (an orphan up would click for the user). */
async function sendMouseClick(button) {
  const [down, up] = BUTTON_FLAGS[button] || BUTTON_FLAGS.left;
  const data = button === 'x1' ? XBUTTON1 : button === 'x2' ? XBUTTON2 : 0;
  let pressed = false;
  try {
    await mouseEvent(down, data);
    pressed = true;
  } finally {
    if (pressed) { try { await mouseEvent(up, data); } catch { /* best effort */ } }
  }
}

/** Wheel notches in ONE event: Win32 wants the delta in mouseData, so 3
 *  notches is a single 360-unit event, not three 120-unit ones. Positive
 *  `scroll=` means DOWN, and a forward-rotating wheel carries a NEGATIVE
 *  mouseData — hence the negation. */
async function sendMouseScroll(notches) {
  if (!notches) return;
  await mouseEvent(ME_WHEEL, -(notches * WHEEL_DELTA));
}

/**
 * Parse a spec into executable steps, enforcing every bound BEFORE anything is
 * injected (this is the whole precondition of sendMacro, and the reason a
 * compromised renderer driving action:preview can queue work but never an
 * unbounded amount of it). Pure: no FFI, no fs. Throws a user-readable Error.
 */
function parseSpec(spec) {
  const s = String(spec || '').trim();
  if (s.length > MACRO_MAX_SPEC) throw new Error(`macro too long (${s.length} chars; max ${MACRO_MAX_SPEC})`);
  const raw = splitSteps(s).filter((x) => String(x || '').trim());
  if (raw.length > MACRO_MAX_STEPS) throw new Error(`macro has too many steps (${raw.length}; max ${MACRO_MAX_STEPS})`);
  const steps = raw.map(parseStep).filter(Boolean);
  let budget = MACRO_MAX_TOTAL_WAIT_MS;
  for (const st of steps) {
    budget -= stepCostMs(st);
    if (budget < 0) {
      // Message wording is pinned by tests/unit/macro-bounds.test.js.
      throw new Error(`macro waits exceed ${Math.floor(MACRO_MAX_TOTAL_WAIT_MS / 1000)}s in total (waits, holds and repeats all count)`);
    }
  }
  return steps;
}

/* Back-compat pure precondition (tests + sys.js callers). */
function validateSpec(spec) { parseSpec(spec); }

/** Hold a chord down: map every token FIRST (vkFor throws before injecting),
 *  then press left-to-right, hold, and release in reverse in a `finally` — the
 *  same never-stuck-keys discipline as sendChord. */
async function sendHold(tokens, ms) {
  const vks = tokens.map(vkFor);
  const pressed = [];
  try {
    for (const vk of vks) { await keyEvent(vk, 0); pressed.push(vk); }
    await sleep(ms);
  } finally {
    for (let i = pressed.length - 1; i >= 0; i--) {
      try { await keyEvent(pressed[i], KEYEVENTF_KEYUP); } catch { /* best effort release */ }
    }
  }
}

async function runStep(st) {
  switch (st.kind) {
    case 'wait':
      // wait=0 means "no pause" — the old `|| 0.2` turned it into 200 ms.
      await sleep(st.ms);
      return;
    case 'type':
      // Iterate UTF-16 CODE UNITS, not code points: KEYEVENTF_UNICODE takes
      // one word per event, so a surrogate pair needs both halves (for…of +
      // charCodeAt(0) used to send only the lone high surrogate).
      for (let ci = 0; ci < st.text.length; ci++) {
        const u = st.text.charCodeAt(ci);
        sendInputs([keyBuffer(0, u, KEYEVENTF_UNICODE)]);
        await sleep(TYPE_PACE_MS);
        sendInputs([keyBuffer(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
        await sleep(TYPE_PACE_MS);
      }
      return;
    case 'chord':
      await sendChord(st.tokens);
      await sleep(CHORD_TAIL_MS);
      return;
    case 'hold':
      needInput();
      await sendHold(st.tokens, st.ms);
      return;
    case 'mouse':
      needInput();
      await sendMouseClick(st.button);
      if (st.double) { await sleep(DBLCLICK_GAP_MS); await sendMouseClick('left'); }
      return;
    case 'scroll':
      needInput();
      await sendMouseScroll(st.notches);
      return;
    case 'repeat':
      for (let i = 0; i < st.n; i++) await runStep(st.inner);
      return;
    default:
      throw new Error(`macro: unsupported step '${st.kind}'`);
  }
}

async function sendMacro(spec) {
  // Bounds and shapes BEFORE anything else (and before needInput, so a limits
  // error wins even where the FFI is absent).
  const steps = parseSpec(spec);
  needInput();
  for (const st of steps) await runStep(st);
}

function isDown(vk) {
  if (!available) return true; // can't check — let it through
  return (_GetAsyncKeyState(vk) & 0x8000) !== 0;
}

/* ---------------- global FFI surface for other main-process modules -------
   macro.js stays the single place koffi is loaded (see .dsh/skills/win32-koffi):
   one guarded load, one failure mode. Consumers (mousehook.js) declare their own
   __stdcall prototypes through these thin passthroughs rather than requiring
   koffi themselves, so a broken install degrades identically everywhere:
   `available` false plus a human `loadError`, and every call throwing through
   needInput() instead of crashing at require-time. */
const ffi = {
  get available() { return available; },
  get loadError() { return loadError; },
  /** True when ole32.dll loaded and the 8-byte-pointer COM assumptions hold. */
  get comAvailable() { return comAvailable; },
  get comLoadError() { return comLoadError; },
  /** Declare a user32 symbol. The '__stdcall' convention is MANDATORY in spec. */
  declareUser32(spec) { needInput(); return user32.func(spec); },
  /** Declare an ole32 symbol (CoCreateInstance & friends). Same convention rule. */
  declareOle32(spec) {
    if (!comAvailable) throw new Error(comLoadError || 'ole32 unavailable');
    return ole32.func(spec);
  },
  /** Declare a callback signature, e.g. 'int64 __stdcall Name(int, uintptr, intptr)'. */
  proto(spec) { needInput(); return koffi.proto(spec); },
  /** Function-pointer type for a declared proto (what SetWindowsHookEx expects). */
  pointer(type) { needInput(); return koffi.pointer(type); },
  /** Pin a JS function as a native callback; the caller keeps the handle alive. */
  register(fn, type) { needInput(); return koffi.register(fn, type); },
  unregister(handle) { try { if (handle) koffi.unregister(handle); } catch { /* best-effort */ } },
  /** Read one field from a native struct addressed by an LPARAM-style address. */
  decode(addr, offset, type) { needInput(); return koffi.decode(addr, offset, type); },
  /** Read a whole value at an address (no offset) — the form koffi's function-
      pointer decoding requires: decode(fnPtr, proto) → callable. */
  decodeType(addr, type) { needInput(); return koffi.decode(addr, type); },
  /** Reinterpret a Buffer's first bytes as a value of the given type — the
      way to recover a `void*` an out-parameter wrote into a scratch Buffer. */
  as(buf, type) { needInput(); return koffi.as(buf, type); }
};

/* _splitSteps / _parseStep / _stepCostMs / _parseSpec are exported purely for
   node:test: all four are pure (no FFI, no fs) and cover the whole step
   grammar, so the SendInput paths never need to run in a unit test. */
module.exports = { available, loadError, probeAvailable, foregroundProbe, focusAppWindowByExe, focusAvailable, readExeBase, sendMacro, sendVk, sendChord, isDown, vkFor, _splitSteps: splitSteps, _validateSpec: validateSpec, _parseStep: parseStep, _stepCostMs: stepCostMs, _parseSpec: parseSpec, _mouseBuffer: mouseBuffer, readRunValue, regProbeAvailable, ffi, MACRO_MAX_SPEC, MACRO_MAX_STEPS, MACRO_MAX_TOTAL_WAIT_MS, MACRO_MAX_REPEAT, MACRO_MAX_HOLD_MS, MACRO_MIN_HOLD_MS, MACRO_DEFAULT_HOLD_MS, MACRO_MAX_SCROLL_NOTCHES };
