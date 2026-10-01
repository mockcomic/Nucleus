'use strict';
/* Pure logic for the first-time-use welcome window: keydown -> hotkey spec,
   spec -> display form, and the step machine. Deliberately DOM-free so
   tests/unit/welcome.test.js can exercise it directly under node --test.
   The specs produced here must survive hotkeys.parse (src/main/hotkeys.js)
   and config.js's HOTKEY_RE (/^[a-z0-9+ ]{1,40}$/): lowercase modifier
   tokens, a single lowercase key token, joined with '+'. */

const MOD_ORDER = ['ctrl', 'alt', 'shift', 'win'];

/* KeyboardEvent.key (or a {key} stand-in) -> hotkey token, or null when the
   token can't start a legal spec. Mirrors the KEYS table in hotkeys.js —
   keep the two in sync when either gains an entry. */
const NAMED = {
  ' ': 'space', space: 'space',
  enter: 'enter', tab: 'tab', escape: 'esc', backspace: 'backspace',
  delete: 'delete', insert: 'insert', home: 'home', end: 'end',
  pageup: 'pgup', pagedown: 'pgdn',
  arrowleft: 'left', arrowright: 'right', arrowup: 'up', arrowdown: 'down',
  '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash',
  '\\': 'backslash', ';': 'semicolon', "'": 'quote', '`': 'backquote'
};
const MOD_ONLY = new Set(['control', 'alt', 'shift', 'meta', 'os']);

/** keyEventToSpec({ctrlKey, altKey, shiftKey, metaKey, key}) -> "ctrl+alt+space" | null
 *  null means "not a complete combo yet" (bare modifier, unmapped key). */
export function keyEventToSpec(e) {
  if (!e || typeof e.key !== 'string') return null;
  const lower = e.key.toLowerCase();
  if (MOD_ONLY.has(lower)) return null;

  let token;
  if (NAMED[lower]) token = NAMED[lower];
  else if (/^f([1-9]|1[0-9]|2[0-4])$/.test(lower)) token = lower;
  else if (/^[a-z0-9]$/.test(lower)) token = lower;                    // letters + digits as-is
  else if (e.key.length === 1 && e.key !== ' ') return null;           // other printable symbols: hotkeys.js rejects them anyway
  else return null;                                                     // dead/compose/unmapped

  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('win');
  if (!mods.length) return null;                                        // parse() needs >= 1 modifier
  return [...MOD_ORDER.filter((m) => mods.includes(m)), token].join('+');
}

/* Display form for the keycap: "ctrl+alt+space" -> "Ctrl + Alt + Space".
   (hotkeys.js renders Win as "Super"; the FTU says "Win" — that's what the
   key is labelled on the keyboard.) */
const DISPLAY = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  win: 'Win', super: 'Win', cmd: 'Win', command: 'Win', meta: 'Win',
  space: 'Space', esc: 'Esc', enter: 'Enter', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', del: 'Delete', insert: 'Insert', ins: 'Insert',
  home: 'Home', end: 'End', pgup: 'Page Up', pageup: 'Page Up', pgdn: 'Page Down', pagedown: 'Page Down',
  left: '←', right: '→', up: '↑', down: '↓',
  minus: '-', equal: '=', comma: ',', period: '.', slash: '/',
  backslash: '\\', semicolon: ';', quote: "'", backquote: '`'
};

export function formatSpec(spec) {
  const toks = String(spec || '').toLowerCase().split('+').map((s) => s.trim()).filter(Boolean);
  if (!toks.length) return '—';
  return toks
    .map((t) => DISPLAY[t] || (/^f([1-9]|1[0-9]|2[0-4])$/.test(t) ? t.toUpperCase() : t.charAt(0).toUpperCase() + t.slice(1)))
    .join(' + ');
}

/** nextStep(dir, current, total) -> clamped step index (0-based). */
export function nextStep(dir, current, total) {
  const t = Math.max(1, total | 0);
  const c = Number.isFinite(current) ? current : 0;
  return Math.min(t - 1, Math.max(0, c + (dir | 0)));
}
