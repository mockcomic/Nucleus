'use strict';
/* Unit tests for the pure half of src/main/dashboard-icons.js — slug
   sanitation and metadata ranking. Network paths are intentionally excluded. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sanitizeSlug, slugify, normalize, searchMetadata, configure, cachedDataUrl, writeCache
} = require('../../src/main/dashboard-icons');

test('sanitizeSlug accepts clean slugs, normalizes case/space, rejects traversal and paths', () => {
  assert.equal(sanitizeSlug('firefox'), 'firefox');
  assert.equal(sanitizeSlug('  Firefox  '), 'firefox');
  assert.equal(sanitizeSlug('my-app.v2_x'), 'my-app.v2_x');
  assert.equal(sanitizeSlug('../evil'), null);
  assert.equal(sanitizeSlug('a/b'), null);
  assert.equal(sanitizeSlug('a\\b'), null);
  assert.equal(sanitizeSlug(''), null);
  assert.equal(sanitizeSlug(null), null);
  assert.equal(sanitizeSlug(undefined), null);
  assert.equal(sanitizeSlug(42), null);
  assert.equal(sanitizeSlug('x'.repeat(120)), null);
});

test('slugify turns display names into repo slugs', () => {
  assert.equal(slugify('OBS Studio'), 'obs-studio');
  assert.equal(slugify('  HELLO   World! '), 'hello-world');
  assert.equal(slugify('Visual Studio Code'), 'visual-studio-code');
  assert.equal(slugify('Café'), 'cafe');
  assert.equal(slugify('---'), '');
});

test('normalize folds accents and separators for comparison', () => {
  assert.equal(normalize('OBS Studio'), 'obs studio');
  assert.equal(normalize('  Café  Collab  '), 'cafe collab');
  assert.equal(normalize(null), '');
});

const META = {
  'firefox': { base: 'svg', aliases: ['ff', 'mozilla-firefox'], categories: ['Web-Browsers'] },
  'firefox-reality': { base: 'svg', aliases: [], categories: [] },
  'obs-studio': { base: 'svg', aliases: ['obs'], categories: ['Video-Streaming'] },
  'vlc': { base: 'png', aliases: ['videolan'], categories: ['Media-Players'] },
  'dagster': { base: 'svg', aliases: [], categories: [], colors: { dark: 'dagster-dark', light: 'dagster-light' } },
  'dagster-dark': { base: 'svg', aliases: [], categories: [] },
  'dagster-light': { base: 'svg', aliases: [], categories: [] },
  'pi-hole': { base: 'svg', aliases: ['adblock'], categories: ['Networking-Tools'] }
};

test('exact slug match ranks first', () => {
  const hits = searchMetadata(META, 'firefox');
  assert.ok(hits.length >= 2);
  assert.equal(hits[0].slug, 'firefox');
  assert.equal(hits[0].kind, 'svg');
});

test('all query tokens must match somewhere', () => {
  assert.deepEqual(searchMetadata(META, 'firefox zzznope'), []);
});

test('empty or whitespace query returns nothing', () => {
  assert.deepEqual(searchMetadata(META, ''), []);
  assert.deepEqual(searchMetadata(META, '   '), []);
  assert.deepEqual(searchMetadata(null, 'firefox'), []);
});

test('alias hits outrank contains-hits', () => {
  const hits = searchMetadata(META, 'videolan');
  assert.equal(hits[0].slug, 'vlc');
});

test('multi-word names match slug tokens', () => {
  const hits = searchMetadata(META, 'obs studio');
  assert.equal(hits[0].slug, 'obs-studio');
});

test('png-only icons report kind png', () => {
  const hits = searchMetadata(META, 'vlc');
  assert.equal(hits[0].kind, 'png');
  assert.match(hits[0].url, /^https:\/\/cdn\.jsdelivr\.net\/gh\/homarr-labs\/dashboard-icons\/png\/vlc\.png$/);
});

test('color variants hide behind their parent icon', () => {
  const hits = searchMetadata(META, 'dagster').map((h) => h.slug);
  assert.ok(hits.includes('dagster'));
  assert.ok(!hits.includes('dagster-dark'), 'dagster-dark should be suppressed');
  assert.ok(!hits.includes('dagster-light'), 'dagster-light should be suppressed');
});

test('a variant stands on its own when the parent does not match every token', () => {
  const hits = searchMetadata(META, 'dagster dark').map((h) => h.slug);
  assert.deepEqual(hits, ['dagster-dark']);
});

test('category tokens surface otherwise-unmatched icons', () => {
  const hits = searchMetadata(META, 'adblock').map((h) => h.slug);
  assert.ok(hits.includes('pi-hole'));
});

test('searchMetadata drops catalog keys that are not safe slugs', () => {
  const hits = searchMetadata({
    '../evil': { base: 'svg', aliases: ['bad'], categories: [] },
    'ok-app': { base: 'svg', aliases: [], categories: [] }
  }, 'bad');
  assert.deepEqual(hits, []);
  const ok = searchMetadata({ 'ok-app': { base: 'svg', aliases: [], categories: [] } }, 'ok-app');
  assert.equal(ok.length, 1);
  assert.equal(ok[0].slug, 'ok-app');
  assert.match(ok[0].url, /\/svg\/ok-app\.svg$/);
});

test('a script-bearing SVG is neither cached nor served', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-dash-'));
  configure(dir);
  const evil = Buffer.concat([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8'),
    Buffer.alloc(5000, 0x20),
    Buffer.from('<script>alert(1)</script></svg>', 'utf8')
  ]);
  writeCache('evil', 'svg', evil);
  assert.equal(fs.existsSync(path.join(dir, 'evil.svg')), false, 'writeCache must refuse the file');
  fs.writeFileSync(path.join(dir, 'evil.svg'), evil);
  assert.equal(cachedDataUrl('evil'), null, 'a poisoned cache file is a miss');
  const ok = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>', 'utf8');
  writeCache('ok', 'svg', ok);
  const hit = cachedDataUrl('ok');
  assert.equal(hit.kind, 'svg');
  assert.match(hit.dataUrl, /^data:image\/svg\+xml;base64,/);
});

test('result list is capped by the limit argument', () => {
  const big = {};
  for (let i = 0; i < 100; i++) big[`tool-${i}`] = { base: 'svg', aliases: [], categories: ['Tools'] };
  const hits = searchMetadata(big, 'tool', 10);
  assert.equal(hits.length, 10);
});
