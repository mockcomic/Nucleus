'use strict';
/* Global hotkey management: parse user specs, register via globalShortcut,
   guard the Ctrl+Alt auto-repeat quirk with GetAsyncKeyState when possible.
   Mouse-button triggers (Middle / Back / Forward) cannot go through
   globalShortcut — they take the WH_MOUSE_LL path in mousehook.js. */
const { globalShortcut } = require('electron');
const macro = require('./macro');
const mousehook = require('./mousehook');

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

/* Recordable mouse buttons: canonical spec token -> the name that rides in the
   accel string. Left/right are deliberately absent — a swallowed left click
   would make Windows unusable, and the wheel already uses right-click to
   dismiss. Values must stay in step with mousehook.TRIGGERS. */
const MOUSE_KEYS = {
  mmiddle: 'Middle',
  mback: 'Back',
  mfwd: 'Forward'
};
/* Loose spellings (hand-edited config.json, old notes) folded to the canonical
   token, which is what gets stored and displayed. */
const MOUSE_ALIASES = {
  mmiddle: 'mmiddle', middle: 'mmiddle', middleclick: 'mmiddle', mbtn: 'mmiddle',
  mousemiddle: 'mmiddle', mouse4: 'mmiddle', wheel: 'mmiddle',
  mback: 'mback', back: 'mback', mouseback: 'mback', xbutton1: 'mback', mouse3: 'mback',
  mfwd: 'mfwd', forward: 'mfwd', fwd: 'mfwd', mouseforward: 'mfwd', xbutton2: 'mfwd', mouse5: 'mfwd'
};
const MOD_ORDER = ['Ctrl', 'Alt', 'Shift', 'Super'];

/** "Middle" -> "Middle click" (the friendly fragment chips/tooltips show). */
function mouseLabel(key) {
  return key === 'Middle' ? 'Middle click'
    : key === 'Back' ? 'Back button'
      : key === 'Forward' ? 'Forward button'
        : String(key);
}

/**
 * Structured form of a spec:
 *   { mods: ['Ctrl','Alt'], key: 'Space' | 'Middle' | 'Back' | 'Forward',
 *     token: 'space' | 'mmiddle' | …, mouse: boolean, accel: 'Ctrl+Alt+Space' }
 * Throws Error on anything unusable.
 *
 * A MOUSE main key needs no keyboard modifier — `mmiddle` alone is a legal
 * trigger (Behavior → "Let the mouse button through" is the escape hatch when
 * that steals middle-click paste). A keyboard main key still requires at least
 * one modifier, exactly as before.
 */
function parseStructured(spec) {
  const toks = String(spec || '').toLowerCase().split(/[+]/).map(s => s.trim()).filter(Boolean);
  const mods = [];
  let key = null, token = null, mouse = false;
  for (const t of toks) {
    if (MODS[t]) { if (!mods.includes(MODS[t])) mods.push(MODS[t]); continue; }
    if (key) throw new Error(`hotkey '${spec}': more than one key`);
    const mt = MOUSE_ALIASES[t];
    if (mt) { token = mt; key = MOUSE_KEYS[mt]; mouse = true; }
    else if (KEYS[t]) { token = t; key = KEYS[t]; }
    else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(t)) { token = t; key = t.toUpperCase(); }
    else if (/^[a-z]$/.test(t)) { token = t; key = t.toUpperCase(); }
    else if (/^[0-9]$/.test(t)) { token = t; key = t; }
    else throw new Error(`hotkey '${spec}': unknown key '${t}'`);
  }
  if (!key) throw new Error(`hotkey '${spec}': no main key after modifiers`);
  if (!mouse && !mods.length) {
    throw new Error(`hotkey '${spec}': needs at least one modifier (Ctrl/Alt/Shift/Win) or a mouse button (Middle/Back/Forward)`);
  }
  mods.sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return { mods, key, token, mouse, accel: [...mods, key].join('+') };
}

/** "ctrl+alt+space" -> "Ctrl+Alt+Space", "ctrl+mmiddle" -> "Ctrl+Middle"; throws Error on invalid. */
function parse(spec) {
  return parseStructured(spec).accel;
}

class HotkeyManager {
  constructor() { this.current = null; this._specs = new Map(); }

  /**
   * Returns {ok, accel, mouse?, error}.
   * opts.clickThrough (mouse specs only): let the press reach the app under the
   * cursor instead of swallowing it. Default false — the button behaves like a
   * real hotkey.
   */
  register(spec, onFire, opts) {
    this.unregister();
    let st;
    try { st = parseStructured(spec); }
    catch (e) { return { ok: false, error: e.message }; }

    /* Mouse trigger: the hook owns it entirely. Never hand an accel containing
       a button name to globalShortcut. */
    if (st.mouse) {
      const clickThrough = !!(opts && opts.clickThrough);
      const r = mousehook.setTrigger(st.token, st.mods, clickThrough, onFire);
      if (!r.ok) return { ok: false, error: r.error };
      this._specs.set(st.accel, { mods: st.mods, mouse: true, token: st.token });
      this.current = { spec, accel: st.accel, mouse: true };
      return { ok: true, accel: st.accel, mouse: true };
    }

    // Keyboard-only: never leave a previous mouse trigger quietly eating clicks.
    mousehook.clear();
    let fired;
    try {
      fired = globalShortcut.register(st.accel, () => {
        // Ctrl+Alt combos keep re-firing after release without this guard (Electron docs).
        const rec = this._specs.get(st.accel);
        const mods = rec && rec.mods;
        if (macro.available && mods && mods.includes('Ctrl') && mods.includes('Alt')) {
          if (!(macro.isDown(0x11) && macro.isDown(0x12))) return;
        }
        onFire();
      });
    } catch (err) {
      // Exotic accelerators can throw instead of returning false — never let
      // that escape into bootstrap / the config-changed handler.
      try { globalShortcut.unregister(st.accel); } catch { /* partial state */ }
      return { ok: false, error: `'${st.accel}' could not be registered (${err && err.message || err})` };
    }
    if (!fired || globalShortcut.isRegistered(st.accel) === false) {
      globalShortcut.unregister(st.accel);
      return { ok: false, error: `'${st.accel}' is already taken by another app — pick a different hotkey.` };
    }
    this._specs.set(st.accel, { mods: st.accel.split('+').slice(0, -1), mouse: false });
    this.current = { spec, accel: st.accel, mouse: false };
    return { ok: true, accel: st.accel };
  }

  unregister() {
    mousehook.clear();
    if (this.current) {
      // 'Middle' is not an accelerator — never hand a mouse spec to Electron.
      if (!this.current.mouse) globalShortcut.unregister(this.current.accel);
      this._specs.delete(this.current.accel);
      this.current = null;
    }
  }

  /** Human display form: "Ctrl + Alt + Space", "Middle click", "Ctrl + Back". */
  static display(accel) {
    try {
      const st = parseStructured(accel);
      return [...st.mods, st.mouse ? mouseLabel(st.key) : st.key].join(' + ');
    }
    catch { return accel || '—'; }
  }
}

module.exports = { HotkeyManager, parse, parseStructured, mouseLabel, MOUSE_KEYS };
