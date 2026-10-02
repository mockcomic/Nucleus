'use strict';
/* Unit tests for scripts/bump-build.mjs — the dist pre-step that increments
   build.buildNumber. Pure helper only: no writes, no electron. */
const test = require('node:test');
const assert = require('node:assert/strict');

const mod = () => import('../../scripts/bump-build.mjs');

test('nextBuildNumber: increments a numeric string', async () => {
  const { nextBuildNumber } = await mod();
  assert.equal(nextBuildNumber('7'), '8');
  assert.equal(nextBuildNumber('0'), '1');
  assert.equal(nextBuildNumber('99'), '100');
});

test('nextBuildNumber: missing or garbage is treated as unseeded → 1', async () => {
  const { nextBuildNumber } = await mod();
  assert.equal(nextBuildNumber(undefined), '1');
  assert.equal(nextBuildNumber(''), '1');
  assert.equal(nextBuildNumber('abc'), '1');
  assert.equal(nextBuildNumber('1.5'), '1');
  assert.equal(nextBuildNumber(null), '1');
  assert.equal(nextBuildNumber({}), '1');
});

test('nextBuildNumber: accepts a JSON number (schema says string, be forgiving)', async () => {
  const { nextBuildNumber } = await mod();
  assert.equal(nextBuildNumber(41), '42');
});
