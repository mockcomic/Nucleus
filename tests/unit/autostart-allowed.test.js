'use strict';
/* Installed-copy gate for the login item. Electron is stubbed; nothing writes
   HKCU and nothing inspects the real execPath's directory except the helper
   that is pointed at a temp folder. */
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
const { allowsLoginItem, hasUninstallerBeside, set, allowed } = require(autoPath);

test('allowsLoginItem requires a packaged install, an uninstaller, and no portable marker', () => {
  assert.equal(allowsLoginItem({ packaged: true, portableFile: undefined, hasUninstaller: true }), true);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: '', hasUninstaller: true }), true);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: 'C:\\Downloads\\RadialWheel.exe', hasUninstaller: true }), false);
  assert.equal(allowsLoginItem({ packaged: false, portableFile: undefined, hasUninstaller: true }), false);
  assert.equal(allowsLoginItem({ packaged: true, portableFile: undefined, hasUninstaller: false }), false);
});

test('hasUninstallerBeside matches "Uninstall <product>.exe" only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-uninst-'));
  const exe = path.join(dir, 'Radial Wheel.exe');
  fs.writeFileSync(exe, '');
  try {
    assert.equal(hasUninstallerBeside(exe), false);
    fs.writeFileSync(path.join(dir, 'Uninstall Radial Wheel.exe'), '');
    assert.equal(hasUninstallerBeside(exe), true);
    fs.unlinkSync(path.join(dir, 'Uninstall Radial Wheel.exe'));
    fs.writeFileSync(path.join(dir, 'uninstall.exe'), '');
    assert.equal(hasUninstallerBeside(exe), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('set(true) does not write a login item unless this process is an installed copy', () => {
  calls.length = 0;
  fakeApp.isPackaged = false;
  assert.equal(allowed(), false);
  const refused = set(true);
  assert.equal(refused.ok, false);
  assert.match(refused.error, /installed app/);
  assert.equal(calls.length, 0, 'refusing startup must not touch the registry');
  const cleared = set(false);
  assert.equal(cleared.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].openAtLogin, false);
  assert.equal(calls[0].path, process.execPath, 'clearing removes only this exe');
});
