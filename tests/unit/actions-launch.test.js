'use strict';
/* Launch argv: an unresolved app name goes through `start`, and a .ps1 command
   segment does not pass -ExecutionPolicy Bypass. child_process.spawn is stubbed
   before actions.js is (re)loaded so nothing is actually started. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const calls = [];
const cpPath = require.resolve('child_process');
const savedCp = require.cache[cpPath];
const realCp = require('child_process');
require.cache[cpPath] = {
  id: cpPath, filename: cpPath, loaded: true,
  exports: {
    ...realCp,
    spawn(cmd, args, opts) {
      calls.push({ cmd, args: args || [], opts: opts || {} });
      const child = new EventEmitter();
      child.unref = () => {};
      process.nextTick(() => child.emit('spawn'));
      return child;
    }
  }
};

const actionsPath = require.resolve('../../src/main/actions.js');
delete require.cache[actionsPath];
const { executeAction } = require(actionsPath);
if (savedCp) require.cache[cpPath] = savedCp;
else delete require.cache[cpPath];

test('unresolved app names use cmd start, and ps1 scripts are not launched with Bypass', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-act-'));
  const ps1 = path.join(dir, 'hello.ps1');
  fs.writeFileSync(ps1, 'Write-Output hi\n');
  try {
    await executeAction({ type: 'app', value: 'radial-wheel-missing-app' });
    await executeAction({ type: 'command', value: ps1 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const appCall = calls.find((c) => c.args.includes('radial-wheel-missing-app'));
  assert.ok(appCall, 'a name that is not a file should still be spawned');
  assert.equal(appCall.cmd, 'cmd.exe');
  assert.ok(appCall.args.includes('start'));
  assert.notEqual(appCall.opts.shell, true);

  const psCall = calls.find((c) => c.args.includes(ps1));
  assert.ok(psCall, 'the ps1 path should spawn powershell via start');
  assert.ok(psCall.args.includes('-File'));
  assert.equal(psCall.args.includes('-ExecutionPolicy'), false);
  assert.equal(psCall.args.includes('Bypass'), false);
});
