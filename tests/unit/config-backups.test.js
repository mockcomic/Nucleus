'use strict';
/* Rolling config backups (src/main/config.js). Electron is stubbed via
   require-cache injection and every path is routed to a fresh mkdtemp dir, so
   the real %APPDATA%\Nucleus is never touched (test-bootstrap rule).
   init() arms an fs.watch, so anything that calls it closes the watcher. */
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-backup-'));
  const electronPath = require.resolve('electron');
  require.cache[electronPath] = {
    id: electronPath, filename: electronPath, loaded: true,
    exports: {
      app: { getPath: (k) => (k === 'userData' ? dir : os.tmpdir()), getAppPath: () => dir }
    }
  };
  delete require.cache[require.resolve('../../src/main/config.js')];
  const cfg = require('../../src/main/config.js');
  return { dir, ConfigStore: cfg.ConfigStore, backupName: cfg.backupName, MAX_BACKUPS: cfg.MAX_BACKUPS };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ------------------------------- backupName ------------------------------- */
test('backupName is sortable, tagged, and revision-stamped', () => {
  const { backupName } = freshStore();
  const name = backupName(new Date(2026, 9, 4, 6, 30, 15), 12, 'import');
  assert.equal(name, 'config-20261004-063015-import-r12.json');
  assert.equal(backupName(new Date(2026, 0, 2, 3, 4, 5), 0), 'config-20260102-030405-r0.json');
  // chronological order == lexicographic order, which is what prune/list rely on
  const early = backupName(new Date(2026, 0, 1, 1, 0, 0), 1, 'import');
  const late = backupName(new Date(2026, 0, 1, 1, 0, 1), 2, 'import');
  assert.ok([early, late].sort()[0] === early, `${early} must sort before ${late}`);
});

test('backupName sanitizes a caller-supplied reason to file-name-safe characters', () => {
  const { backupName } = freshStore();
  const d = new Date(2026, 9, 4, 6, 30, 15);
  assert.equal(backupName(d, 3, '../../evil'), 'config-20261004-063015-evil-r3.json');
  assert.equal(backupName(d, 3, 'C:\\Windows\\x.exe'), 'config-20261004-063015-cwindowsxexe-r3.json');
  assert.equal(backupName(d, 3, 'a'.repeat(40)), `config-20261004-063015-${'a'.repeat(12)}-r3.json`);
  assert.equal(backupName(d, 3, null), 'config-20261004-063015-r3.json');
  assert.doesNotThrow(() => backupName('not a date', 1, 'x'));   // falls back to now
});

/* -------------------------------- lifecycle -------------------------------- */
test('the first write creates config.json and keeps no backup', () => {
  const { dir, ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  assert.deepEqual(s.listBackups(), [], 'nothing was displaced yet');
});

test('a forced replace backs up the OUTGOING config, not the new one', () => {
  const { dir, ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());                                        // baseline: default hotkey
  const next = JSON.parse(JSON.stringify(s.get()));
  next.hotkey = 'ctrl+alt+j';
  s.set(next, { backup: 'force', reason: 'import' });

  const list = s.listBackups();
  assert.equal(list.length, 1);
  assert.match(list[0].name, /^config-\d{8}-\d{6}-import-r\d+\.json$/);
  assert.equal(list[0].name, path.basename(list[0].path));
  assert.ok(list[0].size > 0 && Number.isFinite(list[0].mtimeMs));

  const kept = readJson(list[0].path);
  assert.equal(kept.hotkey, 'ctrl+alt+space', 'the backup must hold the pre-replace config');
  assert.equal(readJson(path.join(dir, 'config.json')).hotkey, 'ctrl+alt+j', 'and the live file the new one');
});

test('ordinary saves are throttled — a typing burst does not fill the rotation', () => {
  const { ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  for (let i = 0; i < 20; i++) {
    const next = JSON.parse(JSON.stringify(s.get()));
    next.appearance.centerLabel = `label ${i}`;
    s.set(next);                                        // no force → throttle applies
  }
  assert.equal(s.listBackups().length, 0, 'not one autosave may enter the rotation inside the window');
  // …and once the window has passed, exactly one goes in.
  s._lastBackupAt = 0;
  const next = JSON.parse(JSON.stringify(s.get()));
  next.appearance.centerLabel = 'later';
  s.set(next);
  assert.equal(s.listBackups().length, 1);
});

test('an unchanged re-save keeps no backup, even when forced', () => {
  const { ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  s.set(s.get(), { backup: 'force', reason: 'import' });
  assert.deepEqual(s.listBackups(), [], 'the outgoing bytes equal what we wrote — nothing to preserve');
});

test('forced replaces always get their backup, throttle be damned', () => {
  const { ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  for (const label of ['a', 'b', 'c']) {
    const next = JSON.parse(JSON.stringify(s.get()));
    next.appearance.centerLabel = label;
    s.set(next, { backup: 'force', reason: 'reset' });   // same tick: throttle would block
  }
  assert.deepEqual(s.listBackups().map((b) => /-reset-r\d+\.json$/.test(b.name)), [true, true, true]);
});

test('pruning keeps the newest MAX_BACKUPS and never touches foreign files', () => {
  const { dir, ConfigStore, MAX_BACKUPS } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  const dir_ = s.backupDir();
  fs.mkdirSync(dir_, { recursive: true });
  fs.writeFileSync(path.join(dir_, 'notes-from-me.txt'), 'keep me');
  fs.writeFileSync(path.join(dir_, 'config-not-a-backup.json'), 'keep me too');

  for (let i = 0; i < MAX_BACKUPS + 4; i++) {
    const next = JSON.parse(JSON.stringify(s.get()));
    next.appearance.centerLabel = `v${i}`;
    s._lastBackupAt = 0;                                 // simulate the throttle window elapsing
    s.set(next);
  }
  const list = s.listBackups(100);
  assert.equal(list.length, MAX_BACKUPS, `rotation capped at ${MAX_BACKUPS}`);
  assert.ok(fs.existsSync(path.join(dir, 'config.json')));
  assert.ok(fs.existsSync(path.join(dir_, 'notes-from-me.txt')), 'only our own filename shape is pruned');
  assert.ok(fs.existsSync(path.join(dir_, 'config-not-a-backup.json')));
  assert.ok(list[0].name > list[list.length - 1].name, 'listed newest-first');
});

test('listBackups is total: no folder answers [], junk names are ignored', () => {
  const { ConfigStore } = freshStore();
  const s = new ConfigStore();
  assert.deepEqual(s.listBackups(), [], 'the folder does not exist yet');
  s.set(s.get());
  assert.deepEqual(s.listBackups(), []);
  fs.mkdirSync(s.backupDir(), { recursive: true });
  fs.writeFileSync(path.join(s.backupDir(), 'garbage.json'), '{}');
  assert.deepEqual(s.listBackups(), []);
});

test('init() over a hand-written file: the normalizing save keeps the user’s original bytes', () => {
  const { dir, ConfigStore } = freshStore();
  fs.mkdirSync(dir, { recursive: true });
  const seeded = { version: 2, hotkey: 'ctrl+alt+space', rings: { 1: [], 2: [] } };
  const seededText = JSON.stringify(seeded, null, 2);
  fs.writeFileSync(path.join(dir, 'config.json'), seededText, 'utf8');

  const s = new ConfigStore();
  const out = s.init();
  try {
    assert.equal(out.createdNew, false);
    assert.equal(readJson(path.join(dir, 'config.json')).hotkey, 'ctrl+alt+space', 'init read the user file, not the defaults');

    // First save fills the defaults validate() adds — a real change, so the
    // file it displaces (the user's own, hand-edited one) is preserved.
    s.set(s.get(), { backup: 'force', reason: 'import' });
    let list = s.listBackups();
    assert.equal(list.length, 1);
    assert.equal(fs.readFileSync(list[0].path, 'utf8'), seededText, 'the backup is the ORIGINAL file, byte for byte');

    // A save that changes nothing keeps no slot, however often or forced.
    s.set(s.get(), { backup: 'force', reason: 'import' });
    s.set(s.get(), { backup: 'force', reason: 'import' });
    assert.equal(s.listBackups().length, 1);

    // A real change does.
    const next = JSON.parse(JSON.stringify(s.get()));
    next.hotkey = 'ctrl+alt+k';
    s.set(next, { backup: 'force', reason: 'import' });
    list = s.listBackups();
    assert.equal(list.length, 2);
    assert.equal(readJson(list[0].path).hotkey, 'ctrl+alt+space', 'newest first');
    assert.equal(readJson(path.join(dir, 'config.json')).hotkey, 'ctrl+alt+k');
  } finally {
    if (s._watcher) s._watcher.close();
    clearTimeout(s._t);
  }
});

test('a backup failure costs the save nothing', () => {
  const { dir, ConfigStore } = freshStore();
  const s = new ConfigStore();
  s.set(s.get());
  // Make the backups path unusable: a FILE where the folder belongs.
  fs.writeFileSync(path.join(dir, 'backups'), 'not a directory');
  const next = JSON.parse(JSON.stringify(s.get()));
  next.hotkey = 'ctrl+alt+q';
  assert.doesNotThrow(() => s.set(next, { backup: 'force', reason: 'import' }));
  assert.equal(readJson(path.join(dir, 'config.json')).hotkey, 'ctrl+alt+q', 'the save itself still landed');
});
