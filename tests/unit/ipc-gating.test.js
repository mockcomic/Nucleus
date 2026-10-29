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
  'config:get', 'autostart:get', 'sys:catalog', 'appsettings:catalog', 'apps:list',
  'app:version', 'env:get', 'welcome:info',
  // Audio reads are catalog-class: endpoint ids/names and levels are exactly
  // what the Settings screen shows; the writers are PRIVILEGED-gated.
  'audio:available', 'audio:devices', 'audio:levels', 'audio:sessions',
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
    'autostart:set', 'dialog:pick-file', 'action:preview', 'icons:add-url', 'icons:pick-image',
    'config:export-bundle', 'usage:clear',
    // The stats panel reads the private sidecar and the backup pair reaches into
    // userData — none of that belongs to the overlay or the FTU page.
    'usage:stats', 'config:backups', 'config:restore-backup',
    // The update channels reach the network, the browser, the Downloads folder
    // and the installer process through main — Settings-only like every other
    // writer (the tray never uses IPC). update:install carries no argument:
    // the page can re-ask main's prompt, never name a URL or a path.
    'update:state', 'update:check', 'update:open-release', 'update:install'])
    assert.deepEqual(gated.get(ch), ['settings'], `${ch} owner drift`);
  // The mixer card's default-device pickers switch SYSTEM policy from the
  // overlay, so audio:set-default joined the two level writers on the wheel
  // frame. Like them it is a reviewed security decision, not a refactor:
  // arguments are clamped in main/audio.js (sanitizeDeviceId / parseFlow) and
  // main verifies the switch by reading the default back before claiming ok.
  assert.deepEqual(gated.get('audio:set-default'), ['settings', 'wheel'], 'mixer card device picker');
  // ...the wheel's volume-mixer card may drag levels, so the two level writers
  // gained the wheel frame deliberately (arguments clamped in main/audio.js).
  // An owner-list change here is a security decision, not a refactor.
  assert.deepEqual(gated.get('audio:set-volume'), ['settings', 'wheel'], 'mixer card contract');
  assert.deepEqual(gated.get('audio:set-session'), ['settings', 'wheel'], 'mixer card contract');
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
  assert.match(src, /protocol !== 'file:'/, 'frameOn accepts only file URLs');
  assert.match(src, /fileURLToPath/, 'frameOn resolves the file URL to a path');
  assert.match(src, /getAppPath\(\)/, 'frameOn compares against this app directory, not a URL substring');
  assert.doesNotMatch(src, /u\.includes\('\/renderer\/'/, 'a substring of the URL must not grant a page');
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

/* The dead-channel class: a bridge function pointing at a channel main never
   registers (or a typo in either name) is invisible until the button that
   calls it silently does nothing. Every channel the preload INVOKES or SENDS
   must exist in main; main→renderer pushes (overlay:show, config:changed,
   welcome:reset) are not preload calls, so they are out of scope here. */
test('every preload bridge names a channel main actually registers', () => {
  const preload = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'preload', 'index.js'), 'utf8');
  const used = new Set([
    ...[...preload.matchAll(/invoke\('([^']+)'/g)].map((m) => m[1]),
    // Both spellings: the preload's own `send(ch)` factory and ipcRenderer.send.
    ...[...preload.matchAll(/\bsend\('([^']+)'/g)].map((m) => m[1])
  ]);
  assert.ok(used.size >= 25, `expected the full bridge surface, saw ${used.size}`);
  for (const ch of used) {
    assert.ok(registered.has(ch) || gated.has(ch) || UNGATED_BY_DESIGN.has(ch),
      `preload calls '${ch}', which ipc.js never registers`);
  }
  // And the mirror direction: a privileged gate with no caller is dead weight.
  /* Grandfathered debt (flagged by the whole-tree audit, not yet built):
     'logs:tail' has a main-side handler + gate but no preload bridge or panel —
     the in-app log viewer is the open item. Delete an entry from this set only
     by giving the channel a caller; adding one needs a reason in the PR. */
  const PENDING_CONSUMER = new Set(['logs:tail']);
  for (const ch of gated.keys()) {
    if (READ_ONLY.has(ch) || UNGATED_BY_DESIGN.has(ch) || PENDING_CONSUMER.has(ch)) continue;
    assert.ok(used.has(ch), `ipc.js gates '${ch}' but no page ever calls it`);
  }
});
