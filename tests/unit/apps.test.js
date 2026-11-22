/* src/main/apps.js parseUninstallDump — the registry arm of the installed-
   programs picker. Regression: reg.exe echoes queried keys under their FULL
   root name (HKCU\… prints as HKEY_CURRENT_USER\…), while the parser matched
   headers against the raw alias prefix. Every header failed the match, every
   value line was skipped, and the registry source returned zero apps in
   production while hand-written alias-headed fixtures would have passed. The
   fixtures below reproduce the real dump shape captured from reg.exe. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseUninstallDump, fullRoot } = require('../../src/main/apps.js');

const HKCU_ROOT = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const HKLM_WOW = 'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall';

/* ------------------------------ root alias ------------------------------ */

test('fullRoot expands the registry aliases reg.exe prints back', () => {
  assert.equal(fullRoot(HKCU_ROOT), 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  assert.equal(fullRoot(HKLM_WOW), 'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall');
  // Already-full and unrelated keys pass through untouched.
  assert.equal(fullRoot('HKEY_CURRENT_USER\\Foo'), 'HKEY_CURRENT_USER\\Foo');
  assert.equal(fullRoot('HKCC'), 'HKCC');                      // no trailing path: unchanged
});

/* ------------------------- real-shape dump fixtures ----------------------- */

const HKCU_DUMP = [
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\steam',
  '    DisplayName    REG_SZ    Steam',
  '    UninstallString    REG_SZ    "C:\\Program Files (x86)\\Steam\\uninstall.exe"',
  '    DisplayIcon    REG_SZ    C:\\Program Files (x86)\\Steam\\Steam.exe,0',
  '',
  'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\srm',
  '    DisplayName    REG_SZ    Steam ROM Manager',
  '    DisplayIcon    REG_SZ    C:\\Users\\me\\AppData\\Local\\Programs\\steam-rom-manager\\Uninstall Steam ROM Manager.exe',
  '',
  'End of search: 2 match(es) pressed.'
].join('\r\n');

test('parses DisplayName/DisplayIcon from the full-root headers reg.exe emits', () => {
  const rows = parseUninstallDump(HKCU_DUMP, HKCU_ROOT);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Steam');
  assert.equal(rows[0].DisplayIcon, 'C:\\Program Files (x86)\\Steam\\Steam.exe,0');
  assert.equal(rows[1].name, 'Steam ROM Manager');
});

test('a header from another root closes the current block (no value bleed)', () => {
  const out = [
    'HKEY_LOCAL_MACHINE\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\nvidiaProfile',
    '    DisplayName    REG_SZ    NVIDIA Profile',
    '    DisplayIcon    REG_SZ    C:\\Windows\\syswow64\\nvui.dll,0',
    'HKEY_LOCAL_MACHINE\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\other',
    '    DisplayName    REG_SZ    Wrong root',
    '',
    'End of search: 2 match(es) pressed.'
  ].join('\r\n');
  const rows = parseUninstallDump(out, HKLM_WOW);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'NVIDIA Profile');
});

test('the "unable to find" error footer yields no rows', () => {
  const out = 'ERROR: The system was unable to find the specified registry key or value.\r\n';
  assert.deepEqual(parseUninstallDump(out, HKCU_ROOT), []);
});

test('multi-line REG_MULTI_SZ continuation lines are tolerated, not entries', () => {
  // reg.exe prints blanked continuation cells for lists; the first line of a
  // blank value can arrive as spaces-only — whitespace-only lines must not
  // flip cur.
  const out = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\app',
    '    DisplayName    REG_SZ    App With List',
    '    RegOperation    REG_DWORD    0x0',
    '    InstallLocation    REG_SZ    ',
    '',
    'End of search: 1 match(es) pressed.'
  ].join('\r\n');
  const rows = parseUninstallDump(out, HKCU_ROOT);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'App With List');
  assert.equal(rows[0].InstallLocation, '');
});
