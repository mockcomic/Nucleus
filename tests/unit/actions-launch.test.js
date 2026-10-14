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
const { executeAction, quoteCmdArg, startCommand } = require(actionsPath);

const cmdLine = (call) => (call && call.args || []).join(' ');
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

  const appCall = calls.find((c) => cmdLine(c).includes('radial-wheel-missing-app'));
  assert.ok(appCall, 'a name that is not a file should still be spawned');
  assert.equal(appCall.cmd, 'cmd.exe');
  assert.deepEqual(appCall.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(appCall.args[3], startCommand('radial-wheel-missing-app', []));
  assert.equal(appCall.opts.windowsVerbatimArguments, true);
  assert.notEqual(appCall.opts.shell, true);

  const psCall = calls.find((c) => cmdLine(c).includes(ps1));
  assert.ok(psCall, 'the ps1 path should spawn powershell via start');
  assert.match(cmdLine(psCall), /-File/);
  assert.equal(cmdLine(psCall).includes('-ExecutionPolicy'), false);
  assert.equal(cmdLine(psCall).includes('Bypass'), false);
  assert.equal(psCall.opts.windowsVerbatimArguments, true);
});

test('cmd start quotes & and % so they cannot split the command', async () => {
  assert.equal(quoteCmdArg('C:\\A&B\\app.exe'), '"C:\\A&B\\app.exe"');
  assert.equal(quoteCmdArg('100%done'), '"100"%"done"');
  assert.equal(quoteCmdArg('say "hi"'), '"say ""hi"""');
  assert.throws(() => quoteCmdArg('a\nb'), /newline/);

  const before = calls.length;
  await executeAction({ type: 'app', value: 'C:\\A&B\\tool.lnk', args: 'foo&calc' });
  await executeAction({ type: 'app', value: '100%done' });
  const amp = calls[before];
  const pct = calls[before + 1];
  assert.equal(amp.cmd, 'cmd.exe');
  assert.equal(amp.args[3], startCommand('C:\\A&B\\tool.lnk', ['foo&calc']));
  assert.equal(amp.opts.windowsVerbatimArguments, true);
  assert.equal(pct.args[3], 'start "" "100"%"done"');
  await assert.rejects(() => executeAction({ type: 'app', value: 'notepad\r\ncalc' }), /newline/);
});

test('container segments refuse to launch — folder, recent, and the mixer card alike', async () => {
  const before = calls.length;                       // the first test already spawned twice
  for (const type of ['folder', 'recent', 'mixer']) {
    await assert.rejects(
      () => executeAction({ id: 'x', type, value: 'anything' }),
      /cannot be launched/,
      `a ${type} segment must never execute`
    );
  }
  assert.equal(calls.length, before, 'the refusals spawned nothing');
});
