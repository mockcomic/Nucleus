/* Regression tests for the folder-flyout dwell state machine
   (wheel-core.createFlyoutNavigator) — the sweep case:

   Hover folder A on the ring -> its fan dwells open. Move the pointer to a
   sibling folder B on the same ring (the common adjacent-plate case: the
   pointer never leaves the wheel, so no intermediate key ever re-arms the
   dwell). B must dwell-open and replace A.

   Bug: feed()'s folder branch armed the pending open, then called
   startClose() — which clears that exact timer — and nothing re-armed the
   open after the old fan collapsed, so B never opened while the pointer
   rested on it (every later feed with the same key returned early).

   The navigator is timing-only; we stub the geometry API with ring-level
   semantics (opening a ring folder replaces the whole open chain), which is
   exactly what openFlyout does at depth 0. */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createFlyoutNavigator } from '../../src/renderer/shared/wheel-core.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeFixture() {
  const folder = (id) => ({ item: { id, type: 'folder', children: [{ id: id + '-kid', type: 'app' }] } });
  const A = folder('A');
  const B = folder('B');
  const app = { item: { id: 'app', type: 'app' } };
  const segments = [A, B, app];
  let open = [];                       // ring-level stand-in for flyGroups
  const flyout = {
    isFolder: (s) => !!s && !!s.item && s.item.type === 'folder',
    open: (s) => {
      if (!flyout.isFolder(s)) return false;
      if (open.includes(s)) return true;
      open = [s];                      // depth-0 open closes everything
      return true;
    },
    isOpen: (s) => open.includes(s),
    levels: () => open.length,
    depthOf: (s) => open.indexOf(s),
    closeLevel: (d) => { open = open.slice(0, Math.max(0, d)); },
    closeAll: () => { open = []; },
    inOpenFamily: (s) => open.includes(s),
    reach: () => (open.length ? 100 : 0)
  };
  return { built: { segments, flyout }, A, B, app, openList: () => open.slice() };
}

test('first hover dwells a folder open', async () => {
  const { built, A, openList } = makeFixture();
  const nav = createFlyoutNavigator(built, { dwellMs: 40, graceMs: 10 });
  nav.feed(A, true);
  await sleep(60);
  assert.deepEqual(openList(), [A], 'A should dwell open');
});

test('sweep from an open folder to a sibling folder opens the sibling (grace < dwell)', async () => {
  const { built, A, B, openList } = makeFixture();
  const nav = createFlyoutNavigator(built, { dwellMs: 40, graceMs: 10 });
  nav.feed(A, true);
  await sleep(60);
  assert.deepEqual(openList(), [A]);
  nav.feed(B, true);                   // pointer lands on B, then rests there
  await sleep(30);                     // grace elapsed: old fan is down
  assert.deepEqual(openList(), []);    // ...but nothing is up
  nav.feed(B, true);                   // mousemove over the SAME plate — must not be swallowed
  await sleep(60);
  assert.deepEqual(openList(), [B], 'B must dwell open while the pointer rests on it');
});

test('sweep with dwell < grace swaps fans in one motion (no dead gap)', async () => {
  const { built, A, B, openList } = makeFixture();
  const nav = createFlyoutNavigator(built, { dwellMs: 10, graceMs: 200 });
  nav.feed(A, true);
  await sleep(30);
  assert.deepEqual(openList(), [A]);
  nav.feed(B, true);
  await sleep(40);
  assert.deepEqual(openList(), [B], 'B replaces A directly; A must not linger and A must not stay open alone');
});
