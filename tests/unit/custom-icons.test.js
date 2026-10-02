'use strict';
/* Unit tests for src/main/custom-icons.js — the key/sniff half is pure, the
   store half runs against a throwaway tmpdir (test-bootstrap isolation rule:
   nothing here may touch %APPDATA%\Radial Wheel). Network paths are excluded;
   a URL-sourced icon's re-fetch is exercised only through its no-origin
   failure branch. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('node:os');
const path = require('node:path');

const ci = require('../../src/main/custom-icons');
const { sanitizeSlug } = require('../../src/main/dashboard-icons');

/* A real 1×1 transparent PNG; the other formats only need their magic prefix
   because this module never decodes pixels — the sniff IS the validation. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64');
const fake = (bytes, pad = 32) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(pad, 0x20)]);
const JPG = fake([0xff, 0xd8, 0xff, 0xe0]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(20, 0x2c)]);
const WEBP = Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0), Buffer.from('WEBPVP8 ', 'latin1'), Buffer.alloc(8, 0x2c)]);
const BMP = Buffer.concat([Buffer.from('BM', 'latin1'), Buffer.alloc(20, 0x2c)]);
const ICO = fake([0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8"/></svg>', 'utf8');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'rw-icons-'));

/* ------------------------------- key shape -------------------------------- */
test('sanitizeKey honours well-formed custom keys only', () => {
  const good = 'custom:' + 'a'.repeat(16) + '.png';
  assert.equal(ci.sanitizeKey(good), good);
  assert.equal(ci.sanitizeKey('  ' + good.toUpperCase() + '  '), good, 'trims and folds case');
  assert.equal(ci.sanitizeKey('custom:' + 'a'.repeat(16) + '.svg'), 'custom:' + 'a'.repeat(16) + '.svg');
  assert.equal(ci.sanitizeKey('custom:' + 'a'.repeat(16) + '.webp'), 'custom:' + 'a'.repeat(16) + '.webp');
});

test('sanitizeKey rejects traversal, unknown kinds, and non-custom families', () => {
  assert.equal(ci.sanitizeKey('custom:../../etc/passwd.png'), null);
  assert.equal(ci.sanitizeKey('custom:' + 'a'.repeat(16) + '.exe'), null, 'unregistered kind');
  assert.equal(ci.sanitizeKey('custom:' + 'a'.repeat(16) + '.zzz'), null, 'unknown extension');
  assert.equal(ci.sanitizeKey('custom:' + 'g'.repeat(16) + '.png'), null, 'non-hex hash');
  assert.equal(ci.sanitizeKey('custom:' + 'a'.repeat(8) + '.png'), null, 'short hash');
  assert.equal(ci.sanitizeKey('firefox'), null);
  assert.equal(ci.sanitizeKey(''), null);
  assert.equal(ci.sanitizeKey(null), null);
  assert.equal(ci.sanitizeKey(undefined), null);
  assert.equal(ci.sanitizeKey(42), null);
  assert.equal(ci.isCustomKey('custom:' + 'a'.repeat(16) + '.png'), true);
  assert.equal(ci.isCustomKey('firefox'), false);
});

test('the two icon families cannot impersonate each other', () => {
  const key = 'custom:' + 'a'.repeat(16) + '.png';
  assert.equal(sanitizeSlug(key), null, 'a custom key is never read as a dashboard slug');
  assert.equal(ci.sanitizeKey('firefox'), null, 'a slug is never read as a custom key');
});

test('keyFor is content-addressed: same bytes, same key; any byte, new key', () => {
  const a = ci.keyFor(PNG, 'png');
  assert.match(a, /^custom:[0-9a-f]{16}\.png$/);
  assert.equal(a, ci.keyFor(Buffer.from(PNG), 'png'));
  assert.notEqual(a, ci.keyFor(Buffer.concat([PNG, Buffer.from([0])]), 'png'));
  assert.equal(ci.keyFor(PNG, 'jpg').endsWith('.jpg'), true);
});

/* ------------------------------ byte sniffing ------------------------------ */
test('sniffImage accepts the supported formats by magic bytes', () => {
  assert.equal(ci.sniffImage(PNG), 'png');
  assert.equal(ci.sniffImage(JPG), 'jpg');
  assert.equal(ci.sniffImage(GIF), 'gif');
  assert.equal(ci.sniffImage(WEBP), 'webp');
  assert.equal(ci.sniffImage(BMP), 'bmp');
  assert.equal(ci.sniffImage(ICO), 'ico');
  assert.equal(ci.sniffImage(SVG), 'svg');
  assert.equal(ci.sniffImage(Buffer.concat([Buffer.from('\uFEFF', 'utf8'), SVG])), 'svg', 'BOM tolerated');
  assert.equal(ci.sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="x"/>', 'utf8')), 'svg');
});

test('sniffImage rejects anything that is not one of them', () => {
  assert.equal(ci.sniffImage(fake([0x25, 0x50, 0x44, 0x46])), null, 'pdf');            // %PDF
  assert.equal(ci.sniffImage(fake([0x50, 0x4b, 0x03, 0x04])), null, 'zip');            // PK
  assert.equal(ci.sniffImage(Buffer.concat([Buffer.from('RIFF', 'latin1'), Buffer.alloc(4, 0), Buffer.from('WAVEfmte'), Buffer.alloc(8, 0)])), null, 'wav is not webp');
  assert.equal(ci.sniffImage(Buffer.from('<html><body>hi</body></html>', 'utf8')), null);
  assert.equal(ci.sniffImage(Buffer.from('GIF89a' + 'x'.repeat(20), 'utf8')), 'gif');  // control: real gif
  assert.equal(ci.sniffImage(Buffer.alloc(3)), null, 'too short to sniff');
  assert.equal(ci.sniffImage('not a buffer'), null);
  assert.equal(ci.sniffImage(null), null);
});

test('looksLikeSvg refuses SVG that carries a script surface', () => {
  assert.equal(ci.looksLikeSvg(SVG), true);
  assert.equal(ci.looksLikeSvg(Buffer.from('<svg onload="alert(1)"/>', 'utf8')), false);
  assert.equal(ci.looksLikeSvg(Buffer.from('<svg><script>alert(1)</script></svg>', 'utf8')), false);
  assert.equal(ci.looksLikeSvg(Buffer.from('<svg><a href="javascript:x"/></svg>', 'utf8')), false);
  assert.equal(ci.looksLikeSvg(Buffer.from('<?xml version="1.0"?><html/>', 'utf8')), false, 'xml prolog but no svg root');
});

/* -------------------------------- URLs ------------------------------------ */
test('validateUrl takes plain http(s) image URLs and nothing else', () => {
  assert.equal(ci.validateUrl('https://example.com/logo.png'), 'https://example.com/logo.png');
  assert.equal(ci.validateUrl('  http://example.com/a.png  '), 'http://example.com/a.png');
  assert.equal(ci.validateUrl('https://example.com/a.png?x=1&y=2#frag'), 'https://example.com/a.png?x=1&y=2#frag');
  assert.equal(ci.validateUrl('file:///C:/Windows/notepad.exe'), null, 'no local file reads through the URL box');
  assert.equal(ci.validateUrl('javascript:alert(1)'), null);
  assert.equal(ci.validateUrl('data:image/png;base64,AAAA'), null, 'base64 belongs in the file picker');
  assert.equal(ci.validateUrl('\\\\nas\\share\\icon.png'), null);
  assert.equal(ci.validateUrl('https://user:sekret@example.com/i.png'), null, 'credentials would be persisted into config.json');
  assert.equal(ci.validateUrl('not a url'), null);
  assert.equal(ci.validateUrl(''), null);
  assert.equal(ci.validateUrl('https://example.com/' + 'a'.repeat(2100)), null, 'length cap');
  assert.equal(ci.validateUrl(null), null);
});

/* -------------------------------- store ------------------------------------ */
test('install stores the bytes under the content-addressed name and returns a data URL', () => {
  const dir = tmpDir();
  ci.configure(dir);
  const r = ci.install(PNG);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'png');
  assert.equal(r.bytes, PNG.length);
  assert.match(r.dataUrl, /^data:image\/png;base64,/);
  assert.equal(r.dataUrl, 'data:image/png;base64,' + PNG.toString('base64'));
  const onDisk = path.join(dir, r.key.slice('custom:'.length));
  assert.equal(fs.existsSync(onDisk), true);
  assert.deepEqual(fs.readFileSync(onDisk), PNG);
  assert.equal(fs.readdirSync(dir).filter((n) => !n.startsWith('_')).length, 1, 'one file, no litter');
});

test('install is idempotent and dedupes by content', () => {
  const dir = tmpDir();
  ci.configure(dir);
  const a = ci.install(PNG);
  const b = ci.install(Buffer.from(PNG));
  assert.equal(a.key, b.key);
  assert.equal(fs.readdirSync(dir).filter((n) => !n.startsWith('_')).length, 1);
});

test('install refuses unsupported and oversized payloads without writing them', () => {
  const dir = tmpDir();
  ci.configure(dir);
  assert.match(ci.install(fake([0x25, 0x50, 0x44, 0x46])).error, /Unsupported image/);
  assert.match(ci.install(Buffer.alloc(0)).error, /No image data/);
  const big = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(ci.FILE_MAX_BYTES, 0x2c)]);
  const r = ci.install(big);
  assert.equal(r.ok, false);
  assert.match(r.error, /2 MB/);
  assert.deepEqual(fs.readdirSync(dir).filter((n) => !n.startsWith('_')), [], 'nothing stored');
});

test('dataUrlFor reads the store back, and a key with no file and no origin is a miss', async () => {
  const dir = tmpDir();
  ci.configure(dir);
  const put = ci.install(JPG);
  const got = await ci.dataUrlFor(put.key);
  assert.equal(got.ok, true);
  assert.equal(got.kind, 'jpg');
  assert.equal(got.dataUrl, put.dataUrl);

  const ghost = 'custom:' + 'b'.repeat(16) + '.png';
  const miss = await ci.dataUrlFor(ghost);
  assert.equal(miss.ok, false, 'disk-picked art cannot re-download itself');
  assert.match(miss.error, /missing/i);
  assert.equal((await ci.dataUrlFor('firefox')).ok, false, 'a slug is not ours to resolve');
});

test('a corrupt _sources.json degrades to no origins instead of throwing', async () => {
  const dir = tmpDir();
  ci.configure(dir);
  const put = ci.install(GIF);
  fs.writeFileSync(path.join(dir, '_sources.json'), '{ this is not json', 'utf8');
  ci.configure(dir);                                     // re-point = drop the memoised index
  const got = await ci.dataUrlFor(put.key);
  assert.equal(got.ok, true, 'the bytes are still there');
  const ghost = await ci.dataUrlFor('custom:' + 'c'.repeat(16) + '.png');
  assert.equal(ghost.ok, false, 'and the broken index simply means "no origin"');
});

test('a foreign file dropped into the store is treated as a miss, not served', async () => {
  const dir = tmpDir();
  ci.configure(dir);
  const key = ci.keyFor(Buffer.from('hello world this is not an image at all'), 'png');
  fs.writeFileSync(path.join(dir, key.slice('custom:'.length)), 'not an image', 'utf8');
  const r = await ci.dataUrlFor(key);
  assert.equal(r.ok, false);
});

test('addFile reads a chosen path, and reports the ways a path can be wrong', () => {
  const dir = tmpDir();
  ci.configure(dir);
  const src = path.join(dir, 'source.png');
  fs.writeFileSync(src, PNG);
  const ok = ci.addFile(src);
  assert.equal(ok.ok, true);
  assert.equal(ok.kind, 'png');

  assert.match(ci.addFile(path.join(dir, 'missing.png')).error, /Could not read that file/);
  assert.match(ci.addFile(dir).error, /not a file/);
  const empty = path.join(dir, 'empty.png');
  fs.writeFileSync(empty, Buffer.alloc(0));
  assert.match(ci.addFile(empty).error, /empty/);
  assert.equal(ci.addFile(null).ok, false);
  assert.equal(ci.addFile('').ok, false);
  assert.equal(ci.addFile('   ').ok, false);
});

test('warm ignores junk and never throws on missing families', () => {
  const dir = tmpDir();
  ci.configure(dir);
  const put = ci.install(SVG);
  assert.doesNotThrow(() => ci.warm([null, undefined, 42, 'firefox', '', put.key, 'custom:zzzz.png']));
  assert.doesNotThrow(() => ci.warm());
  assert.doesNotThrow(() => ci.warm([]));
});

test('configure points the store at a new directory', () => {
  const dirA = tmpDir(), dirB = tmpDir();
  ci.configure(dirA);
  const a = ci.install(GIF);
  assert.equal(fs.existsSync(path.join(dirA, a.key.slice('custom:'.length))), true);
  ci.configure(dirB);
  assert.deepEqual(fs.readdirSync(dirB).filter((n) => !n.startsWith('_')), [], 'B starts empty');
  const b = ci.install(GIF);
  assert.equal(a.key, b.key, 'same content, same key — in a different place');
  assert.equal(fs.existsSync(path.join(dirB, b.key.slice('custom:'.length))), true);
});
