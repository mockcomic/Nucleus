'use strict';
/* Export packages (src/main/bundle.js) — config + custom-icon bytes in one
   JSON file. custom-icons is plain node (no Electron), so this exercises the
   REAL cache when it can and injected fakes for the cap paths. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const customIcons = require('../../src/main/custom-icons');
const bundle = require('../../src/main/bundle');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-bundle-'));
customIcons.configure(path.join(tmp, 'custom'));

const PNG = (fill) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(24, fill)
]);

const cfg = (iconImage) => ({
  rings: {
    1: [{ id: 'a', type: 'app', value: 'a.exe', iconImage }],
    2: []
  }
});

/* ------------------------------ collect keys ------------------------------- */
test('collectIconKeys: rings + profiles + folder children, deduped, slugs/junk ignored', () => {
  const got = customIcons.install(PNG(1));
  assert.ok(got.ok);
  const config = {
    rings: {
      1: [
        { id: 'a', type: 'app', iconImage: got.key },
        { id: 'b', type: 'app', iconImage: got.key },                        // same artwork — one copy
        { id: 'f', type: 'folder', children: [{ id: 'c', type: 'app', iconImage: got.key }] }
      ],
      2: [{ id: 'd', type: 'url', iconImage: 'sony' }]                       // dashboard slug — re-downloadable, never bundled
    },
    profiles: [{ id: 'p', name: 'P', apps: [], rings: { 1: [{ id: 'e', type: 'app', iconImage: got.key }], 2: [] } }]
  };
  assert.deepEqual(bundle.collectIconKeys(config), [got.key]);
});

/* -------------------------------- building --------------------------------- */
test('buildBundle embeds honest bytes + the URL origin; missing cache files skip', () => {
  const disk = customIcons.install(PNG(2));
  const url = customIcons.install(PNG(3), { url: 'https://example.com/a.png' });
  assert.ok(disk.ok && url.ok);

  const config = { rings: { 1: [
    { id: 'a', iconImage: disk.key },
    { id: 'b', iconImage: url.key },
    { id: 'c', iconImage: 'custom:' + 'f'.repeat(16) + '.png' }              // referenced, never installed → skip
  ], 2: [] } };
  const built = bundle.buildBundle(config);
  assert.ok(built.ok, built.error);
  assert.equal(built.icons, 2);
  assert.deepEqual(built.skipped, ['custom:' + 'f'.repeat(16) + '.png']);
  assert.equal(built.bundle.bundle, 'nucleus');
  assert.equal(built.bundle.version, 1);
  assert.deepEqual(built.bundle.config, config, 'config rides verbatim');
  assert.notEqual(built.bundle.config, config, '…but not by reference');
  const entry = built.bundle.icons[url.key];
  assert.deepEqual(Buffer.from(entry.b64, 'base64'), PNG(3));
  assert.equal(entry.url, 'https://example.com/a.png');
  assert.equal(built.bundle.icons[disk.key].url, undefined, 'disk-picked art carries no origin');
});

test('buildBundle skips per-file giants but ships the rest', () => {
  const okKey = customIcons.install(PNG(4)).key;
  const huge = customIcons.install(PNG(5));                                   // honest key for a small file…
  const fakeHugeKey = 'custom:' + 'a'.repeat(16) + '.png';
  const config = { rings: { 1: [{ id: 'a', iconImage: okKey }, { id: 'h', iconImage: fakeHugeKey }], 2: [] } };
  const built = bundle.buildBundle(config, {
    readBytes: (k) => (k === fakeHugeKey ? Buffer.alloc(customIcons.FILE_MAX_BYTES + 1) : customIcons.readBytes(k))
  });
  assert.ok(built.ok);
  assert.equal(built.icons, 1);
  assert.deepEqual(built.skipped, [fakeHugeKey]);
  void huge;
});

test('buildBundle ABORTS (never truncates) past the total cap', () => {
  const one = Buffer.alloc(2 * 1024 * 1024, 7);                              // under the per-file cap
  const keys = Array.from({ length: 25 }, (_, i) => 'custom:' + i.toString(16).padStart(16, '0') + '.png');
  const config = { rings: { 1: keys.map((k, i) => ({ id: 'i' + i, iconImage: k })), 2: [] } };
  const built = bundle.buildBundle(config, { readBytes: () => one });
  assert.equal(built.ok, false);
  assert.match(built.error, /MB package cap/);
});

/* --------------------------------- parsing --------------------------------- */
test('looksLikeBundle gates the import path', () => {
  assert.equal(bundle.looksLikeBundle({ bundle: 'nucleus', version: 1 }), true);
  assert.equal(bundle.looksLikeBundle({ bundle: 'radial-wheel', version: 1 }), true, 'pre-rename exports keep importing');
  assert.equal(bundle.looksLikeBundle({ rings: {} }), false);                 // plain config export
  assert.equal(bundle.looksLikeBundle(null), false);
  assert.equal(bundle.looksLikeBundle('nope'), false);
  assert.equal(bundle.looksLikeBundle({ bundle: 'other' }), false);
});

/* -------------------------------- importing -------------------------------- */
test('importIcons round-trips honest bytes into a fresh cache', () => {
  customIcons.configure(path.join(tmp, 'import'));
  const png = PNG(6);
  const key = customIcons.keyFor(png, 'png');
  const r = bundle.importIcons({ icons: { [key]: { b64: png.toString('base64') } } });
  assert.deepEqual(r, { installed: 1, skipped: [] });
  const hit = customIcons.readBytes(key);
  assert.deepEqual(hit, png);
});

test('importIcons rejects key/byte mismatches, bad base64, and junk entries', () => {
  customIcons.configure(path.join(tmp, 'hostile'));
  const honest = PNG(7);
  const lieKey = customIcons.keyFor(PNG(8), 'png');                           // claims different bytes
  const hex = (c) => 'custom:' + c.repeat(16) + '.png';
  const r = bundle.importIcons({
    icons: {
      [lieKey]: { b64: honest.toString('base64') },                            // bytes ≠ claimed hash → skip
      [hex('b')]: { b64: 'not base64!!' },                                     // alphabet violation → skip
      'custom:../../escape.png': { b64: honest.toString('base64') },           // malformed key → skip
      [hex('c')]: 'just a string',                                             // junk entry → skip
      [hex('d')]: { b64: Buffer.from([1, 2, 3]).toString('base64') }           // decodes but no image sniff → install refuses
    }
  });
  assert.equal(r.installed, 0);
  assert.equal(r.skipped.length, 5);
  assert.equal(customIcons.readBytes(lieKey), null, 'the CLAIMED key stays unclaimed — that segment shows its glyph');
});

test('importIcons tolerates a missing/garbage icons map', () => {
  assert.deepEqual(bundle.importIcons({}), { installed: 0, skipped: [] });
  assert.deepEqual(bundle.importIcons({ icons: 42 }), { installed: 0, skipped: [] });
  assert.deepEqual(bundle.importIcons(null), { installed: 0, skipped: [] });
});

test('bundle keys survive the round trip through JSON (the file is the wire format)', () => {
  customIcons.configure(path.join(tmp, 'roundtrip'));
  const png = PNG(9);
  const key = customIcons.install(png).key;
  const built = bundle.buildBundle({ rings: { 1: [{ id: 'a', iconImage: key }], 2: [] } });
  assert.ok(built.ok);
  const wire = JSON.parse(JSON.stringify(built.bundle));
  const r = bundle.importIcons(wire);
  assert.deepEqual(r, { installed: 1, skipped: [] });
});
