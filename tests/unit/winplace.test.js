'use strict';
/* Unit tests for the pure geometry behind src/main/winplace.js — the
   post-launch placement of freshly-opened APP WINDOWS (behavior.appOpenPosition).
   beginWatch is only checked for its off-paths (no FFI call happens there);
   the live EnumWindows/SetWindowPos sweep needs a real desktop and is
   exercised by the manual smoke, not here. */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => path.join(require('node:os').tmpdir()) } }
};
const winplace = require('../../src/main/winplace.js');

const MON = { x: 0, y: 0, width: 1920, height: 1080 };
const WORK = { x: 0, y: 0, width: 1920, height: 1040 };   // 40 px taskbar
const WIN = { l: 300, t: 200, width: 800, height: 500 };

/* ------------------------------- targetCenter -------------------------------- */
test('cursor mode aims at the captured cursor point', () => {
  assert.deepEqual(winplace.targetCenter('cursor', { x: 123, y: 45 }, WORK), { x: 123, y: 45 });
});

test('center mode aims at the work-area centre, not the raw monitor centre', () => {
  assert.deepEqual(winplace.targetCenter('center', { x: 123, y: 45 }, WORK), { x: 960, y: 520 });
});

test('center mode with no work area falls back to the cursor (defensive)', () => {
  assert.deepEqual(winplace.targetCenter('center', { x: 10, y: 20 }, null), { x: 10, y: 20 });
});

/* ---------------------------- computeMoveTarget ------------------------------ */
test('the window top-left centers the frame on the target', () => {
  assert.deepEqual(
    winplace.computeMoveTarget(WIN, { x: 960, y: 540 }, MON),
    { x: 960 - 400, y: 540 - 250 });
});

test('the move is clamped fully inside the monitor — near the bottom-right corner', () => {
  const t = winplace.computeMoveTarget(WIN, { x: 1919, y: 1079 }, MON);
  assert.deepEqual(t, { x: 1920 - 800, y: 1080 - 500 });
});

test('the move clamps the other way near the top-left and across the edges', () => {
  assert.deepEqual(winplace.computeMoveTarget(WIN, { x: -100, y: -100 }, MON), { x: 0, y: 0 });
  assert.deepEqual(winplace.computeMoveTarget(WIN, { x: 5000, y: 5000 }, MON), { x: 1120, y: 580 });
});

test('a window bigger than the monitor clamps to the origin, never a negative range', () => {
  const big = { l: 0, t: 0, width: 3000, height: 2000 };
  assert.deepEqual(winplace.computeMoveTarget(big, { x: 960, y: 540 }, MON), { x: 0, y: 0 });
});

test('secondary monitor with a negative origin clamps inside its own bounds', () => {
  const left = { x: -1920, y: 0, width: 1920, height: 1080 };
  assert.deepEqual(winplace.computeMoveTarget(WIN, { x: -960, y: 540 }, left), { x: -1360, y: 290 });
  assert.deepEqual(winplace.computeMoveTarget(WIN, { x: -2000, y: 5 }, left), { x: -1920, y: 0 });
});

/* ------------------------------ beginWatch off-paths -------------------------- */
test('beginWatch is a silent no-op when placement is off or junk', () => {
  assert.equal(winplace.beginWatch({}), false);
  assert.equal(winplace.beginWatch({ appOpenPosition: 'default' }), false);
  assert.equal(winplace.beginWatch({ appOpenPosition: 'bogus' }), false);
  assert.equal(winplace.beginWatch(null), false);
});
