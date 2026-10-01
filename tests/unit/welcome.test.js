'use strict';
/* Unit tests for the pure half of the FTU welcome logic
   (src/renderer/welcome/welcome-core.mjs): keydown -> hotkey spec,
   spec -> display form, and the step machine. No Electron, no DOM. */
const test = require('node:test');
const assert = require('node:assert/strict');

// ESM helper under a CJS test file — one shared dynamic import.
const core = import('../../src/renderer/welcome/welcome-core.mjs');
const use = async () => core;

// Mirror of config.js HOTKEY_RE — specs handed to hotkey:set must pass it.
const HOTKEY_RE = /^[a-z0-9+ ]{1,40}$/;
const ev = (key, mods = {}) => ({
  key, ctrlKey: !!mods.ctrl, altKey: !!mods.alt, shiftKey: !!mods.shift, metaKey: !!mods.win
});

/* ------------------------------ keyEventToSpec ----------------------------- */
test('keyEventToSpec maps the canonical modifier order and lowercases tokens', async () => {
  const { keyEventToSpec } = await use();
  assert.equal(keyEventToSpec(ev(' ', { ctrl: true, alt: true })), 'ctrl+alt+space');
  // input order of the flags must not leak into the spec
  assert.equal(keyEventToSpec(ev('k', { ctrl: true, alt: true, shift: true, win: true })), 'ctrl+alt+shift+win+k');
  assert.equal(keyEventToSpec(ev('e', { win: true })), 'win+e');
  assert.equal(keyEventToSpec(ev('F', { ctrl: true })), 'ctrl+f');
  assert.match(keyEventToSpec(ev(' ', { ctrl: true, alt: true })), HOTKEY_RE);
});

test('keyEventToSpec accepts every key hotkeys.parse understands', async () => {
  const { keyEventToSpec } = await use();
  const cases = {
    Space: 'space', Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace',
    Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end',
    PageUp: 'pgup', PageDown: 'pgdn',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    F1: 'f1', F12: 'f12', F24: 'f24',
    '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash',
    '\\': 'backslash', ';': 'semicolon', "'": 'quote', '`': 'backquote'
  };
  for (const [key, token] of Object.entries(cases)) {
    assert.equal(keyEventToSpec(ev(key, { ctrl: true })), `ctrl+${token}`, key);
  }
});

test('keyEventToSpec returns null for incomplete or unsupported presses', async () => {
  const { keyEventToSpec } = await use();
  for (const junk of ['Control', 'Alt', 'Shift', 'Meta', 'OS', 'control', 'dead', 'Unidentified', 'F25', 'Aa']) {
    assert.equal(keyEventToSpec(ev(junk, { ctrl: true })), null, junk);
  }
  // other printable symbols: hotkeys.parse rejects them — don't offer them
  assert.equal(keyEventToSpec(ev('&', { ctrl: true })), null);
  assert.equal(keyEventToSpec(ev('!')), null);
  // no modifier -> parse() would throw "needs at least one modifier"
  assert.equal(keyEventToSpec(ev('k')), null);
  assert.equal(keyEventToSpec(ev('1')), null);
  // junk arguments
  for (const junk of [undefined, null, {}, 'x', 42]) assert.equal(keyEventToSpec(junk), null);
});

/* --------------------------------- formatSpec -------------------------------- */
test('formatSpec renders the human keycap form', async () => {
  const { formatSpec } = await use();
  assert.equal(formatSpec('ctrl+alt+space'), 'Ctrl + Alt + Space');
  assert.equal(formatSpec('win+e'), 'Win + E');          // not hotkeys.js' "Super"
  assert.equal(formatSpec('ctrl+shift+f12'), 'Ctrl + Shift + F12');
  assert.equal(formatSpec('ctrl+pgdn'), 'Ctrl + Page Down');
  assert.equal(formatSpec('alt+tab'), 'Alt + Tab');
  assert.equal(formatSpec(''), '—');
  assert.equal(formatSpec(null), '—');
  assert.equal(formatSpec('   '), '—');
});

/* ---------------------------------- nextStep --------------------------------- */
test('nextStep clamps at both ends', async () => {
  const { nextStep } = await use();
  assert.equal(nextStep(1, 0, 4), 1);
  assert.equal(nextStep(1, 3, 4), 3);   // no past the last step
  assert.equal(nextStep(-1, 0, 4), 0);  // no before the first
  assert.equal(nextStep(-1, 2, 4), 1);
  assert.equal(nextStep(99, 0, 4), 3);
  assert.equal(nextStep(1, NaN, 4), 1);
  assert.equal(nextStep(1, undefined, 0), 0); // total < 1 floors to a single step
});

/* ----------------------- end-to-end: recorder -> parse-shape ---------------- */
test('every spec keyEventToSpec produces is one hotkey:set can accept', async () => {
  const { keyEventToSpec } = await use();
  const keys = ['a', 'z', '1', '7', ' ', 'Enter', 'Escape', 'F5', '/', ';', '`', 'ArrowUp'];
  const modCombos = [{}, { ctrl: true }, { alt: true }, { shift: true }, { win: true },
    { ctrl: true, alt: true }, { ctrl: true, shift: true, win: true }];
  for (const key of keys) {
    for (const mods of modCombos) {
      if (!Object.keys(mods).length) continue; // modifierless is (correctly) null
      const spec = keyEventToSpec(ev(key, mods));
      assert.ok(spec, `${key} + ${JSON.stringify(mods)}`);
      assert.match(spec, HOTKEY_RE);
      const toks = spec.split('+');
      assert.equal(new Set(toks).size, toks.length, `no duplicate tokens in ${spec}`);
      assert.ok(!['ctrl', 'alt', 'shift', 'win'].includes(toks.at(-1)), `last token is a real key in ${spec}`);
    }
  }
});
