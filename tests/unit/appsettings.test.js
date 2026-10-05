'use strict';
/* App-setting actions (type: 'setting'): the catalog is the sole execution
   gate (unknown/empty ids never reach the store), apply() toggles exactly
   one boolean per entry through store.set(), and a missing intermediate
   object (gameMode) is rebuilt in the shape validate() would produce.
   A fake store stands in for ConfigStore — no electron, no %APPDATA%. */
const test = require('node:test');
const assert = require('node:assert/strict');

const appsettings = require('../../src/main/appsettings.js');

const makeStore = (cfg) => ({
  cfg, sets: 0,
  get() { return this.cfg; },
  set(next) { this.sets++; this.cfg = next; return next; }
});

const deepGet = (o, path) => { for (const k of path) { o = o == null ? o : o[k]; } return o; };

/* A realistic validated-shaped config: every entry target present. */
const baseCfg = () => ({
  appearance: { showLabels: true },
  behavior: {
    wheelSound: false, markingSelect: true, typeToFilter: true,
    reTriggerToggles: true, dismissOnEscape: true, dismissOnRightClick: true,
    mouseClickThrough: false, focusExistingApp: false, profilesEnabled: false,
    autostart: true, gameMode: { enabled: false, apps: ['foo.exe'] }
  }
});

test('catalog ids are unique, well-shaped, and labelled', () => {
  const ids = appsettings.CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids unique');
  assert.ok(ids.length >= 12, 'the full toggle set is present');
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9_]{2,63}$/);
  for (const c of appsettings.CATALOG) {
    assert.ok(c.label, `${c.id} has a label`);
    assert.ok(c.group, `${c.id} has a group`);
  }
  for (const c of appsettings.CATALOG) assert.ok(appsettings.isKnown(c.id), `${c.id} known`);
});

test('apply() flips every catalog flag exactly once and flips back', async () => {
  for (const entry of appsettings.ENTRIES) {
    const store = makeStore(baseCfg());
    const before = deepGet(store.cfg, entry.path);
    const merged = await appsettings.apply(entry.id, store);
    assert.equal(store.sets, 1, `${entry.id}: one save`);
    assert.equal(deepGet(merged, entry.path), !before, `${entry.id}: toggled`);
    await appsettings.apply(entry.id, store);
    assert.equal(deepGet(store.cfg, entry.path), before, `${entry.id}: restored`);
    assert.equal(store.sets, 2, `${entry.id}: second toggle saved too`);
  }
});

test('toggling game mode preserves the apps list and other flags', async () => {
  const store = makeStore(baseCfg());
  const merged = await appsettings.apply('toggle_game_mode', store);
  assert.equal(merged.behavior.gameMode.enabled, true);
  assert.deepEqual(merged.behavior.gameMode.apps, ['foo.exe']);
  assert.equal(merged.behavior.markingSelect, true, 'untouched flags survive the clone');
  assert.equal(store.cfg.appearance.showLabels, true);
});

test('a missing gameMode parent is rebuilt in the validate() shape', async () => {
  const store = makeStore({ behavior: {} });
  const merged = await appsettings.apply('toggle_game_mode', store);
  assert.deepEqual(merged.behavior.gameMode, { enabled: true, apps: [] });
});

test('junk (non-true) flag values read false and toggle to true', async () => {
  for (const junk of ['yes', 1, {}, [], 'true', null]) {
    const store = makeStore({ behavior: { wheelSound: junk } });
    const merged = await appsettings.apply('toggle_wheel_sound', store);
    assert.equal(merged.behavior.wheelSound, junk === true ? false : true, String(junk));
  }
});

test('unknown or empty ids reject without ever touching the store', async () => {
  for (const bad of ['lock', 'sys_action', '', '   ', null, undefined, 'toggle_wheel_sound ', 'TOGGLE_WHEEL_SOUND']) {
    const store = makeStore(baseCfg());
    if (bad === 'toggle_wheel_sound ') {
      // Surrounding whitespace is tolerated (trimmed like every other value),
      // unlike case changes or unknown ids.
      await appsettings.apply(bad, store);
      assert.equal(store.sets, 1, 'trimmed id still applies');
      continue;
    }
    await assert.rejects(() => appsettings.apply(bad, store),
      (err) => /no setting configured|unknown setting/.test(err.message), String(bad));
    assert.equal(store.sets, 0, `${bad}: store untouched`);
  }
});

test('a store without get/set fails closed, not half-applied', async () => {
  for (const store of [null, undefined, {}, { get: () => ({}) }]) {
    await assert.rejects(() => appsettings.apply('toggle_wheel_sound', store),
      /app settings are unavailable here/);
  }
});

test('store.set throwing (disk refused) propagates to the caller', async () => {
  const store = makeStore(baseCfg());
  store.set = () => { throw new Error('could not save config (EBUSY)'); };
  await assert.rejects(() => appsettings.apply('toggle_wheel_sound', store), /EBUSY/);
});
