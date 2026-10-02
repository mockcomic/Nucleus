'use strict';
/* Hard bounds inside the macro engine (the Critical audit fix): no caller —
   not even a compromised renderer driving action:preview — may push an
   unbounded workload into SendInput. These tests exercise the PURE checker
   (and sendMacro's fail-fast order) only; nothing here injects input. */
const test = require('node:test');
const assert = require('node:assert/strict');

const macro = require('../../src/main/macro.js');   // koffi load is guarded; ok without FFI
const { _validateSpec, MACRO_MAX_SPEC, MACRO_MAX_STEPS, MACRO_MAX_TOTAL_WAIT_MS } = macro;

test('_validateSpec accepts ordinary specs', () => {
  assert.doesNotThrow(() => _validateSpec('ctrl+c, wait=0.2, ctrl+v'));
  assert.doesNotThrow(() => _validateSpec('type:hello, world, with commas'));
  assert.doesNotThrow(() => _validateSpec(''));
  assert.doesNotThrow(() => _validateSpec(null));
});

test('over-length specs are rejected outright', () => {
  assert.doesNotThrow(() => _validateSpec('a'.repeat(MACRO_MAX_SPEC)));
  assert.throws(() => _validateSpec('a'.repeat(MACRO_MAX_SPEC + 1)), /too long/);
});

test('step count is capped', () => {
  // 'ctrl+a, ' per step keeps each list well under the length cap, so this
  // exercises the STEP bound, not the spec-length bound.
  assert.doesNotThrow(() => _validateSpec(Array(MACRO_MAX_STEPS).fill('ctrl+a').join(', ')));
  assert.throws(() => _validateSpec(Array(MACRO_MAX_STEPS + 1).fill('ctrl+a').join(', ')), /too many steps/);
});

test('total wait budget is capped (each wait clamped to 5 s first)', () => {
  assert.equal(MACRO_MAX_TOTAL_WAIT_MS, 15000);
  // 3 × 5 s == the budget: allowed; one more: rejected.
  assert.doesNotThrow(() => _validateSpec(Array(3).fill('wait=999').join(', ')));
  assert.throws(() => _validateSpec(Array(4).fill('wait=999').join(', ')), /waits exceed/);
});

test('sendMacro enforces the bounds before touching the FFI', async () => {
  // On any platform this must reject with the bounds error — never a
  // "keyboard synthesis unavailable" (which would mean injection was attempted)
  // and never a queue of keypresses.
  await assert.rejects(() => macro.sendMacro('a'.repeat(MACRO_MAX_SPEC + 1)), /too long/);
  await assert.rejects(() => macro.sendMacro(Array(MACRO_MAX_STEPS + 1).fill('ctrl+a').join(', ')), /too many steps/);
});
