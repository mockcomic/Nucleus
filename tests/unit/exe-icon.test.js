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

/* --------------------------- %VARIABLE% locations ---------------------------
   A .lnk stores its icon location unexpanded (%windir%\system32\Mycomput.dll,2
   is Computer Management) and the strict resource route has no shell to expand
   it for us, so expansion happens before the absolute-path rule — and a name
   the environment does not know refuses the candidate outright instead of
   quietly leaving a relative path behind. */
test('environment placeholders expand before the shape rules, unknown ones refuse', () => {
  const { programIconPath } = require('../../src/main/exe-icon');
  const windir = process.env.windir || process.env.SystemRoot;
  assert.equal(programIconPath('%windir%\\System32\\shell32.dll'), windir + '\\System32\\shell32.dll');
  assert.equal(programIconPath('%WINDIR%\\System32\\shell32.dll'), windir + '\\System32\\shell32.dll');
  assert.equal(programIconPath('"%ProgramFiles%\\App\\app.exe"'.replace('%ProgramFiles%', process.env.ProgramFiles)),
    process.env.ProgramFiles + '\\App\\app.exe');
  assert.equal(programIconPath('%DSH_NO_SUCH_VAR_9F2C%\\a\\app.exe'), null, 'unknown name refuses');
  assert.equal(programIconPath('C:\\a\\100%\\app.exe'), 'C:\\a\\100%\\app.exe', 'a lone % is an ordinary character');
});

/* ------------------------- the shortcut's icon position ----------------------
   A .lnk holds no icon resources of its own, so the link is unpacked and the
   position recorded with its icon location is what must be extracted:
   %windir%\system32\Mycomput.dll,2 is Computer Management, while index 0 of
   that DLL is a different picture entirely (measured: two different PNGs). An
   index that is not a plain in-range integer degrades to 0 — the first icon,
   which is what a link with no position at all means. */
test('icon positions are honoured, junk positions read as the first icon', () => {
  const { iconIndex } = require('../../src/main/exe-icon');
  assert.equal(iconIndex(0), 0);
  assert.equal(iconIndex(2), 2);
  assert.equal(iconIndex('167'), 167);
  for (const junk of [undefined, null, -1, 1.5, NaN, 'x', {}, [], 0x10000, -0])
    assert.equal(iconIndex(junk), 0, JSON.stringify(junk));
});

/* linkIconSource stats its candidates, so this needs one file that really
   exists; System32\shell32.dll is as close to a guarantee as Windows offers. */
const DLL = require('path').join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'shell32.dll');
const real = (p) => { try { return require('fs').statSync(p).isFile(); } catch { return false; }; };
test('a shortcut extracts from its own icon location, position and all',
  { skip: !real(DLL) && 'no shell32.dll to point at' }, () => {
  const { linkIconSource } = require('../../src/main/exe-icon');
  assert.deepEqual(linkIconSource({ icon: DLL, iconIndex: 2, target: 'C:\\nope\\gone.exe' }),
    { path: DLL, index: 2 });
  // position missing or junk → the first icon of the same file
  assert.deepEqual(linkIconSource({ icon: DLL, target: 'C:\\nope\\gone.exe' }), { path: DLL, index: 0 });
  assert.deepEqual(linkIconSource({ icon: DLL, iconIndex: 'x', target: 'C:\\nope\\gone.exe' }),
    { path: DLL, index: 0 });
  // icon location unusable → fall through to the target's first icon
  assert.deepEqual(linkIconSource({ icon: 'C:\\nope\\gone.ico', target: DLL }), { path: DLL, index: 0 });
  // the shape an administrative-tool shortcut really carries: unexpanded and
  // not at position 0 (both halves of that used to be dropped on the floor)
  assert.deepEqual(linkIconSource({ icon: '%windir%\\System32\\shell32.dll', iconIndex: 2 }),
    { path: DLL, index: 2 });
  // neither half names a file with an icon: no placeholder to fall back to now
  assert.equal(linkIconSource({ icon: 'C:\\nope\\gone.ico', target: 'C:\\nope\\gone.exe' }), null);
  assert.equal(linkIconSource({ icon: 'C:\\a\\note.txt', target: 'C:\\a\\note.txt' }), null);
  for (const junk of [null, undefined, 42, 'lnk', {}]) assert.equal(linkIconSource(junk), null);
});

