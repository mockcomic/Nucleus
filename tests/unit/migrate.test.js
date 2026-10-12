'use strict';
/* One-time profile migration (src/main/migrate.js) for the Radial Wheel →
   Nucleus rename. Pure fs against tmpdirs — nothing touches %APPDATA%. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { migrateProfile, repairStaleAppTargets, LEGACY_DIR_NAME, MARKER } = require('../../src/main/migrate');

function tree(root, files) {
  for (const [rel, data] of Object.entries(files)) {
    const p = path.join(root, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, data);
  }
}

test('migrates the legacy profile once, without overwriting new files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-migrate-'));
  try {
    const appData = path.join(root, 'appdata');
    const userData = path.join(appData, 'Nucleus');
    tree(path.join(appData, LEGACY_DIR_NAME), {
      'config.json': '{"hotkey":"ctrl+alt+space"}',
      'state.json': '{"ftuSeen":true}',
      'icons/custom/a.png': 'PNG',
      'backups/old.json': '{}'
    });
    // A file the new profile already owns must survive the copy.
    tree(userData, { 'icons/custom/a.png': 'OURS' });

    const stats = migrateProfile({ appData, userData });
    assert.ok(stats && stats.files >= 3, 'copies config/state/backups');
    assert.equal(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'), '{"hotkey":"ctrl+alt+space"}');
    assert.equal(fs.readFileSync(path.join(userData, 'icons/custom/a.png'), 'utf8'), 'OURS', 'never overwrites');
    assert.ok(fs.existsSync(path.join(userData, MARKER)), 'marker written');

    // Second run: marker present → nothing to do.
    assert.equal(migrateProfile({ appData, userData }), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('no legacy profile (or no legacy config) → no-op', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-migrate-'));
  try {
    const appData = path.join(root, 'appdata');
    const userData = path.join(appData, 'Nucleus');
    assert.equal(migrateProfile({ appData, userData }), null);
    tree(path.join(appData, LEGACY_DIR_NAME), { 'readme.txt': 'no config here' });
    assert.equal(migrateProfile({ appData, userData }), null);
    assert.ok(!fs.existsSync(path.join(userData, 'readme.txt')), 'only a real profile migrates');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

/* The rename left app segments pointing at deleted Start-Menu shortcuts;
   clicking such a segment is fire-and-forget, so it fails SILENTLY.
   repairStaleAppTargets rewrites exactly those. */
function cfgWith(items) {
  return { version: 2, rings: { 1: items } };
}

test('repairStaleAppTargets rewrites dead old-name targets', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-repair-'));
  try {
    const dir = path.join(root, 'Programs');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'Nucleus.lnk'), 'x');   // the live shortcut
    fs.writeFileSync(path.join(dir, 'Live App.lnk'), 'x');  // a same-dir app that still exists
    const cfgPath = path.join(root, 'config.json');
    const stale = path.join(dir, 'Radial Wheel.lnk');       // deleted by the rename
    fs.writeFileSync(cfgPath, JSON.stringify(cfgWith([
      { id: 'a', type: 'app', value: stale },
      { id: 'b', type: 'app', value: path.join(dir, 'Live App.lnk') },
      { id: 'c', type: 'app', value: 'C:\\Somewhere Else\\Radial Wheel.lnk' },
      { id: 'f', type: 'folder', children: [{ id: 'd', type: 'app', value: stale }] }
    ]), null, 2));

    assert.equal(repairStaleAppTargets(root), 2, 'rewrites the two dead references (incl. nested)');
    const out = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.equal(out.rings['1'][0].value, path.join(dir, 'Nucleus.lnk'));
    assert.equal(out.rings['1'][1].value, path.join(dir, 'Live App.lnk'), 'live targets untouched');
    assert.equal(out.rings['1'][2].value, 'C:\\Somewhere Else\\Radial Wheel.lnk', 'missing replacement → untouched');
    assert.equal(out.rings['1'][3].children[0].value, path.join(dir, 'Nucleus.lnk'), 'children repaired too');
    assert.equal(repairStaleAppTargets(root), 0, 'idempotent');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repairStaleAppTargets keeps a target that still exists on disk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-repair-'));
  try {
    fs.writeFileSync(path.join(root, 'Radial Wheel.lnk'), 'x'); // user really has this file
    const cfgPath = path.join(root, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify(cfgWith([{ id: 'a', type: 'app', value: path.join(root, 'Radial Wheel.lnk') }])));
    assert.equal(repairStaleAppTargets(root), 0);
    assert.ok(fs.readFileSync(cfgPath, 'utf8').includes('Radial Wheel.lnk'), 'choice preserved');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('repairStaleAppTargets is total: missing/garbage config never throws', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nucleus-repair-'));
  try {
    assert.equal(repairStaleAppTargets(root), 0, 'no config.json');
    fs.mkdirSync(path.join(root, 'Nucleus'));
    assert.equal(repairStaleAppTargets(path.join(root, 'Nucleus')), 0);
    fs.writeFileSync(path.join(root, 'Nucleus', 'config.json'), '{not json');
    assert.equal(repairStaleAppTargets(path.join(root, 'Nucleus')), 0, 'garbage never throws');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
