'use strict';
/* Keyboard synthesis via user32.SendInput through koffi (raw buffers — no FFI struct
   declarations needed). Also drives volume/lock keycodes and the GetAsyncKeyState guard.
   If koffi fails to load, `available` stays false and key-based actions report clearly. */
const IS_WIN = process.platform === 'win32';

let koffi = null, user32 = null;
let available = false, loadError = null;
let _SendInput = null, _GetAsyncKeyState = null;

const INPUT_KEYBOARD = 1;
const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_UNICODE = 0x0004;
const X64_INPUT_SIZE = 40; // DWORD type + pad + KEYBDINPUT{wVk,wScan,dwFlags,time} + align + ULONG_PTR extra

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
  if (/^f([1-9]|1[0-2])$/.test(t)) return 0x70 + (parseInt(t.slice(1), 10) - 1);
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

/** Press+release one virtual key. */
async function sendVk(vk) {
  needInput();
  await keyEvent(vk, 0);
  await keyEvent(vk, KEYEVENTF_KEYUP);
}

/** Chord: press left-to-right, release in reverse. tokens like ['ctrl','alt','del']. */
async function sendChord(tokens) {
  needInput();
  const vks = tokens.map(vkFor);
  for (const vk of vks) await keyEvent(vk, 0);
  for (let i = vks.length - 1; i >= 0; i--) await keyEvent(vks[i], KEYEVENTF_KEYUP);
}

/**
 * Macro runner. Syntax (same as the original engine):
 *   "ctrl+c, wait=0.2, ctrl+v"  — comma-separated steps, '+' for chords
 *   "type:hello world"          — literal typing via KEYEVENTF_UNICODE
 */
async function sendMacro(spec) {
  needInput();
  for (const rawStep of String(spec || '').split(',')) {
    const step = rawStep.trim();
    if (!step) continue;
    const wm = step.match(/^wait\s*=\s*([0-9.]+)$/i);
    if (wm) { await sleep(Math.min(5, parseFloat(wm[1]) || 0.2) * 1000); continue; }
    if (/^type:/i.test(step)) {
      for (const ch of step.slice(5)) {
        sendInputs([keyBuffer(0, ch.charCodeAt(0), KEYEVENTF_UNICODE)]);
        await sleep(8);
        sendInputs([keyBuffer(0, ch.charCodeAt(0), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)]);
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

module.exports = { available, loadError, sendMacro, sendVk, sendChord, isDown, vkFor };
