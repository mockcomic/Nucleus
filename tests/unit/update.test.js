'use strict';
/* Unit tests for src/main/update.js — the pure decision half (parse, compare,
   sanitize, decide) and the fetch wrapper driven by a FAKE fetch (no live
   net, per test-bootstrap). electron is stubbed via require-cache injection;
   the logger degrades to console until init() and never touches disk here. */
const test = require('node:test');
const assert = require('node:assert/strict');

const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: {
    app: { getPath: () => require('node:os').tmpdir() },
    shell: { openExternal: async () => undefined }
  }
};

const upd = require('../../src/main/update.js');
const { parseVersion, compareVersions, decide, sanitizeRelease, releaseUrl } = upd;

/* A fetch Response stand-in readCapped understands: ok + an async-iterable
   body of Buffers. status/ok are explicit so failure scenarios are honest. */
function fakeResponse(body, ok = true, status = 200) {
  return {
    ok, status,
    body: (async function* () { yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'); })()
  };
}
const ghRelease = (over = {}) => Object.assign({
  tag_name: 'v1.2.0',
  name: 'Nucleus 1.2.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/mockcomic/radial-wheel/releases/tag/v1.2.0',
  assets: [
    { name: 'Nucleus-1.2.0-b1-setup.exe', size: 104000000, browser_download_url: 'https://github.com/mockcomic/radial-wheel/releases/download/v1.2.0/Nucleus-1.2.0-b1-setup.exe' },
    { name: 'Nucleus-1.2.0-b1-portable.exe', size: 103000000, browser_download_url: 'https://objects.githubusercontent.com/x/Nucleus-portable.exe' }
  ]
}, over);

/* --------------------------------- versions -------------------------------- */

test('parseVersion accepts v-prefixed and suffixed semver, rejects junk', () => {
  assert.deepEqual(parseVersion('v1.2.3'), { maj: 1, min: 2, pat: 3 });
  assert.deepEqual(parseVersion(' 1.2.3 '), { maj: 1, min: 2, pat: 3 });
  assert.deepEqual(parseVersion('v1.2.3-beta.1'), { maj: 1, min: 2, pat: 3 });
  assert.equal(parseVersion('1.2'), null);
  assert.equal(parseVersion('latest'), null);
  assert.equal(parseVersion(''), null);
  assert.equal(parseVersion(null), null);
  assert.equal(parseVersion(42), null);
});

test('compareVersions orders by maj/min/pat; null sorts lowest', () => {
  const V = (s) => parseVersion(s);
  assert.equal(compareVersions(V('1.2.0'), V('1.1.9')), 1);
  assert.equal(compareVersions(V('2.0.0'), V('1.99.99')), 1);
  assert.equal(compareVersions(V('1.2.0'), V('1.2.0')), 0);
  assert.equal(compareVersions(null, V('0.0.1')), -1);
  assert.equal(compareVersions(V('0.0.1'), null), 1);
  assert.equal(compareVersions(null, null), 0);
});

/* ---------------------------------- decide --------------------------------- */

test('higher remote version → available, kind version', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v1.2.0', published_at: '2020-01-01T00:00:00Z' }));
  const v = decide(rel, '1.0.0', Date.parse('2030-01-01'), 0);
  assert.equal(v.status, 'available');
  assert.equal(v.kind, 'version');
});

test('lower remote version → up to date (rollback published is not an update)', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v0.9.0', published_at: '2030-01-01T00:00:00Z' }));
  assert.equal(decide(rel, '1.0.0', Date.parse('2020-01-01'), 0).status, 'upToDate');
});

test('same version, newer published_at → available as a build update', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v1.0.0', published_at: '2026-10-01T00:00:00Z' }));
  const v = decide(rel, '1.0.0', Date.parse('2026-09-01'), 0);
  assert.equal(v.status, 'available');
  assert.equal(v.kind, 'build');
});

test('same version, older or equal published_at → up to date', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v1.0.0', published_at: '2026-09-01T00:00:00Z' }));
  assert.equal(decide(rel, '1.0.0', Date.parse('2026-10-01'), 0).status, 'upToDate');
  const same = sanitizeRelease(ghRelease({ tag_name: 'v1.0.0', published_at: '2026-10-01T00:00:00Z' }));
  assert.equal(decide(same, '1.0.0', Date.parse('2026-10-01T00:00:00Z'), 0).status, 'upToDate');
});

test('same unparseable version with newer date still counts as a build (tag name carries the offer)', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v1.0.0', published_at: '2026-10-01T00:00:00Z' }));
  assert.equal(decide(rel, 'junk-version', Date.parse('2026-09-01'), 0).status, 'available');
});

test('no clock anchor (NaN appPublishMs) with equal versions → upToDate, no claim', () => {
  const rel = sanitizeRelease(ghRelease({ tag_name: 'v1.0.0' }));
  assert.equal(decide(rel, '1.0.0', NaN, 0).status, 'upToDate');
});

test('decide on a null latest → none', () => {
  assert.deepEqual(decide(null, '1.0.0', 1, 1), { status: 'none' });
});

/* -------------------------------- sanitize --------------------------------- */

test('sanitizeRelease keeps whitelisted fields and rebuilds html_url', () => {
  const rel = sanitizeRelease(ghRelease({ html_url: 'https://evil.example/x' }));
  assert.equal(rel.tag, 'v1.2.0');
  assert.equal(rel.versionLabel, '1.2.0');
  assert.deepEqual(rel.version, { maj: 1, min: 2, pat: 0 });
  assert.equal(rel.url, releaseUrl('v1.2.0'));
  assert.equal(rel.publishedAt, '2026-10-01T00:00:00Z');
  assert.equal(rel.assets.length, 2);
});

test('sanitizeRelease rejects bad tags, missing/unparseable dates, and non-objects', () => {
  assert.equal(sanitizeRelease(ghRelease({ tag_name: 'bad tag!' })), null);
  assert.equal(sanitizeRelease(ghRelease({ tag_name: '../x' })), null);
  assert.equal(sanitizeRelease(ghRelease({ published_at: 'not-a-date' })), null);
  assert.equal(sanitizeRelease(ghRelease({ published_at: null })), null);
  assert.equal(sanitizeRelease(null), null);
  assert.equal(sanitizeRelease([]), null);
  assert.equal(sanitizeRelease('v1'), null);
});

test('sanitizeRelease drops assets off the GitHub asset hosts and junk names', () => {
  const rel = sanitizeRelease(ghRelease({
    assets: [
      { name: 'ok.exe', size: 1, browser_download_url: 'https://github.com/mockcomic/radial-wheel/releases/download/v1.2.0/ok.exe' },
      { name: 'hostile.exe', size: 1, browser_download_url: 'https://evil.example/hostile.exe' },
      { name: 'injected?x=1', size: 1, browser_download_url: 'https://objects.githubusercontent.com/a/injected' },
      { name: 'ok2.exe', size: 'NaN', browser_download_url: 'https://objects.githubusercontent.com/a/ok2.exe' }
    ]
  }));
  assert.deepEqual(rel.assets.map((a) => a.name), ['ok.exe', 'ok2.exe']);
  assert.equal(rel.assets[1].size, null);   // non-finite size → null, not NaN
});

test('sanitizeRelease tolerates absent/garbage assets array', () => {
  assert.deepEqual(sanitizeRelease(ghRelease({ assets: 'nope' })).assets, []);
  assert.deepEqual(sanitizeRelease(ghRelease({ assets: null })).assets, []);
});

/* ------------------------------ check + snapshot ---------------------------- */

test('check() with a good release returns available and snapshot exposes it', async () => {
  upd._reset();
  const r = await upd.check({
    fetch: async () => fakeResponse(ghRelease({ tag_name: 'v9.9.9', published_at: '2026-10-01T00:00:00Z' })),
    appVersion: '1.0.0',
    appPublishMs: Date.parse('2020-01-01'),
    now: () => 1234
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'available');
  assert.equal(r.kind, 'version');
  const s = upd.snapshot('1.0.0', Date.parse('2020-01-01'));
  assert.equal(s.status, 'available');
  assert.equal(s.info.version, '9.9.9');
  assert.equal(s.lastCheckMs, 1234);
});

test('check() HTTP failure returns ok:false and snapshot reports error', async () => {
  upd._reset();
  const r = await upd.check({
    fetch: async () => fakeResponse('{}', false, 403),
    appVersion: '1.0.0', appPublishMs: NaN, now: () => 5
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  const s = upd.snapshot('1.0.0', NaN);
  assert.equal(s.status, 'error');
  assert.match(s.error, /403/);
});

test('check() fetch rejection (offline) is an error result, never a throw', async () => {
  upd._reset();
  const r = await upd.check({
    fetch: async () => { throw new Error('offline'); },
    appVersion: '1.0.0', appPublishMs: NaN, now: () => 6
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /offline/);
});

test('check() garbage body is a failed check, not a crash', async () => {
  upd._reset();
  const r = await upd.check({
    fetch: async () => fakeResponse('this is not json', true, 200),
    appVersion: '1.0.0', appPublishMs: NaN, now: () => 7
  });
  assert.equal(r.ok, false);
});

test('check() over-cap body is rejected (readCapped overflow)', async () => {
  upd._reset();
  const big = { tag_name: 'v1.0.1', published_at: '2026-10-01T00:00:00Z', assets: [], pad: 'x'.repeat(300 * 1024) };
  const r = await upd.check({
    fetch: async () => fakeResponse(big),
    appVersion: '1.0.0', appPublishMs: NaN, now: () => 8
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cap/);
});

test('check() of a draft/prerelease release yields status none', async () => {
  upd._reset();
  const d = await upd.check({ fetch: async () => fakeResponse(ghRelease({ draft: true })), appVersion: '1.0.0', appPublishMs: NaN, now: () => 9 });
  assert.deepEqual({ ok: d.ok, status: d.status }, { ok: true, status: 'none' });
  upd._reset();
  const p = await upd.check({ fetch: async () => fakeResponse(ghRelease({ prerelease: true })), appVersion: '1.0.0', appPublishMs: NaN, now: () => 10 });
  assert.equal(p.status, 'none');
});

test('check() of a release JSON without tag_name yields none', async () => {
  upd._reset();
  const r = await upd.check({ fetch: async () => fakeResponse({ message: 'Not Found' }), appVersion: '1.0.0', appPublishMs: NaN, now: () => 11 });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'none');
  assert.equal(upd.snapshot('1.0.0', NaN).info, null);
});

test('concurrent checks share one in-flight request', async () => {
  upd._reset();
  let calls = 0;
  const slow = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return fakeResponse(ghRelease({ tag_name: 'v3.0.0' }));
  };
  const [a, b] = await Promise.all([
    upd.check({ fetch: slow, appVersion: '1.0.0', appPublishMs: NaN, now: () => 1 }),
    upd.check({ fetch: slow, appVersion: '1.0.0', appPublishMs: NaN, now: () => 2 })
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
});

test('openRelease ignores a renderer-chosen URL that is not main’s own', async () => {
  upd._reset();
  await upd.check({ fetch: async () => fakeResponse(ghRelease()), appVersion: '1.0.0', appPublishMs: NaN, now: () => 1 });
  const got = await upd.openRelease('https://evil.example/steer');
  assert.equal(got.ok, true);
  assert.equal(got.url, upd.RELEASES_PAGE);          // fell back to the fixed page
  const own = await upd.openRelease(upd.snapshot('1.0.0', NaN).info.url);
  assert.equal(own.ok, true);
  assert.match(own.url, /\/releases\/tag\/v1\.2\.0$/);
});

/* config validate must round-trip the new flag with its opt-out default. */
test('behavior.updateChecks defaults ON and round-trips through validate', () => {
  const { defaults, validate } = require('../../src/main/config.js');
  assert.equal(defaults().behavior.updateChecks, true);
  assert.equal(validate({}).behavior.updateChecks, true);            // absent/junk → on
  assert.equal(validate({ behavior: { updateChecks: false } }).behavior.updateChecks, false);
  assert.equal(validate({ behavior: { updateChecks: 'yes' } }).behavior.updateChecks, true);
});
