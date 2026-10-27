'use strict';
/* Program-icon gate (src/main/exe-icon.js). The renderer names a PATH to this
   channel (unlike icons:pick-image, where main owns the dialog), so the
   allow-list is the whole defence: absolute paths only, program extensions
   only, no shell path-expression characters. These are the pure shape checks
   — no Electron, no shell, no disk. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { programIconPath } = require('../../src/main/exe-icon');

test('absolute program paths are accepted, outer quotes stripped', () => {
  assert.equal(programIconPath('C:\\Program Files\\App\\app.exe'), 'C:\\Program Files\\App\\app.exe');
  assert.equal(programIconPath('"C:\\a\\app.exe"'), 'C:\\a\\app.exe');
  assert.equal(programIconPath('  C:\\a\\app.EXE  '), 'C:\\a\\app.EXE');
  assert.equal(programIconPath('D:/tools/app.lnk'), 'D:/tools/app.lnk');
  assert.ok(programIconPath('\\\\srv\\share\\app.dll'), 'UNC server share');
  assert.equal(programIconPath('\\srv\\share\\app.dll'), null, 'legacy single-backslash form');
  for (const ext of ['exe', 'lnk', 'dll', 'msi', 'ico'])
    assert.equal(programIconPath('C:\\a\\app.' + ext), 'C:\\a\\app.' + ext);
});

test('anything that is not exactly one program file is refused', () => {
  for (const bad of [
    null, undefined, 42, '', '   ',
    'app.exe',                                  // relative: resolves against main's cwd
    '.\\app.exe', '..', '~\\app.exe',
    'C:\\a\\app.txt', 'C:\\a\\app',              // not a program extension
    'C:\\a\\b*.exe',                            // wildcard
    'C:\\a\\b?.exe', 'C:\\a\\b"1.exe',           // path-expression / stray quote
    'C:\\a\\b\n.exe',                            // control char (newline form)
    'x'.repeat(5000) + '.exe'                    // absurd length
  ]) assert.equal(programIconPath(bad), null, JSON.stringify(bad));
});

test('fromPath answers the shared {ok:false, error} shape without a path', async () => {
  const exeIcon = require('../../src/main/exe-icon');
  const r = await exeIcon.fromPath('C:\\a\\app.txt');
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, 'string');
  assert.ok(r.error.length > 0);
});
