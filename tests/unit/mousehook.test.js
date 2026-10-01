'use strict';
/* Unit tests for the pure decision half of src/main/mousehook.js.

   `_hookStep` is the whole behaviour of the WH_MOUSE_LL procedure — which events
   to ignore, which to fire on, and which to hide from the target app — with no
   FFI, no Electron and no system hook involved. The FFI side is exercised by
   hand (see README "Try it"); here we only assert the state machine, plus the
   fail-soft path when the input bridge is missing. */
const test = require('node:test');
const assert = require('node:assert/strict');

/* ---- macro stub, injected BEFORE mousehook is required (it captures it) ---- */
const macroPath = require.resolve('../../src/main/macro.js');
const stub = { ffi: { available: false, loadError: 'stubbed for the unit run' }, isDown: () => true };
require.cache[macroPath] = {
  id: macroPath, filename: macroPath, loaded: true,
  exports: {
    available: false, loadError: stub.ffi.loadError, probeAvailable: false,
    foregroundProbe: () => null, sendMacro: async () => {}, sendVk: async () => {},
    sendChord: async () => {}, isDown: (vk) => stub.isDown(vk), vkFor: () => 0,
    ffi: stub.ffi
  }
};

const mousehook = require('../../src/main/mousehook.js');
const { _hookStep: hookStep } = mousehook;

const WM_MDOWN = 0x0207, WM_MUP = 0x0208, WM_XDOWN = 0x020b, WM_XUP = 0x020c;

/* Fresh armed state for one button, mirroring the module's own shape. */
function st(over = {}) {
  return Object.assign({
    armed: true, down: WM_MDOWN, up: WM_MUP, xdata: null,
    mods: [], clickThrough: false, held: false, suppressed: false
  }, over);
}
const alwaysDown = () => true;
const neverDown = () => false;

/* ------------------------------- ignored events ---------------------------- */
test('unarmed state passes everything through untouched', () => {
  const s = st({ armed: false });
  const d = hookStep(s, { msg: WM_MDOWN }, alwaysDown);
  assert.equal(d.next, true); assert.equal(d.swallow, false); assert.equal(d.fire, false);
  assert.equal(s.held, false);
});

test('other mouse messages are not ours and never reach lParam logic', () => {
  for (const msg of [0x0200 /* MOVE */, 0x020A /* WHEEL */, 0x0201 /* LDOWN */, 0x0204 /* RDOWN */]) {
    const s = st();
    const d = hookStep(s, { msg }, alwaysDown);
    assert.equal(d.next, true, `msg ${msg} passes through`);
    assert.equal(d.fire, false, `msg ${msg} does not fire`);
    assert.equal(s.held, false, `msg ${msg} leaves state clean`);
  }
});

test('an injected event is ignored (never summon from synthesized input)', () => {
  const s = st();
  const d = hookStep(s, { msg: WM_MDOWN, injected: true }, alwaysDown);
  assert.equal(d.fire, false);
  assert.equal(d.next, true);
  assert.equal(s.held, false);
});

test('the test-input hatch accepts injected presses only when armed to', () => {
  const off = st();
  assert.equal(hookStep(off, { msg: WM_MDOWN, injected: true }, alwaysDown).fire, false);
  const on = st({ acceptInjected: true });          // RADIAL_WHEEL_TEST_INPUT=1 only
  assert.equal(hookStep(on, { msg: WM_MDOWN, injected: true }, alwaysDown).fire, true);
});

/* --------------------------------- pressing -------------------------------- */
test('default: the press fires AND is swallowed, and its release is swallowed too', () => {
  const s = st();
  const down = hookStep(s, { msg: WM_MDOWN }, alwaysDown);
  assert.equal(down.fire, true);
  assert.equal(down.swallow, true);
  assert.equal(down.next, false, 'returning non-zero hides the event');
  assert.equal(s.held, true);
  assert.equal(s.suppressed, true);

  const up = hookStep(s, { msg: WM_MUP }, alwaysDown);
  assert.equal(up.swallow, true, 'the release must be paired with the press');
  assert.equal(up.fire, false);
  assert.equal(s.held, false);
  assert.equal(s.suppressed, false);
});

test('a second press while held does not fire twice (auto-repeat guard)', () => {
  const s = st();
  assert.equal(hookStep(s, { msg: WM_MDOWN }, alwaysDown).fire, true);
  const rep = hookStep(s, { msg: WM_MDOWN }, alwaysDown);
  assert.equal(rep.fire, false);
  assert.equal(rep.next, true, 'the repeat goes where the first one went: nowhere useful, but not swallowed twice');
});

test('clickThrough: fires but the app still receives press and release', () => {
  const s = st({ clickThrough: true });
  const down = hookStep(s, { msg: WM_MDOWN }, alwaysDown);
  assert.equal(down.fire, true);
  assert.equal(down.swallow, false);
  assert.equal(down.next, true);
  assert.equal(s.suppressed, false);

  const up = hookStep(s, { msg: WM_MUP }, alwaysDown);
  assert.equal(up.swallow, false, 'an unswallowed press must not swallow its release');
  assert.equal(up.next, true);
});

test('the trigger re-arms after a full press/release cycle', () => {
  const s = st();
  hookStep(s, { msg: WM_MDOWN }, alwaysDown);
  hookStep(s, { msg: WM_MUP }, alwaysDown);
  assert.equal(hookStep(s, { msg: WM_MDOWN }, alwaysDown).fire, true, 'second summon works');
});

/* -------------------------------- modifiers ------------------------------- */
test('a required modifier that is up passes the click through untouched', () => {
  const s = st({ mods: ['Ctrl'] });
  const d = hookStep(s, { msg: WM_MDOWN }, neverDown);
  assert.equal(d.fire, false);
  assert.equal(d.next, true, 'plain middle-click still reaches the app');
  assert.equal(s.suppressed, false);
  // …and the release is therefore NOT swallowed either
  assert.equal(hookStep(s, { msg: WM_MUP }, neverDown).swallow, false);
});

test('a complete chord fires (all modifiers down)', () => {
  const s = st({ mods: ['Ctrl', 'Alt'] });
  const d = hookStep(s, { msg: WM_MDOWN }, (vk) => vk === 0x11 || vk === 0x12);
  assert.equal(d.fire, true);
  assert.equal(d.swallow, true);
});

test('one modifier down, one up: no fire', () => {
  const s = st({ mods: ['Ctrl', 'Alt'] });
  const d = hookStep(s, { msg: WM_MDOWN }, (vk) => vk === 0x11);
  assert.equal(d.fire, false);
});

/* --------------------------------- XBUTTON --------------------------------- */
test('Back and Forward share a message and are told apart by mouseData', () => {
  const back = st({ down: WM_XDOWN, up: WM_XUP, xdata: 1 });
  assert.equal(hookStep(back, { msg: WM_XDOWN, xdata: 2 }, alwaysDown).fire, false, 'forward is not back');
  assert.equal(back.held, false);
  assert.equal(hookStep(back, { msg: WM_XDOWN, xdata: 1 }, alwaysDown).fire, true);
  assert.equal(hookStep(back, { msg: WM_XUP, xdata: 1 }, alwaysDown).swallow, true);
});

test('a missing mouseData field reads as 0, so it cannot match an XBUTTON trigger', () => {
  const fwd = st({ down: WM_XDOWN, up: WM_XUP, xdata: 2 });
  assert.equal(hookStep(fwd, { msg: WM_XDOWN }, alwaysDown).fire, false);
});

/* --------------------------- module surface / fail-soft -------------------- */
test('TRIGGERS covers exactly the three recordable buttons', () => {
  assert.deepEqual(Object.keys(mousehook.TRIGGERS).sort(), ['mback', 'mfwd', 'mmiddle']);
  assert.equal(mousehook.TRIGGERS.mmiddle.vk, 0x04);
  assert.equal(mousehook.TRIGGERS.mback.vk, 0x05);
  assert.equal(mousehook.TRIGGERS.mfwd.vk, 0x06);
  assert.equal(mousehook.TRIGGERS.mback.down, mousehook.TRIGGERS.mfwd.down, 'both XBUTTONs share the message');
});

test('an unknown token is rejected without touching FFI', () => {
  const r = mousehook.setTrigger('mleft', [], false, () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown mouse button/);
});

test('with no input bridge, setTrigger reports it instead of crashing', () => {
  const r = mousehook.setTrigger('mmiddle', ['Ctrl'], false, () => {});
  assert.equal(r.ok, false);
  assert.match(r.error, /input bridge/);
  assert.match(r.error, /keyboard hotkey/);
  assert.equal(mousehook.active(), false);
});

test('clear() and shutdown() are safe to call with nothing installed', () => {
  assert.doesNotThrow(() => mousehook.clear());
  assert.doesNotThrow(() => mousehook.shutdown());
  assert.equal(mousehook.active(), false);
});

/* ------------------------- XBUTTON mouseData conventions ------------------ */
/* Field-captured driver quirk: one mouse reported the XBUTTON id in the HIGH
   word of MSLLHOOKSTRUCT.mouseData (0x00010000) instead of the documented low
   word (0x00000001). A plain `mouseData === 1` compare silently rejected every
   Back press from that device — and apps that read only the low word ignored
   the button entirely, which is what the user saw as "does nothing". */
const XB1 = 1, XB2 = 2, XB1_HI = 0x00010000, XB2_HI = 0x00020000;

test('_xbuttonId reads the id from either word (and 0 means "not ours")', () => {
  const { _xbuttonId: id } = mousehook;
  assert.equal(id(XB1), 1);
  assert.equal(id(XB2), 2);
  assert.equal(id(XB1_HI), 1, 'high-word driver convention');
  assert.equal(id(XB2_HI), 2);
  assert.equal(id(0), 0);
  assert.equal(id(0x00010002), 2, 'the populated low word wins');
  assert.equal(id(undefined), 0);
  assert.equal(id(null), 0);
});

test('Back fires whether the driver reports mouseData low or high', () => {
  for (const raw of [XB1, XB1_HI]) {
    const s = st({ down: WM_XDOWN, up: WM_XUP, xdata: 1 });
    const d = hookStep(s, { msg: WM_XDOWN, xdata: raw }, alwaysDown);
    assert.equal(d.fire, true, `mouseData 0x${(raw >>> 0).toString(16)}`);
    assert.equal(d.swallow, true);
    assert.equal(hookStep(s, { msg: WM_XUP, xdata: raw }, alwaysDown).swallow, true);
  }
});

test('Forward is not Back under either convention', () => {
  for (const raw of [XB2, XB2_HI]) {
    const s = st({ down: WM_XDOWN, up: WM_XUP, xdata: 1 });          // armed for Back
    assert.equal(hookStep(s, { msg: WM_XDOWN, xdata: raw }, alwaysDown).fire, false, `0x${(raw >>> 0).toString(16)}`);
    assert.equal(s.held, false, 'a rejected press leaves no state behind');
  }
});

test('a release whose mouseData the driver omitted still pairs with its press', () => {
  const s = st({ down: WM_XDOWN, up: WM_XUP, xdata: 1 });
  assert.equal(hookStep(s, { msg: WM_XDOWN, xdata: XB1 }, alwaysDown).fire, true);
  assert.equal(s.held, true);
  assert.equal(s.suppressed, true);
  // mouseData missing/zero on the release must NOT strand held/suppressed
  assert.equal(hookStep(s, { msg: WM_XUP, xdata: 0 }, alwaysDown).swallow, true);
  assert.equal(s.held, false);
  assert.equal(s.suppressed, false);
  assert.equal(hookStep(s, { msg: WM_XDOWN, xdata: XB1_HI }, alwaysDown).fire, true,
    'a quirky release must not kill the trigger after one press');
});
