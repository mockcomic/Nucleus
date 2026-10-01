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

const readRect = (b, off) => [b.readInt32LE(off), b.readInt32LE(off + 4), b.readInt32LE(off + 8), b.readInt32LE(off + 12)];

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

    let exe = '';
    if (pid) {
      const h = _OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
      if (h) {
        try {
          const nameBuf = Buffer.alloc(1024);          // 512 WCHARs
          const sizeBuf = Buffer.alloc(4);
          sizeBuf.writeUInt32LE(512, 0);               // in/out, in characters
          if (_QueryFullProcessImageNameW(h, 0, nameBuf, sizeBuf)) {
            const n = sizeBuf.readUInt32LE(0);
            const full = nameBuf.toString('utf16le', 0, Math.max(0, n) * 2);
            const slash = Math.max(full.lastIndexOf('\\'), full.lastIndexOf('/'));
            exe = (slash >= 0 ? full.slice(slash + 1) : full).toLowerCase();
          }
        } finally {
          _CloseHandle(h);
        }
      }
    }
    return { pid, exe, winRect, monRect, style };
  } catch {
    return null;
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
  await sleep(12);
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

async function sendMacro(spec) {
  needInput();
  for (const rawStep of splitSteps(String(spec || '').trim())) {
    const step = rawStep.trim();
    if (!step) continue;
    const wm = step.match(/^wait\s*=\s*([0-9.]+)$/i);
    if (wm) {
      const secs = parseFloat(wm[1]);
      // wait=0 means "no pause" — the old `|| 0.2` turned it into 200 ms.
      await sleep(Math.min(5, Number.isNaN(secs) ? 0.2 : Math.max(0, secs)) * 1000);
      continue;
    }
    if (/^type:/i.test(step)) {
      const text = step.slice(5);
      // Iterate UTF-16 CODE UNITS, not code points: KEYEVENTF_UNICODE takes
      // one word per event, so a surrogate pair needs both halves (for…of +
      // charCodeAt(0) used to send only the lone high surrogate).
      for (let ci = 0; ci < text.length; ci++) {
        const u = text.charCodeAt(ci);
        sendInputs([keyBuffer(0, u, KEYEVENTF_UNICODE)]);
        await sleep(8);
        sendInputs([keyBuffer(0, u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
        await sleep(8);
      }
      continue;
    }
    await sendChord(step.split('+'));
    await sleep(20);
  }
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
  /** Declare a user32 symbol. The '__stdcall' convention is MANDATORY in spec. */
  declareUser32(spec) { needInput(); return user32.func(spec); },
  /** Declare a callback signature, e.g. 'int64 __stdcall Name(int, uintptr, intptr)'. */
  proto(spec) { needInput(); return koffi.proto(spec); },
  /** Function-pointer type for a declared proto (what SetWindowsHookEx expects). */
  pointer(type) { needInput(); return koffi.pointer(type); },
  /** Pin a JS function as a native callback; the caller keeps the handle alive. */
  register(fn, type) { needInput(); return koffi.register(fn, type); },
  unregister(handle) { try { if (handle) koffi.unregister(handle); } catch { /* best-effort */ } },
  /** Read one field from a native struct addressed by an LPARAM-style address. */
  decode(addr, offset, type) { needInput(); return koffi.decode(addr, offset, type); }
};

// _splitSteps is exported purely for node:test (pure function, no FFI needed).
module.exports = { available, loadError, probeAvailable, foregroundProbe, sendMacro, sendVk, sendChord, isDown, vkFor, _splitSteps: splitSteps, ffi };
