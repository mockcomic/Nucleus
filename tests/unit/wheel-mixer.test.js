/* Pure geometry + keying for the `mixer` segment's in-wheel volume card
   (shared/wheel-mixer.js) — the placement math the overlay runs before it
   asks main to grow the window, covered without a DOM (the import is
   document-free at top level, same discipline as mark-filter.test.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computePanelLayout, mixerRowKey, isMixerItem,
  pickDefaultDevice, deviceSignature, capDeviceList,
  TALLEST_CARD_PX, PANEL_H_CLAMP, MAX_VISIBLE_DEVICES
} from '../../src/renderer/shared/wheel-mixer.js';

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

/* ------------------------------ device pickers ------------------------------ */
const DEV = [
  { id: 'render:0', name: 'Speakers', isDefault: false },
  { id: 'render:1', name: 'Headphones', isDefault: true },
  { id: 'render:2', name: 'HDMI Output', isDefault: false }
];

test('pickDefaultDevice finds the endpoint Windows marked, and nothing else', () => {
  assert.equal(pickDefaultDevice(DEV).id, 'render:1');
  assert.equal(pickDefaultDevice(DEV.map((d) => ({ ...d, isDefault: false }))), null, 'no default is a state, not an error');
  assert.equal(pickDefaultDevice([{ id: 'a', name: 'A', isDefault: 1 }]), null, 'only a strict true counts');
  assert.equal(pickDefaultDevice([{ name: 'no id', isDefault: true }, DEV[1]]).id, 'render:1', 'an unusable entry is skipped');
  for (const junk of [null, undefined, 'x', 7, {}]) assert.equal(pickDefaultDevice(junk), null, `junk ${String(junk)} folds to null`);
});

test('deviceSignature is stable for an identical read and sensitive to every visible change', () => {
  assert.equal(deviceSignature(DEV), deviceSignature(DEV.map((d) => ({ ...d }))));
  assert.notEqual(deviceSignature(DEV), deviceSignature(DEV.map((d) => ({ ...d, isDefault: d.id === 'render:0' }))), 'a default flip must repaint the rows');
  assert.notEqual(deviceSignature(DEV), deviceSignature(DEV.map((d) => ({ ...d, name: d.name + ' ' }))), 'a rename must repaint');
  assert.notEqual(deviceSignature(DEV), deviceSignature([DEV[1], DEV[0], DEV[2]]), 'enumeration order is visible');
  assert.equal(deviceSignature([]), '');
  assert.equal(deviceSignature(null), '');
  assert.equal(deviceSignature([null, { name: 'x' }]), '', 'a list with nothing usable has no signature');
});

test('capDeviceList keeps Windows order, caps the visible rows, and reports the rest', () => {
  const many = Array.from({ length: 9 }, (_, i) => ({ id: 'd' + i, name: 'Device ' + i, isDefault: i === 4 }));
  const capped = capDeviceList(many);
  assert.equal(capped.items.length, MAX_VISIBLE_DEVICES);
  assert.equal(capped.extra, 9 - MAX_VISIBLE_DEVICES);
  assert.deepEqual(capped.items.map((d) => d.id), ['d0', 'd1', 'd2', 'd3', 'd4'], 'never re-sorted');
  assert.ok(capped.items.some((d) => d.isDefault), 'the default stays reachable in this case');
  assert.deepEqual(capDeviceList(many, 2).items.map((d) => d.id), ['d0', 'd4'], 'a default past the cap is pinned into the last visible row');
  assert.equal(capDeviceList(many, 2).extra, 7);
  const hiddenDefault = Array.from({ length: 8 }, (_, i) => ({ id: 'e' + i, name: 'Device ' + i, isDefault: i === 7 }));
  const pinned = capDeviceList(hiddenDefault);
  assert.equal(pinned.items.length, MAX_VISIBLE_DEVICES);
  assert.equal(pinned.items[MAX_VISIBLE_DEVICES - 1].id, 'e7', 'the current default is always reachable from the card');
  assert.equal(pinned.extra, 8 - MAX_VISIBLE_DEVICES);
  const empty = capDeviceList([]);
  assert.deepEqual(empty, { items: [], extra: 0 });
  for (const junk of [null, undefined, 'x', 7]) {
    const r = capDeviceList(junk);
    assert.deepEqual(r.items, [], `junk ${String(junk)} yields an empty list, not a throw`);
    assert.equal(r.extra, 0);
  }
  assert.deepEqual(capDeviceList([{ id: 'a' }, null, { name: 'x' }, 5]).items.map((d) => d.id), ['a'], 'junk entries drop out before the cap');
});

test('the tallest legal card still fits the geometry clamp that budgets the window grow', () => {
  // wheel.css caps the open endpoint list (.mx-dev-list) and shrinks the app
  // list (.mx-dev-open .mx-sessions); if a change makes the card taller, this
  // trips instead of the card getting clipped by the overlay window.
  assert.ok(TALLEST_CARD_PX > PANEL_H_CLAMP.lo && TALLEST_CARD_PX <= PANEL_H_CLAMP.hi,
    `budget ${TALLEST_CARD_PX} must sit inside ${PANEL_H_CLAMP.lo}–${PANEL_H_CLAMP.hi}`);
  assert.ok(PANEL_H_CLAMP.hi - TALLEST_CARD_PX >= 96,
    'the clamp keeps headroom over the measured worst case, so a taller card never spills past the window');
  const lay = computePanelLayout({ centerDeg: 90, outerRadius: 210, panelW: W, panelH: TALLEST_CARD_PX, cx: 300, cy: 300, halfSize: 0 });
  assert.equal(lay.h, TALLEST_CARD_PX, 'the measured height is not clamped away');
});
