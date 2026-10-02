'use strict';
/* Drift guard for the sender-frame gate — the exact bug class the security
   audit caught (channels gaining side effects while slipping out of the
   PRIVILEGED map). Parses src/main/ipc.js as text and asserts:
     1. every registered channel is either frame-gated or in the explicit
        read-only allowlist;
     2. every PRIVILEGED key actually has a handler (no orphan gates);
     3. the only raw ipcMain registration is the documented log:line;
     4. the gate itself is intact (frameOn match + refused() shape) and
        SEND_CHANNELS covers exactly the fire-and-forget on-channels. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'ipc.js'), 'utf8');

const privilegedBlock = src.match(/const PRIVILEGED = \{([\s\S]*?)\};/);
assert.ok(privilegedBlock, 'PRIVILEGED map must exist in ipc.js');

/* channel -> owner pages (strings inside the [..] list) */
const gated = new Map();
for (const m of privilegedBlock[1].matchAll(/'([^']+)':\s*\[([^\]]*)\]/g)) {
  gated.set(m[1], [...m[2].matchAll(/'([^']+)'/g)].map((o) => o[1]));
}

const handleCh = [...src.matchAll(/guardHandle\('([^']+)'/g)].map((m) => m[1]);
const onCh = [...src.matchAll(/guardOn\('([^']+)'/g)].map((m) => m[1]);
const registered = new Set([...handleCh, ...onCh]);

const rawReg = [...src.matchAll(/ipcMain\.(?:on|handle)\('([^']+)'/g)].map((m) => m[1]);

/* Read-only channels: their data is already on-screen in every window
   (config echo, catalog, version) — documented exception, not an oversight. */
const READ_ONLY = new Set([
  'config:get', 'autostart:get', 'sys:catalog', 'apps:list',
  'app:version', 'env:get', 'welcome:info',
]);
/* Deliberately ungated fire-and-forget diagnostics (crash-time logs must
   survive page teardown); payload is clamped inside the logger. */
const UNGATED_BY_DESIGN = new Set(['log:line']);

test('every registered channel is frame-gated or explicitly read-only', () => {
  assert.ok(registered.size >= 25, `expected the full channel set, saw ${registered.size}`);
  for (const ch of registered) {
    assert.ok(gated.has(ch) || READ_ONLY.has(ch) || UNGATED_BY_DESIGN.has(ch),
      `ungated side-effect channel: ${ch}`);
  }
});

test('the PRIVILEGED map has no orphan entries and no empty owner lists', () => {
  for (const [ch, owners] of gated) {
    assert.ok(registered.has(ch), `PRIVILEGED lists ${ch}, which is never registered`);
    assert.ok(owners.length > 0, `${ch} must name at least one owner page`);
    for (const o of owners) assert.ok(['settings', 'wheel', 'welcome'].includes(o), `${ch}: unknown page ${o}`);
  }
});

test('the only raw (un-guarded) registration is log:line', () => {
  assert.deepEqual(rawReg, ['log:line']);
});

test('side-effect surfaces sit on their legitimate pages only', () => {
  // Privileged writes stay settings-only...
  for (const ch of ['config:set', 'config:flush', 'config:import', 'config:reset',
    'autostart:set', 'dialog:pick-file', 'action:preview', 'icons:add-url', 'icons:pick-image'])
    assert.deepEqual(gated.get(ch), ['settings'], `${ch} owner drift`);
  // ...welcome appears only where the FTU contract needs it.
  assert.deepEqual(gated.get('hotkey:set'), ['settings', 'welcome']);
  assert.deepEqual(gated.get('overlay:show'), ['settings', 'welcome']);
  assert.deepEqual(gated.get('welcome:done'), ['welcome']);
  // The overlay owns its geometry/click channels; it may resolve art
  // (icons:data-url) but nothing else from the settings family.
  assert.deepEqual(gated.get('wheel:segment-click'), ['wheel']);
  assert.deepEqual(gated.get('wheel:dismiss'), ['wheel']);
  assert.deepEqual(gated.get('wheel:grow'), ['wheel']);
  assert.deepEqual(gated.get('icons:data-url'), ['settings', 'wheel']);
});

test('the gate itself is intact (frameOn match + refused() invoke shape)', () => {
  assert.match(src, /ev\.senderFrame && ev\.senderFrame\.url/, 'frameOn reads senderFrame.url');
  assert.match(src, /u\.includes\('\/renderer\/' \+ n \+ '\/'\)/, 'frameOn matches /renderer/<page>/');
  assert.match(src, /SEND_CHANNELS\.has\(ch\) \? undefined : \{ ok: false, error: 'untrusted frame' \}/,
    'gated invoke channels must answer {ok:false}, never undefined');
});

test('SEND_CHANNELS covers exactly the fire-and-forget on-channels', () => {
  const block = src.match(/const SEND_CHANNELS = new Set\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'SEND_CHANNELS set must exist');
  const set = new Set([...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...set].sort(), [...onCh].sort(),
    'every ipcMain.on channel must be in SEND_CHANNELS (and no invoke channel may leak in)');
});
