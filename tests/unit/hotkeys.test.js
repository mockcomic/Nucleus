'use strict';
/* Unit tests for src/main/hotkeys.js — the spec grammar and the routing between
   the two registration paths:
     keyboard main key  -> Electron globalShortcut
     mouse main key     -> the WH_MOUSE_LL hook in mousehook.js
   Both `electron` and `mousehook` are replaced in the require cache
   (test-bootstrap recipe): a unit run must never register a real system-wide
   mouse hook or a real global shortcut. */
const test = require('node:test');
const assert = require('node:assert/strict');

/* ---- electron stub ---- */
const electronPath = require.resolve('electron');
const gs = { registerCalls: [], unregisterCalls: [], registered: true, ret: true };
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    globalShortcut: {
      register: (accel, cb) => { gs.registerCalls.push(accel); gs.cb = cb; return gs.ret; },
      unregister: (accel) => { gs.unregisterCalls.push(accel); },
      isRegistered: () => gs.registered
    }
  }
};

/* ---- macro stub (deterministic GetAsyncKeyState guard, no FFI) ---- */
const mac = { isDown: () => true };
const macroPath = require.resolve('../../src/main/macro.js');
require.cache[macroPath] = {
  id: macroPath, filename: macroPath, loaded: true,
  exports: {
    available: true, loadError: null, probeAvailable: false, foregroundProbe: () => null,
    sendMacro: async () => {}, sendVk: async () => {}, sendChord: async () => {},
    isDown: (vk) => mac.isDown(vk), vkFor: () => 0,
    ffi: { available: false, loadError: 'stubbed', declareUser32: () => { throw new Error('stub'); } }
  }
};

/* ---- mousehook stub ---- */
const mh = { setCalls: [], clearCalls: [], result: { ok: true } };
const mhPath = require.resolve('../../src/main/mousehook.js');
require.cache[mhPath] = {
  id: mhPath, filename: mhPath, loaded: true,
  exports: {
    TRIGGERS: {
      mmiddle: { vk: 0x04, down: 0x0207, up: 0x0208, xdata: null, label: 'Middle click' },
      mback: { vk: 0x05, down: 0x020b, up: 0x020c, xdata: 1, label: 'Back button' },
      mfwd: { vk: 0x06, down: 0x020b, up: 0x020c, xdata: 2, label: 'Forward button' }
    },
    setTrigger: (token, mods, clickThrough, onFire) => {
      mh.setCalls.push({ token, mods, clickThrough });
      mh.onFire = onFire;
      return mh.result;
    },
    clear: () => { mh.clearCalls.push(1); },
    shutdown: () => {}, active: () => false
  }
};

const { HotkeyManager, parse, parseStructured, mouseLabel } = require('../../src/main/hotkeys.js');

const reset = () => {
  gs.registerCalls.length = 0; gs.unregisterCalls.length = 0; gs.registered = true; gs.ret = true;
  mh.setCalls.length = 0; mh.clearCalls.length = 0; mh.result = { ok: true };
  mac.isDown = () => true;                            // chord held unless a test says otherwise
};

/* --------------------------------- parse ---------------------------------- */
test('parse keeps the keyboard grammar exactly as before', () => {
  assert.equal(parse('ctrl+alt+space'), 'Ctrl+Alt+Space');
  assert.equal(parse('CTRL+ALT+SPACE'), 'Ctrl+Alt+Space');
  assert.equal(parse('  win + e  '), 'Super+E');
  assert.equal(parse('shift+f5'), 'Shift+F5');
  assert.equal(parse('ctrl+1'), 'Ctrl+1');
  assert.equal(parse('ctrl+alt+shift+win+j'), 'Ctrl+Alt+Shift+Super+J');   // canonical order
  assert.equal(parse('alt+pgdn'), 'Alt+PageDown');
  assert.throws(() => parse('k'), /needs at least one modifier/);
  assert.throws(() => parse('ctrl+a+b'), /more than one key/);
  assert.throws(() => parse('ctrl+'), /no main key/);
  assert.throws(() => parse('ctrl+@'), /unknown key/);
});

test('parse accepts the three mouse buttons as the main key', () => {
  assert.equal(parse('mmiddle'), 'Middle');
  assert.equal(parse('mback'), 'Back');
  assert.equal(parse('mfwd'), 'Forward');
  assert.equal(parse('ctrl+alt+mmiddle'), 'Ctrl+Alt+Middle');
  assert.equal(parse('ctrl+mback'), 'Ctrl+Back');
  assert.equal(parse('ctrl+alt+shift+win+mfwd'), 'Ctrl+Alt+Shift+Super+Forward');
});

test('parse folds loose mouse spellings to the canonical token', () => {
  for (const [raw, want] of [
    ['middle', 'Middle'], ['mouse4', 'Middle'], ['wheel', 'Middle'], ['mbtn', 'Middle'],
    ['back', 'Back'], ['xbutton1', 'Back'], ['mouse3', 'Back'],
    ['forward', 'Forward'], ['fwd', 'Forward'], ['xbutton2', 'Forward'], ['mouse5', 'Forward']
  ]) assert.equal(parse(raw), want, raw);
});

test('a mouse button is a key, not a modifier — two main keys still rejected', () => {
  assert.throws(() => parse('mmiddle+a'), /more than one key/);
  assert.throws(() => parse('a+mmiddle'), /more than one key/);
  assert.throws(() => parse('mmiddle+mback'), /more than one key/);
  assert.throws(() => parse('ctrl+alt+shift+win+mmiddle+mback'), /more than one key/);
});

test('parseStructured reports the token/keys the hook needs', () => {
  assert.deepEqual(parseStructured('ctrl+mmiddle'),
    { mods: ['Ctrl'], key: 'Middle', token: 'mmiddle', mouse: true, accel: 'Ctrl+Middle' });
  assert.deepEqual(parseStructured('ctrl+alt+space').token, 'space');
  assert.equal(parseStructured('ctrl+alt+space').mouse, false);
  assert.deepEqual(parseStructured('mfwd').mods, []);
});

test('mouseLabel gives the friendly fragment', () => {
  assert.equal(mouseLabel('Middle'), 'Middle click');
  assert.equal(mouseLabel('Back'), 'Back button');
  assert.equal(mouseLabel('Forward'), 'Forward button');
  assert.equal(mouseLabel('Space'), 'Space');
});

test('HotkeyManager.display renders both kinds of trigger', () => {
  assert.equal(HotkeyManager.display('ctrl+alt+space'), 'Ctrl + Alt + Space');
  assert.equal(HotkeyManager.display('win+e'), 'Super + E');   // canonical name here; the FTU renders it as "Win"
  assert.equal(HotkeyManager.display('mmiddle'), 'Middle click');
  assert.equal(HotkeyManager.display('ctrl+mmiddle'), 'Ctrl + Middle click');
  assert.equal(HotkeyManager.display('mback'), 'Back button');
  assert.equal(HotkeyManager.display(''), '—');
  assert.equal(HotkeyManager.display('not a hotkey at all!!'), 'not a hotkey at all!!');
});

/* ------------------------------- routing ---------------------------------- */
test('a keyboard spec goes to globalShortcut and clears any mouse hook', () => {
  reset();
  const m = new HotkeyManager();
  const r = m.register('ctrl+alt+space', () => {});
  assert.ok(r.ok);
  assert.equal(r.accel, 'Ctrl+Alt+Space');
  assert.equal(r.mouse, undefined);
  assert.deepEqual(gs.registerCalls, ['Ctrl+Alt+Space']);
  assert.equal(mh.setCalls.length, 0);
  assert.ok(mh.clearCalls.length >= 1);          // never leave a stale hook behind
});

test('a mouse spec never touches globalShortcut', () => {
  reset();
  const m = new HotkeyManager();
  const r = m.register('ctrl+mmiddle', () => {});
  assert.ok(r.ok);
  assert.equal(r.accel, 'Ctrl+Middle');
  assert.equal(r.mouse, true);
  assert.equal(gs.registerCalls.length, 0);      // Electron cannot parse an accelerator with a button in it
  assert.deepEqual(mh.setCalls[0].token, 'mmiddle');
  assert.deepEqual(mh.setCalls[0].mods, ['Ctrl']);
});

test('the click-through option rides through to the hook', () => {
  reset();
  const m = new HotkeyManager();
  m.register('mmiddle', () => {}, { clickThrough: false });
  assert.equal(mh.setCalls[0].clickThrough, false);
  m.register('mmiddle', () => {}, { clickThrough: true });
  assert.equal(mh.setCalls[1].clickThrough, true);
  m.register('mmiddle', () => {});                // no opts at all => swallow
  assert.equal(mh.setCalls[2].clickThrough, false);
});

test('a failing hook registration surfaces the error and keeps current empty', () => {
  reset();
  mh.result = { ok: false, error: 'Mouse-button hotkeys need the Windows input bridge' };
  const m = new HotkeyManager();
  const r = m.register('mfwd', () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /input bridge/);
  assert.equal(m.current, null);
});

test('re-registering replaces the previous trigger of either kind', () => {
  reset();
  const m = new HotkeyManager();
  m.register('mmiddle', () => {});
  m.register('ctrl+alt+space', () => {});          // mouse -> keyboard
  assert.ok(mh.clearCalls.length >= 1);
  m.register('mback', () => {});                    // keyboard -> mouse
  assert.equal(gs.registerCalls.length, 1);         // only the one keyboard registration
  assert.deepEqual(mh.setCalls.map((c) => c.token), ['mmiddle', 'mback']);
  assert.deepEqual(gs.unregisterCalls, ['Ctrl+Alt+Space']);
});

test('unregister clears both paths', () => {
  reset();
  const m = new HotkeyManager();
  m.register('ctrl+j', () => {});
  m.unregister();
  assert.deepEqual(gs.unregisterCalls, ['Ctrl+J']);
  assert.ok(mh.clearCalls.length >= 1);
  assert.equal(m.current, null);
});

test('a taken keyboard combo still reports the conflict', () => {
  reset();
  gs.ret = false;
  const m = new HotkeyManager();
  const r = m.register('ctrl+alt+space', () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /already taken by another app/);
});

test('the fire callback runs when the chord is genuinely held', () => {
  reset();
  const m = new HotkeyManager();
  let fired = 0;
  m.register('ctrl+alt+space', () => { fired++; });
  gs.cb();                                          // simulate the OS delivering the shortcut
  assert.equal(fired, 1);
});

test('the Ctrl+Alt auto-repeat guard drops a fire after the modifiers were released', () => {
  reset();
  const m = new HotkeyManager();
  let fired = 0;
  m.register('ctrl+alt+space', () => { fired++; });
  mac.isDown = () => false;                          // Electron re-firing with nothing held down
  gs.cb();
  assert.equal(fired, 0, 'hotkeys.js:52-57 behaviour — no phantom re-summon');
  mac.isDown = (vk) => vk === 0x11 || vk === 0x12;   // modifiers back down
  gs.cb();
  assert.equal(fired, 1);
});

test('a non-Ctrl+Alt combo is never gated by the guard', () => {
  reset();
  mac.isDown = () => false;                          // guard only applies to Ctrl+Alt specs
  const m = new HotkeyManager();
  let fired = 0;
  m.register('ctrl+j', () => { fired++; });
  gs.cb();
  assert.equal(fired, 1);
});
