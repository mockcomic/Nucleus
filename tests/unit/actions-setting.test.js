'use strict';
/* type: 'setting' dispatch: executeAction delegates to ctx.applySetting —
   the mutator lives with the store (ipc.js), so a call path without the hook
   fails closed and no config ever moves. */
const test = require('node:test');
const assert = require('node:assert/strict');

const actionsPath = require.resolve('../../src/main/actions.js');
delete require.cache[actionsPath];
const { executeAction } = require(actionsPath);

test('setting items call ctx.applySetting with the configured id', async () => {
  const calls = [];
  await executeAction({ type: 'setting', value: 'toggle_wheel_sound' },
    { applySetting: async (id) => { calls.push(id); } });
  assert.deepEqual(calls, ['toggle_wheel_sound']);
});

test('an empty setting value rejects before the hook runs', async () => {
  let hits = 0;
  await assert.rejects(() => executeAction({ type: 'setting', value: '  ' },
    { applySetting: async () => { hits++; } }), /no setting configured/);
  assert.equal(hits, 0);
  await assert.rejects(() => executeAction({ type: 'setting' },
    { applySetting: async () => { hits++; } }), /no setting configured/);
  assert.equal(hits, 0);
});

test('a path without the applySetting hook fails closed', async () => {
  await assert.rejects(() => executeAction({ type: 'setting', value: 'toggle_labels' }, {}),
    /app settings are unavailable here/);
  await assert.rejects(() => executeAction({ type: 'setting', value: 'toggle_labels' }),
    /app settings are unavailable here/);
});

test('hook failures propagate (the wheel shows the balloon)', async () => {
  await assert.rejects(() => executeAction({ type: 'setting', value: 'bogus_id' },
    { applySetting: async (id) => { throw new Error(`unknown setting '${id}'`); } }),
    /unknown setting 'bogus_id'/);
});
