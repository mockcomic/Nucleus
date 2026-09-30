'use strict';
/* Global hotkey management: parse user specs, register via globalShortcut,
   guard the Ctrl+Alt auto-repeat quirk with GetAsyncKeyState when possible. */
const { globalShortcut } = require('electron');
const macro = require('./macro');

const MODS = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt',
  shift: 'Shift', win: 'Super', super: 'Super', cmd: 'Super', command: 'Super', meta: 'Super'
};
const KEYS = {
  space: 'Space', enter: 'Enter', return: 'Enter', tab: 'Tab',
  esc: 'Escape', escape: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  insert: 'Insert', ins: 'Insert', home: 'Home', end: 'End',
  pgup: 'PageUp', pageup: 'PageUp', pgdn: 'PageDown', pagedown: 'PageDown',
  left: 'Left', right: 'Right', up: 'Up', down: 'Down',
  minus: 'Minus', equal: 'Equal', comma: 'Comma', period: 'Period', slash: 'Slash',
  backslash: 'Backslash', semicolon: 'Semicolon', quote: 'Quote', backtick: 'Backquote'
};

/** "ctrl+alt+space" -> "Ctrl+Alt+Space" ; throws Error on invalid. */
function parse(spec) {
  const toks = String(spec || '').toLowerCase().split(/[+]/).map(s => s.trim()).filter(Boolean);
  const mods = [];
  let key = null;
  for (const t of toks) {
    if (MODS[t]) { if (!mods.includes(MODS[t])) mods.push(MODS[t]); continue; }
    if (key) throw new Error(`hotkey '${spec}': more than one key`);
    if (KEYS[t]) key = KEYS[t];
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) key = t.toUpperCase();
    else if (/^[a-z]$/.test(t)) key = t.toUpperCase();
    else if (/^[0-9]$/.test(t)) key = t;
    else throw new Error(`hotkey '${spec}': unknown key '${t}'`);
  }
  if (!key) throw new Error(`hotkey '${spec}': no main key after modifiers`);
  if (!mods.length) throw new Error(`hotkey '${spec}': needs at least one modifier (Ctrl/Alt/Shift/Win)`);
  const order = ['Ctrl', 'Alt', 'Shift', 'Super'];
  mods.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return [...mods, key].join('+');
}

class HotkeyManager {
  constructor() { this.current = null; this._specs = new Map(); }

  /** Returns {ok, accel, error}. */
  register(spec, onFire) {
    this.unregister();
    let accel;
    try { accel = parse(spec); }
    catch (e) { return { ok: false, error: e.message }; }
    const fired = globalShortcut.register(accel, () => {
      // Ctrl+Alt combos keep re-firing after release without this guard (Electron docs).
      const mods = this._specs.get(accel);
      if (macro.available && mods && mods.includes('Ctrl') && mods.includes('Alt')) {
        if (!(macro.isDown(0x11) && macro.isDown(0x12))) return;
      }
      onFire();
    });
    if (!fired || globalShortcut.isRegistered(accel) === false) {
      globalShortcut.unregister(accel);
      return { ok: false, error: `'${accel}' is already taken by another app — pick a different hotkey.` };
    }
    this._specs.set(accel, accel.split('+').slice(0, -1));
    this.current = { spec, accel };
    return { ok: true, accel };
  }

  unregister() {
    if (this.current) {
      globalShortcut.unregister(this.current.accel);
      this._specs.delete(this.current.accel);
      this.current = null;
    }
  }

  /** Human display form: "Ctrl + Alt + Space". */
  static display(accel) {
    try { return parse(accel).split('+').join(' + '); }
    catch { return accel || '—'; }
  }
}

module.exports = { HotkeyManager, parse };
