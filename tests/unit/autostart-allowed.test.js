'use strict';
/* Installed-copy gate + ownership-verified disable for the login item.
   Electron is stubbed; nothing writes HKCU and nothing inspects the real
   execPath's directory except the helper that is pointed at a temp folder.
   The Run-value reader is injected (_setRunValueReader), so the disable paths
   exercise the real decision logic without touching the registry. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const calls = [];
const fakeApp = {
  isPackaged: false,
  setLoginItemSettings: (opts) => { calls.push(opts); },
  getLoginItemSettings: () => ({ openAtLogin: false })
};
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: fakeApp }
};
const autoPath = require.resolve('../../src/main/autostart.js');
delete require.cache[autoPath];
const {
  allowsLoginItem, hasUninstallerBeside, set, allowed,
  expectedRunCommand, runEntryBelongsToExe, _setRunValueReader
} = require(autoPath);

const EXE = process.execPath;
const ARGS = ['--hidden'];

/* Reader factory: valueName -> {state,...}. Absent unless listed. */
function readerWith(values) {
  return (name) => (Object.prototype.hasOwnProperty.call(values, name)
    ? values[name]
    : { state: 'absent' });
}
function useValues(values) { _setRunValueReader(readerWith(values)); }
function readFailReader() { return () => ({ state: 'error', code: 'boom' }); }

test.afterEach(() => _setRunValueReader(null));

test('allowsLoginItem requires a packaged install, an uninstaller, and no portable marker', () => {
  assert.equal(allowsLoginItem({ packaged: true, portableFile: undefined, hasUninstaller: true }), true);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: '', hasUninstaller: true }), true);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: 'C:\\Downloads\\Nucleus-1.0.0-portable.exe', hasUninstaller: true }), false);
  assert.equal(allowsLoginItem({ packaged: false, portableFile: undefined, hasUninstaller: true }), false);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: undefined, hasUninstaller: false }), false);
});

test('hasUninstallerBeside matches "Uninstall <product>.exe" only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-uninst-'));
  const exe = path.join(dir, 'Nucleus.exe');
  fs.writeFileSync(exe, '');
  try {
    assert.equal(hasUninstallerBeside(exe), false);
    fs.writeFileSync(path.join(dir, 'Uninstall Nucleus.exe'), '');
    assert.equal(hasUninstallerBeside(exe), true);
    fs.unlinkSync(path.join(dir, 'Uninstall Nucleus.exe'));
    fs.writeFileSync(path.join(dir, 'uninstall.exe'), '');
    assert.equal(hasUninstallerBeside(exe), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('expectedRunCommand quotes the exe path and appends args', () => {
  assert.equal(expectedRunCommand('C:\\Dir\\Nucleus.exe', ARGS), '"C:\\Dir\\Nucleus.exe" --hidden');
  assert.equal(expectedRunCommand('C:\\Dir\\app.exe', []), '"C:\\Dir\\app.exe"');
  assert.equal(expectedRunCommand('C:\\a.exe', ['plain', 'a b']), '"C:\\a.exe" plain "a b"');
});

test('runEntryBelongsToExe accepts every form our writes can take', () => {
  assert.equal(runEntryBelongsToExe(`"${EXE}" --hidden`, EXE, ARGS), true);
  assert.equal(runEntryBelongsToExe(`"${EXE}"`, EXE, ARGS), true,              // bare exe, no args
  );
  assert.equal(runEntryBelongsToExe(EXE + ' --hidden', EXE, ARGS), true,       // legacy unquoted
  );
  assert.equal(runEntryBelongsToExe(EXE, EXE, ARGS), true,                     // legacy unquoted bare
  );
  assert.equal(runEntryBelongsToExe(`"${EXE.toLowerCase()}" --hidden`, EXE, ARGS), true, // case-insensitive
  );
  assert.equal(runEntryBelongsToExe(`  "${EXE}"   --hidden  `, EXE, ARGS), true,          // whitespace-tolerant
  );
});

test('runEntryBelongsToExe rejects entries owned by another executable', () => {
  const other = 'C:\\Users\\me\\AppData\\Local\\Programs\\nucleus\\Nucleus.exe';
  assert.equal(runEntryBelongsToExe(`"${other}" --hidden`, EXE, ARGS), false);
  assert.equal(runEntryBelongsToExe('"C:\\Other\\thing.exe" --hidden', EXE, ARGS), false);
  assert.equal(runEntryBelongsToExe('', EXE, ARGS), false);
  assert.equal(runEntryBelongsToExe(null, EXE, ARGS), false);
  assert.equal(runEntryBelongsToExe(`"${EXE}" --hidden`, '', ARGS), false);
  // A prefix of our path is NOT our path (directory-neighbor trap).
  assert.equal(runEntryBelongsToExe(`"${EXE}two" --hidden`, EXE, ARGS), false);
});

test('set(true) does not write a login item unless this process is an installed copy', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  assert.equal(allowed(), false);
  const refused = set(true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /installed app/);
  assert.equal(calls.length, 0, 'refusing startup must not touch the registry');
});

test('set(false) from a non-installed copy does NOT delete a foreign login item', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  // The installed copy's entry, sitting under the SAME value name we share.
  useValues({ 'local.nucleus': { state: 'value', data: '"C:\\Installed\\Nucleus.exe" --hidden' } });
  const r = set(false);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'foreign');
  assert.equal(calls.length, 0, 'a value owned by another exe must survive this launch');
});

test('set(false) skips silently when no value exists', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  useValues({});
  const r = set(false);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'absent');
  assert.equal(calls.length, 0);
});

test('set(false) FAILS CLOSED when the value cannot be read', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  _setRunValueReader(readFailReader());
  const r = set(false);
  assert.equal(r.ok, true);
  assert.equal(r.skipped, 'unverified');
  assert.equal(calls.length, 0, 'unknown must never turn into a delete');
});

test('set(false) deletes only the value whose command line is our own exe', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  // Reader models the registry honestly: the value exists until the fake
  // setLoginItemSettings records a delete for that name.
  _setRunValueReader((name) => (name === 'local.nucleus' &&
    !calls.some((c) => c.openAtLogin === false && c.name === name)
    ? { state: 'value', data: `"${EXE}" --hidden` }
    : { state: 'absent' }));
  const origLen = calls.length;
  const r = set(false);
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(calls.length, origLen + 1, 'one delete, for our own value only');
  assert.equal(calls[origLen].openAtLogin, false);
  assert.equal(calls[origLen].name, 'local.nucleus');
});

test('set(true) from the installed copy writes the AUMID entry and verifies by read-back', () => {
  calls.length = 0;
  fakeApp.isPackaged = true;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  // Pretend an uninstaller sits beside THIS exe so allowed() passes without
  // depending on the real execPath's directory.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-inst-'));
  const exe = path.join(dir, 'Nucleus.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'Uninstall Nucleus.exe'), '');
  const realExec = Object.getOwnPropertyDescriptor(process, 'execPath');
  Object.defineProperty(process, 'execPath', { value: exe, configurable: true });
  try {
    assert.equal(allowed(), true);
    // The write "succeeds": the AUMID value now holds the exact expected command.
    useValues({ 'local.nucleus': { state: 'value', data: `"${exe}" --hidden` } });
    const r = set(true);
    assert.equal(r.ok, true);
    assert.equal(r.enabled, true);
    assert.equal(r.verified, true, 'read-back of the exact command is the verification');
    const w = calls.filter((c) => c.openAtLogin === true);
    assert.equal(w.length, 1);
    assert.equal(w[0].path, exe);
    assert.deepEqual(w[0].args, ARGS);
  } finally {
    Object.defineProperty(process, 'execPath', realExec);
    _setRunValueReader(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set(true) cleans an orphaned Radial Wheel login item when enabling', () => {
  calls.length = 0;
  fakeApp.isPackaged = true;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-inst-'));
  const exe = path.join(dir, 'Nucleus.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'Uninstall Nucleus.exe'), '');
  const realExec = Object.getOwnPropertyDescriptor(process, 'execPath');
  Object.defineProperty(process, 'execPath', { value: exe, configurable: true });
  try {
    const gone = path.join(dir, 'Radial Wheel.exe');           // never created — the upgrade deleted it
    _setRunValueReader((name) => {
      if (name === 'local.nucleus' && !calls.some((c) => c.openAtLogin === false && c.name === name))
        return { state: 'value', data: `"${exe}" --hidden` };
      if (name === 'local.radialwheel' && !calls.some((c) => c.openAtLogin === false && c.name === name))
        return { state: 'value', data: `"${gone}" --hidden` };
      return { state: 'absent' };
    });
    const r = set(true);
    assert.equal(r.ok, true);
    assert.equal(r.verified, true);
    assert.ok(calls.some((c) => c.openAtLogin === false && c.name === 'local.radialwheel'),
      'the orphan under the legacy name is removed');
    assert.ok(!calls.some((c) => c.openAtLogin === false && c.name === 'local.nucleus'),
      'the live value is never touched by the cleanup');
  } finally {
    Object.defineProperty(process, 'execPath', realExec);
    _setRunValueReader(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set(true) leaves a still-existing Radial Wheel login item alone', () => {
  calls.length = 0;
  fakeApp.isPackaged = true;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-inst-'));
  const exe = path.join(dir, 'Nucleus.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'Uninstall Nucleus.exe'), '');
  const oldAlive = path.join(dir, 'Radial Wheel.exe');         // old copy still on disk
  fs.writeFileSync(oldAlive, '');
  const realExec = Object.getOwnPropertyDescriptor(process, 'execPath');
  Object.defineProperty(process, 'execPath', { value: exe, configurable: true });
  try {
    useValues({
      'local.nucleus': { state: 'value', data: `"${exe}" --hidden` },
      'local.radialwheel': { state: 'value', data: `"${oldAlive}" --hidden` }
    });
    const r = set(true);
    assert.equal(r.ok, true);
    assert.ok(!calls.some((c) => c.openAtLogin === false && c.name === 'local.radialwheel'),
      'an entry whose exe still exists belongs to the old copy, not us');
  } finally {
    Object.defineProperty(process, 'execPath', realExec);
    _setRunValueReader(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set(true) reports verified:false when the read-back disagrees', () => {
  calls.length = 0;
  fakeApp.isPackaged = true;
  delete process.env.PORTABLE_EXECUTABLE_FILE;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-inst-'));
  const exe = path.join(dir, 'Nucleus.exe');
  fs.writeFileSync(exe, '');
  fs.writeFileSync(path.join(dir, 'Uninstall Nucleus.exe'), '');
  const realExec = Object.getOwnPropertyDescriptor(process, 'execPath');
  Object.defineProperty(process, 'execPath', { value: exe, configurable: true });
  try {
    // Something else owns the value — the write did not take (or was raced).
    useValues({ 'local.nucleus': { state: 'value', data: '"C:\\Somewhere\\Else.exe" --hidden' } });
    const r = set(true);
    assert.equal(r.ok, true);
    assert.equal(r.verified, false);
  } finally {
    Object.defineProperty(process, 'execPath', realExec);
    _setRunValueReader(null);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
