/* Geometry-contract tests for the folder flyout fan (wheel-core.fanSpans) —
   pure math, no DOM needed at import (wheel-core only touches document inside
   functions). ESM like theme-render.test.js; node's module-syntax detection
   loads this .js as ESM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fanSpans, degToXY } from '../src/renderer/shared/wheel-core.js';

test('fanSpans: empty/zero folders produce nothing', () => {
  assert.deepEqual(fanSpans(90, 0), { span: 0, step: 0 });
  assert.deepEqual(fanSpans(90, -3), { span: 0, step: 0 });
});

test('fanSpans: a wide parent blooms to 3x its sweep', () => {
  // 12 items in a ring ⇒ 30° plate; 3 kids ⇒ 90° fan, 30° each.
  const { span, step } = fanSpans(30, 3);
  assert.equal(span, 90);
  assert.equal(step, 30);
});

test('fanSpans: each child gets at least 14 degrees even from a thin plate', () => {
  // A very thin plate's 3× bloom is too tight for three kids' minimum —
  // the per-child floor wins over the 3× rule.
  const { span, step } = fanSpans(7.5, 2);
  assert.equal(span, 28, 'floored at 2 × 14°');
  assert.equal(step, 14);
  // A 15° plate (24-item ring): 3× bloom (45°) already clears the floor.
  assert.equal(fanSpans(15, 2).span, 45);
});

test('fanSpans: the fan caps at 300 degrees total', () => {
  const { span, step } = fanSpans(180, 12);   // huge parent × 12 kids
  assert.equal(span, 300);
  assert.ok(Math.abs(step - 25) < 1e-9);
  const wide = fanSpans(360, 1);              // even a lone giant plate
  assert.equal(wide.span, 300);
});

test('fanSpans: per-child steps tile the span exactly', () => {
  for (const n of [1, 2, 5, 12]) {
    const { span, step } = fanSpans(40, n);
    assert.ok(Math.abs(step * n - span) < 1e-9, `n=${n}`);
  }
});

test('degToXY keeps the 0 = 12 o\u2019clock clockwise convention', () => {
  const [x12, y12] = degToXY(0, 0, 10, 0);
  const [x3, y3] = degToXY(0, 0, 10, 90);
  assert.ok(Math.abs(x12) < 1e-9 && y12 < 0, '0° points up');
  assert.ok(x3 > 0 && Math.abs(y3) < 1e-9, '90° points right');
});
