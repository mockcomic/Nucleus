'use strict';
/* The sys `explorer` action's optional Folder parameter (item.dir).
   Regression: launching `explorer.exe <path>` silently ignored the folder —
   Node quotes spaced arguments for CreateProcess and explorer.exe's own parser
   drops such a path (and any written with forward slashes) back to its default
   view. The action now goes through ShellExecute (shell.openPath), so these
   tests pin BOTH halves: the normalisation of what the user typed, and the
   routing (explorer.exe is never spawned with the path as an argument).
   electron / child_process / macro are stubbed per the test-bootstrap recipe. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* ---- electron stub: record ShellExecute traffic ---- */
const shell = { opened: [], revealed: [], external: [], openPathErr: '' };
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => os.tmpdir() },
    shell: {
      openPath: async (p) => { shell.opened.push(p); return shell.openPathErr; },
      openExternal: async (u) => { shell.external.push(u); return ''; },
      showItemInFolder: (p) => { shell.revealed.push(p); }
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

/* ---- macro stub: no koffi, no FFI in a unit run ---- */
const macroPath = require.resolve('../../src/main/macro.js');
require.cache[macroPath] = {
  id: macroPath, filename: macroPath, loaded: true,
  exports: {
    available: false, loadError: 'stubbed', sendMacro: async () => {}, sendVk: async () => {},
    sendChord: async () => {}, isDown: () => false, vkFor: () => 0,
    ffi: { available: false, loadError: 'stubbed', declareUser32: () => { throw new Error('stub'); } }
  }
};

const sys = require('../../src/main/sys.js');

const reset = () => {
  shell.opened.length = 0; shell.revealed.length = 0; shell.external.length = 0;
  shell.openPathErr = '';
  spawned.length = 0;
};

const home = os.homedir().replace(/[\\/]$/, '');
const run = (dir) => sys.run('explorer', {}, { dir });
const tmp = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/* ---- routing: the folder must reach ShellExecute, never an explorer.exe arg ---- */
test('a real folder opens through ShellExecute, not explorer.exe arguments', async () => {
  reset();
  const dir = tmp('rw-explorer-');
  try {
    await run(dir);
    assert.deepEqual(shell.opened, [dir]);
    assert.deepEqual(spawned, [], 'explorer.exe must not be spawned with the path as an argument');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a path containing spaces reaches ShellExecute unquoted', async () => {
  reset();
  const dir = tmp('rw explorer test');
  try {
    await run(dir);
    assert.equal(shell.opened.length, 1);
    assert.equal(shell.opened[0], dir);
    assert.ok(dir.includes(' '), 'fixture really has a space');
    assert.ok(!shell.opened[0].startsWith('"'), 'no wrapper quotes added');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty folder keeps the default view via explorer.exe with no arguments', async () => {
  reset();
  await run('');
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd, 'explorer.exe');
  assert.deepEqual(spawned[0].args, []);
  assert.deepEqual(shell.opened, []);
});

test('a caller that omits opts entirely (aliases, previews) behaves like empty', async () => {
  reset();
  await sys.run('explorer', {});
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0].args, []);
});

test('ShellExecute failures surface as an error instead of silent success', async () => {
  reset();
  const dir = tmp('rw-explorer-');
  shell.openPathErr = 'Access is denied.';
  try {
    await assert.rejects(() => run(dir), (e) => e.message.includes(dir) && e.message.includes('Access is denied.'));
  } finally {
    shell.openPathErr = '';
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ---- normalisation of what the Folder box accepts ---- */
test('forward slashes become backslashes; trailing separators are trimmed', async () => {
  reset();
  const dir = tmp('rw-explorer-fwd');
  const sub = path.join(dir, 'Sub Dir');
  fs.mkdirSync(sub);
  try {
    await run(dir.replace(/\\/g, '/') + '/Sub Dir/');
    assert.deepEqual(shell.opened, [sub]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('surrounding quotes pasted out of a shell are stripped', async () => {
  reset();
  const dir = tmp('rw-explorer-quoted');
  try {
    await run(`"${dir}"`);
    assert.deepEqual(shell.opened, [dir]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('%VARIABLES% are expanded, so %USERPROFILE%\\Documents works', () => {
  const temp = process.env.TEMP.replace(/[\\/]$/, '');
  assert.equal(sys.normalizeFolder('%TEMP%'), temp);
  assert.equal(sys.normalizeFolder('%TEMP%\\..'), temp + '\\..');
  // An unknown variable is left verbatim rather than blanking the path.
  assert.equal(sys.normalizeFolder('%RW_NO_SUCH_VAR_X%\\a'), path.win32.join(home, '%RW_NO_SUCH_VAR_X%', 'a'));
});

test('bare known-folder names and ~ resolve against the user profile', () => {
  assert.equal(sys.normalizeFolder('Downloads'), path.win32.join(home, 'Downloads'));
  assert.equal(sys.normalizeFolder('~/My Docs'), path.win32.join(home, 'My Docs'));
  assert.equal(sys.normalizeFolder('~'), home);
});

test('drive roots keep their separator after trimming', () => {
  assert.equal(sys.normalizeFolder('C:\\'), 'C:\\');
  assert.equal(sys.normalizeFolder('d:/'), 'd:\\');   // case is left as typed
});

test('shell: and ::{CLSID} verbs pass through untouched', async () => {
  reset();
  await run('shell:Downloads');
  assert.deepEqual(shell.opened, ['shell:Downloads']);
  reset();
  await run('::{645FF040-AD4A-11D0-BAB2-00A0C90ABE6F}');
  assert.deepEqual(shell.opened, ['::{645FF040-AD4A-11D0-BAB2-00A0C90ABE6F}']);
  assert.deepEqual(spawned, []);
});

test('a missing folder reports which one, instead of opening the default view', async () => {
  reset();
  const gone = path.win32.join(home, 'RadialWheelNoSuchFolder12345');
  await assert.rejects(() => run(gone), (e) => e.message === `folder not found: ${gone}`);
  assert.deepEqual(shell.opened, []);
  assert.deepEqual(spawned, []);
});

test('a file typed into the Folder box reveals it rather than launching it', async () => {
  reset();
  const dir = tmp('rw-explorer-file');
  const file = path.join(dir, 'notes.txt');
  fs.writeFileSync(file, 'x');
  try {
    await run(file);
    assert.deepEqual(shell.revealed, [file]);
    assert.deepEqual(shell.opened, [], 'must not ShellExecute the file itself');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('blank-ish dirs behave like empty', async () => {
  for (const d of ['   ', '""', "''", '', null, undefined]) {
    reset();
    await run(d);
    assert.equal(spawned.length, 1, `default view expected for ${JSON.stringify(d)}`);
    assert.deepEqual(spawned[0].args, [], `no path argument for ${JSON.stringify(d)}`);
  }
});
