/* Pure geometry + keying for the `mixer` segment's in-wheel volume card
   (shared/wheel-mixer.js) — the placement math the overlay runs before it
   asks main to grow the window, covered without a DOM (the import is
   document-free at top level, same discipline as mark-filter.test.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computePanelLayout, mixerRowKey, isMixerItem } from '../../src/renderer/shared/wheel-mixer.js';

/* ------------------------------ computePanelLayout ------------------------- */
const W = 264, H = 320;

test('a segment at 3 o\u2019clock anchors the card fully outside the rim on +x', () => {
  const lay = computePanelLayout({ centerDeg: 90, outerRadius: 210, panelW: W, panelH: H, cx: 300, cy: 300, halfSize: 0 });
  assert.ok(lay.x >= 300 + 210, 'the card\u2019s left edge clears the rim');
  assert.ok(Math.abs(lay.y + H / 2 - 300) < 1, 'vertically centered on the ray');
  // reach = farthest corner distance from the wheel center
  const corners = [[lay.x, lay.y], [lay.x + W, lay.y], [lay.x, lay.y + H], [lay.x + W, lay.y + H]];
  const far = Math.max(...corners.map(([x, y]) => Math.hypot(x - 300, y - 300)));
  assert.equal(lay.reachPx, far);
});

test('a segment at 12 o\u2019clock anchors the card above the wheel (-y)', () => {
  const lay = computePanelLayout({ centerDeg: 0, outerRadius: 100, panelW: W, panelH: H, cx: 400, cy: 400, halfSize: 0 });
  assert.ok(lay.y + H <= 400 - 100, 'the card\u2019s bottom edge clears the rim');
  assert.ok(Math.abs(lay.x + W / 2 - 400) < 1, 'horizontally centered on the ray');
});

test('halfSize clamps the card into the window; a window smaller than the card centers it', () => {
  const lay = computePanelLayout({ centerDeg: 90, outerRadius: 200, panelW: W, panelH: H, cx: 300, cy: 300, halfSize: 240 });
  assert.ok(lay.x + lay.w <= 300 + 240 + 0.5 && lay.x >= 300 - 240 - 0.5, 'stays inside the square');
  assert.ok(lay.y + lay.h <= 300 + 240 + 0.5 && lay.y >= 300 - 240 - 0.5, 'stays inside the square (y)');
  const tiny = computePanelLayout({ centerDeg: 90, outerRadius: 10, panelW: W, panelH: H, cx: 0, cy: 0, halfSize: 80 });
  assert.ok(Math.abs(tiny.x + W / 2) < 0.5 && Math.abs(tiny.y + H / 2) < 0.5, 'centered when the square cannot hold it');
});

test('junk inputs fold to defaults instead of poisoning the window request', () => {
  const lay = computePanelLayout({ centerDeg: NaN, outerRadius: 'x', panelW: -5, panelH: Infinity, cx: undefined, cy: null });
  for (const v of [lay.x, lay.y, lay.w, lay.h, lay.reachPx]) {
    assert.equal(typeof v, 'number');
    assert.ok(Number.isFinite(v), 'all outputs finite');
  }
  assert.ok(lay.w >= 120 && lay.h >= 60, 'sizes clamped back into the sane band');
});

test('reach grows with the wheel radius and the card height', () => {
  const base = { centerDeg: 45, panelW: W, panelH: H, cx: 0, cy: 0, halfSize: 0 };
  const small = computePanelLayout({ ...base, outerRadius: 120 });
  const big = computePanelLayout({ ...base, outerRadius: 340 });
  assert.ok(big.reachPx > small.reachPx);
});

/* --------------------------------- mixerRowKey ------------------------------ */
test('row keys match the Settings tab\u2019s identity: system sounds own a row, apps key by pid', () => {
  assert.equal(mixerRowKey({ pid: 7, isSystem: true }), 'sys:7');
  assert.equal(mixerRowKey({ pid: 7 }), 'app:7');
  assert.equal(mixerRowKey({ pid: 0 }), 'app:0', 'pid 0 is filtered by groupSessions upstream; the key itself just identifies');
  assert.equal(mixerRowKey(null), '');
  assert.equal(mixerRowKey({ pid: 'x' }), '');
  assert.equal(mixerRowKey({ pid: NaN }), '');
});

/* --------------------------------- isMixerItem ------------------------------ */
test('only a well-formed mixer item claims the card gesture', () => {
  assert.equal(isMixerItem({ id: 'm', type: 'mixer' }), true);
  assert.equal(isMixerItem({ id: 'f', type: 'folder', children: [] }), false);
  assert.equal(isMixerItem({ type: 'MIXER' }), false, 'the stored type is canonicalized by config.validate (lowercase)');
  assert.equal(isMixerItem(null), false);
  assert.equal(isMixerItem('mixer'), false);
});
