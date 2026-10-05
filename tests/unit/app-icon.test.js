'use strict';
/* The app's own icon as built-in segment art (icon-gen's APP_ICON_KEY):
   the reserved key can never collide with the downloadable families, and
   appIconDataUrl renders/caches the wheel artwork PNG. Pure fs/zlib — no
   electron, no window. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const iconGen = require('../../src/main/icon-gen.js');

test('the built-in key cannot collide with dashboard slugs or custom keys', () => {
  const key = iconGen.APP_ICON_KEY;
  assert.ok(key.includes(':'), 'must be outside dashboard SLUG_RE (no colon)');
  assert.ok(!/^custom:[a-f0-9]{16}\.[a-z]{3,4}$/.test(key), 'must be outside the custom key shape');
  // The exact reserved value the whole pipeline keys on.
  assert.equal(key, 'builtin:app');
});

test('appIconDataUrl renders a real PNG data URL and caches it per dir', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-appicon-'));
  try {
    const url = iconGen.appIconDataUrl(dir);
    assert.match(url, /^data:image\/png;base64,/)
      ;
    const buf = Buffer.from(url.slice('data:image/png;base64,'.length), 'base64');
    assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG magic');
    const onDisk = fs.readFileSync(path.join(dir, 'app-icon-128.png'));
    assert.equal(onDisk.length, buf.length, 'served bytes are the cached file');
    assert.equal(iconGen.appIconDataUrl(dir), url, 'second call hits the memory cache');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a 0-byte leftover from an interrupted run is repaired', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-appicon-bad-'));
  try {
    fs.writeFileSync(path.join(dir, 'app-icon-128.png'), Buffer.alloc(0));
    const url = iconGen.appIconDataUrl(dir);
    assert.match(url, /^data:image\/png;base64,/);
    assert.ok(fs.statSync(path.join(dir, 'app-icon-128.png')).size > 0, 'file repaired');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
