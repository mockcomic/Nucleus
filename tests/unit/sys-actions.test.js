'use strict';
/* The expanded sys catalog: every catalog id must actually route (run() with
   stubbed electron/child_process/macro never throws "unknown system action"),
   the spawn/chord/VK targets are pinned per action, and the bookkeeping sets
   (KEY_ACTIONS, ALIAS) stay consistent with CATALOG — ipc.js relies on
   KEY_ACTIONS being exactly the injected-keys actions. Per test-bootstrap,
   the REAL macro module is loaded first only for vkFor (pure), so chord
   tokens are validated against the actual key tables. */
const test = require('node:test');
const assert = require('node:assert/strict');

const realMacro = require('../../src/main/macro.js');   // koffi load is guarded; ok without FFI

/* ---- electron stub: record ShellExecute traffic ---- */
const shell = { opened: [], external: [] };
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => require('node:os').tmpdir() },
    shell: {
      openPath: async (p) => { shell.opened.push(p); return ''; },
      openExternal: async (u) => { shell.external.push(u); return ''; },
      showItemInFolder: () => {}
    }
  }
};

/* ---- child_process stub: record spawns, resolve like a real 'spawn' event ---- */
const spawned = [];
const cpPath = require.resolve('child_process');
require.cache[cpPath] = {
  id: cpPath, filename: cpPath, loaded: true,
  exports: {
    spawn: (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref() {}, once: (ev, cb) => { if (ev === 'spawn') setImmediate(cb); } };
    }
  }
};

/* ---- macro stub: record injections instead of touching SendInput ---- */
const chords = [];
const vks = [];
const macroPath = require.resolve('../../src/main/macro.js');
require.cache[macroPath] = {
  id: macroPath, filename: macroPath, loaded: true,
  exports: {
    available: false, loadError: 'stubbed', sendMacro: async () => {},
    sendVk: async (vk) => { vks.push(vk); },
    sendChord: async (tokens) => { chords.push(tokens); },
    isDown: () => false, vkFor: realMacro.vkFor,
    ffi: { available: false, loadError: 'stubbed', declareUser32: () => { throw new Error('stub'); } }
  }
};

/* ---- audio stub: the device actions must not reach COM in a unit test ----
   (tests run on real machines; audio.js talks to the live audio stack.) */
const audioCalls = [];
let audioResult = { ok: true };
const audioPath = require.resolve('../../src/main/audio.js');
require.cache[audioPath] = {
  id: audioPath, filename: audioPath, loaded: true,
  exports: {
    listDevices: (flow) => { audioCalls.push({ fn: 'listDevices', flow }); return { ok: true, devices: [] }; },
    setDefaultDevice: (flow, id) => { audioCalls.push({ fn: 'setDefaultDevice', flow, id }); return { ...audioResult }; },
    getLevels: () => ({ ok: true, volume: 0, muted: false }),
    setLevels: () => ({ ok: true }),
    listSessions: () => ({ ok: true, sessions: [] }),
    setSession: () => ({ ok: true }),
    available: () => ({ ok: true })
  }
};

const sys = require('../../src/main/sys.js');

const reset = () => {
  shell.opened.length = 0; shell.external.length = 0; spawned.length = 0;
  chords.length = 0; vks.length = 0; audioCalls.length = 0; audioResult = { ok: true };
};

/* ---- catalog bookkeeping ---- */
test('catalog ids are unique', () => {
  assert.equal(new Set(sys.CATALOG.map((c) => c.id)).size, sys.CATALOG.length);
});

test('every catalog id is executable (routes in run, no unknown-action throw)', async () => {
  for (const c of sys.CATALOG) {
    reset();
    await sys.run(c.id, { quit: () => {} }, {});
  }
});

test('KEY_ACTIONS contains only real catalog ids', () => {
  for (const id of sys.KEY_ACTIONS) assert.ok(sys.IDS.has(id), `KEY_ACTIONS has stray '${id}'`);
});

test('every injected-keys action is in KEY_ACTIONS, no spawner is', async () => {
  // Drift guard for the ipc.js focus-regain wait: the set must list exactly
  // the ids whose case injects keys (the stub records those in chords/vks).
  for (const c of sys.CATALOG) {
    reset();
    const ctx = { quit: () => {} };
    const p = String(c.id).toLowerCase();
    const key = sys.ALIAS[p] || p;
    if (!['screenshot', 'show_desktop', 'clipboard_history', 'emoji_picker', 'mute',
      'volume_up', 'volume_down', 'play_pause', 'next_track', 'prev_track',
      'action_center', 'run_dialog', 'task_view', 'snap_layouts', 'minimize_windows',
      'project', 'desktop_left', 'desktop_right'].includes(key)) continue;
    await sys.run(c.id, ctx, {});
    assert.ok(chords.length + vks.length > 0, `${c.id} should inject keys`);
    assert.ok(sys.KEY_ACTIONS.has(key), `${c.id} missing from KEY_ACTIONS`);
  }
  for (const id of ['volume_mixer', 'this_pc', 'control_panel', 'device_manager', 'services',
    'screen_keyboard', 'magnifier', 'hibernate', 'restart', 'shutdown', 'sign_out', 'sleep', 'lock',
    'set_output_device', 'set_input_device']) {
    reset();
    await sys.run(id, { quit: () => {} }, {});
    assert.equal(chords.length + vks.length, 0, `${id} must not inject keys`);
  }
});

test('aliases all resolve to catalog ids', () => {
  for (const [alias, id] of Object.entries(sys.ALIAS)) {
    assert.ok(sys.IDS.has(id), `alias '${alias}' points at missing id '${id}'`);
  }
});

test('an unknown id still throws the loud unknown-action error', async () => {
  await assert.rejects(() => sys.run('not_an_action'), /unknown system action/);
});

/* ---- routing pins for the new actions ---- */
async function routed(id) { reset(); await sys.run(id, { quit: () => {} }, {}); }

test('volume mixer opens the classic sndvol.exe app', async () => {
  await routed('volume_mixer');
  assert.deepEqual(spawned.map((s) => s.cmd), ['sndvol.exe']);
  assert.deepEqual(chords, []); assert.deepEqual(vks, []);
});

test('media keys use the consumer VK codes', async () => {
  await routed('play_pause'); assert.deepEqual(vks, [0xB3]);
  await routed('next_track'); assert.deepEqual(vks, [0xB0]);
  await routed('prev_track'); assert.deepEqual(vks, [0xB1]);
});

test('window-management chords are what the keys actually do', async () => {
  await routed('action_center'); assert.deepEqual(chords, [['win', 'a']]);
  await routed('task_view'); assert.deepEqual(chords, [['win', 'tab']]);
  await routed('snap_layouts'); assert.deepEqual(chords, [['win', 'z']]);
  await routed('minimize_windows'); assert.deepEqual(chords, [['win', 'm']]);
  await routed('project'); assert.deepEqual(chords, [['win', 'p']]);
  await routed('run_dialog'); assert.deepEqual(chords, [['win', 'r']]);
  await routed('desktop_left'); assert.deepEqual(chords, [['ctrl', 'win', 'left']]);
  await routed('desktop_right'); assert.deepEqual(chords, [['ctrl', 'win', 'right']]);
});

test('every chord token is synthesizable by the real macro key tables', async () => {
  for (const c of sys.CATALOG) {
    reset();
    await sys.run(c.id, { quit: () => {} }, {});
    for (const tokens of chords) for (const t of tokens) realMacro.vkFor(t);  // throws if unsupportable
  }
});

test('.msc snap-ins go through mmc.exe, snap-ins are not spawned directly', async () => {
  await routed('device_manager');
  assert.deepEqual(spawned, [{ cmd: 'mmc.exe', args: ['devmgmt.msc'], opts: { detached: true, stdio: 'ignore', windowsHide: true } }]);
  await routed('services');
  assert.deepEqual(spawned.map((s) => [s.cmd, s.args]), [['mmc.exe', ['services.msc']]]);
});

test('shutdown and restart carry a 15 s cancel window; hibernate and sign-out are direct', async () => {
  await routed('shutdown');
  assert.deepEqual(spawned[0].args.slice(0, 4), ['/s', '/t', '15', '/c']);
  await routed('restart');
  assert.deepEqual(spawned[0].args.slice(0, 4), ['/r', '/t', '15', '/c']);
  await routed('hibernate');
  assert.deepEqual(spawned[0].args, ['/h']);
  await routed('sign_out');
  assert.deepEqual(spawned[0].args, ['/l']);
});

test('settings-family actions route to their ms-settings URIs', async () => {
  const want = {
    windows_update: 'ms-settings:windowsupdate',
    installed_apps: 'ms-settings:appsfeatures',
    default_apps: 'ms-settings:defaultapps',
    storage: 'ms-settings:storagesense',
    privacy: 'ms-settings:privacy',
    game_bar: 'ms-settings:gaming-gamebar'
  };
  for (const [id, uri] of Object.entries(want)) {
    await routed(id);
    assert.deepEqual(shell.external, [uri], id);
  }
});

test('this_pc uses the MyComputerFolder shell verb', async () => {
  await routed('this_pc');
  assert.deepEqual(shell.opened, ['shell:MyComputerFolder']);
});

test('alias forms execute the same action (volmixer, taskview)', async () => {
  await routed('volmixer');
  assert.deepEqual(spawned.map((s) => s.cmd), ['sndvol.exe']);
  await routed('taskview');
  assert.deepEqual(chords, [['win', 'tab']]);
});

/* ---- device-bound audio actions ---- */
test('set_output_device / set_input_device route flow + bound id to the audio layer', async () => {
  const id = '{0.0.0.00000000}.{deadbeef-0000-0000-0000-000000000000}';
  reset();
  await sys.run('set_output_device', {}, { dir: id });
  assert.deepEqual(audioCalls, [{ fn: 'setDefaultDevice', flow: 'render', id }]);
  reset();
  await sys.run('set_input_device', {}, { dir: id });
  assert.deepEqual(audioCalls, [{ fn: 'setDefaultDevice', flow: 'capture', id }]);
  // The wheel-side aliases reach the same two routes.
  reset();
  await sys.run('setout', {}, { dir: id });
  await sys.run('setin', {}, { dir: id });
  assert.deepEqual(audioCalls.map((c) => c.flow), ['render', 'capture']);
});

test('device actions are not key-injections (no focus-wait, no SendInput)', () => {
  assert.ok(!sys.KEY_ACTIONS.has('set_output_device'));
  assert.ok(!sys.KEY_ACTIONS.has('set_input_device'));
});

test('a device switch failure surfaces as a thrown Error (balloon path)', async () => {
  audioResult = { ok: false, error: 'Windows refused the switch' };
  await assert.rejects(
    () => sys.run('set_output_device', {}, { dir: '{0.0.0.00000000}.{x}' }),
    /Windows refused the switch/
  );
});

test('device catalog entries carry hasDevice and reuse explorer\'s dir slot', () => {
  const out = sys.CATALOG.find((c) => c.id === 'set_output_device');
  const in_ = sys.CATALOG.find((c) => c.id === 'set_input_device');
  assert.equal(out.hasDevice, 'render');
  assert.equal(in_.hasDevice, 'capture');
  assert.equal(out.group, 'Audio');
  assert.ok(!out.hasDir && !in_.hasDir);   // the two dir namespaces never mix
});
