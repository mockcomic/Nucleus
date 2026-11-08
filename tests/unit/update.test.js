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
const { parseVersion, compareVersions, decide, sanitizeRelease, releaseUrl, chooseAsset } = upd;

/* The renamed repo is the whole point of the fixed targets: the old
   `radial-wheel` URL only answers through a redirect, and an updater that
   leans on redirects breaks the day GitHub retires one. */
test('the updater points at the renamed repo and its Releases page', () => {
  assert.equal(upd.REPO, 'mockcomic/Nucleus');
  assert.equal(upd.API_URL, 'https://api.github.com/repos/mockcomic/Nucleus/releases/latest');
  assert.equal(upd.RELEASES_PAGE, 'https://github.com/mockcomic/Nucleus/releases');
  assert.equal(releaseUrl('v1.2.0'), 'https://github.com/mockcomic/Nucleus/releases/tag/v1.2.0');
});

/* A fetch Response stand-in readCapped understands: ok + an async-iterable
   body of Buffers. status/ok are explicit so failure scenarios are honest.
   A Buffer body is yielded as-is (byte-exact); anything else is stringified. */
function fakeResponse(body, ok = true, status = 200) {
  return {
    ok, status,
    body: (async function* () { yield Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8'); })()
  };
}
const ghRelease = (over = {}) => Object.assign({
  tag_name: 'v1.2.0',
  name: 'Nucleus 1.2.0',
  draft: false,
  prerelease: false,
  published_at: '2026-10-01T00:00:00Z',
  html_url: 'https://github.com/mockcomic/Nucleus/releases/tag/v1.2.0',
  assets: [
    { name: 'Nucleus-1.2.0-b1-setup.exe', size: 104000000, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/Nucleus-1.2.0-b1-setup.exe' },
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
      { name: 'ok.exe', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/ok.exe' },
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

/* ----------------------------- checksums + pick --------------------------- */

test('sanitizeRelease keeps GitHub’s sha256 asset digest and rejects other digests', () => {
  const rel = sanitizeRelease(ghRelease({
    assets: [
      { name: 'a.exe', size: 1, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://objects.githubusercontent.com/x/a.exe' },
      { name: 'b.exe', size: 1, digest: 'b'.repeat(64), browser_download_url: 'https://objects.githubusercontent.com/x/b.exe' },
      { name: 'c.exe', size: 1, digest: 'md5:d41d8cd98f00b204e9800998ecf8427e', browser_download_url: 'https://objects.githubusercontent.com/x/c.exe' },
      { name: 'd.exe', size: 1, browser_download_url: 'https://objects.githubusercontent.com/x/d.exe' }
    ]
  }));
  assert.equal(rel.assets[0].sha256, 'a'.repeat(64));   // the documented shape
  assert.equal(rel.assets[1].sha256, 'b'.repeat(64));   // bare hex, same bytes
  assert.equal(rel.assets[2].sha256, null);             // another algorithm is not a verifier
  assert.equal(rel.assets[3].sha256, null);             // absent stays unknown, never assumed
});

test('chooseAsset prefers the installer that matches how this copy runs', () => {
  const rel = sanitizeRelease(ghRelease());
  assert.equal(chooseAsset(rel, false).name, 'Nucleus-1.2.0-b1-setup.exe');   // NSIS install
  assert.equal(chooseAsset(rel, true).name, 'Nucleus-1.2.0-b1-portable.exe'); // portable copy
  const onlyZip = sanitizeRelease(ghRelease({
    assets: [{ name: 'source.zip', size: 1, browser_download_url: 'https://objects.githubusercontent.com/x/source.zip' }]
  }));
  assert.equal(chooseAsset(onlyZip, true).name, 'source.zip');   // no exe: take something
  assert.equal(chooseAsset(sanitizeRelease(ghRelease({ assets: [] })), false), null);
  assert.equal(chooseAsset(null, true), null);
});

/* ------------------------------ download + run ---------------------------- */

const fsx = require('node:fs');
const osx = require('node:os');
const pax = require('node:path');
const cry = require('node:crypto');

/* A download-shaped fake: `ok` plus a chunked async-iterable body, which is
   all downloadUpdate reads (no headers, no net). `url` stands in for the
   post-redirect final URL (absent = the fetch never moved). */
function fakeDownload(chunks, ok = true, status = 200, url = undefined) {
  return { ok, status, url, body: (async function* () { for (const c of chunks) yield Buffer.from(c); })() };
}
const dlAsset = (body, over = {}) => ({
  name: 'Nucleus-1.2.0-b1-setup.exe',
  size: body.length,
  sha256: cry.createHash('sha256').update(body).digest('hex'),
  url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/Nucleus-1.2.0-b1-setup.exe',
  ...over
});
const tmpDir = () => fsx.mkdtempSync(pax.join(osx.tmpdir(), 'nucleus-dl-'));

test('downloadUpdate writes the asset, verifies the published sha256, and leaves no .part', async () => {
  upd._reset();
  const dir = tmpDir();
  const body = Buffer.from('installer-bytes-'.repeat(64));
  const seen = [];
  const r = await upd.downloadUpdate({
    asset: dlAsset(body), tag: 'v1.2.0', authenticated: true, destDir: dir,
    fetch: async () => fakeDownload([body.slice(0, 100), body.slice(100)]),
    onProgress: (p) => seen.push(p.pct)
  });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(pax.basename(r.path), 'Nucleus-1.2.0-b1-setup.exe');
  assert.deepEqual(fsx.readFileSync(r.path), body);
  assert.equal(fsx.existsSync(r.path + '.part'), false);
  assert.ok(seen.length >= 2, 'progress must report more than the final tick');
  assert.ok(seen[0] > 0 && seen[0] < 100, 'first tick is a real partial percentage');
  assert.equal(seen[seen.length - 1], 100);                   // progress ends at 100%
  const snap = upd.snapshot('1.0.0', NaN);
  assert.equal(snap.download.done, true);
  assert.equal(snap.download.error, null);
  assert.equal(snap.download.pct, 100);
});

test('downloadUpdate rejects a file that does not match the published checksum (and cleans up)', async () => {
  upd._reset();
  const dir = tmpDir();
  const r = await upd.downloadUpdate({
    asset: dlAsset(Buffer.from('real'), { sha256: 'f'.repeat(64) }),
    authenticated: true, destDir: dir, fetch: async () => fakeDownload([Buffer.from('real')])
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/);
  assert.equal(fsx.readdirSync(dir).length, 0);               // no .part, no fake .exe
  assert.match(upd.snapshot('1.0.0', NaN).download.error, /checksum/);
});

test('downloadUpdate enforces its byte cap DURING the transfer', async () => {
  upd._reset();
  const dir = tmpDir();
  const big = Buffer.from('x'.repeat(4000));
  const r = await upd.downloadUpdate({
    asset: dlAsset(big), authenticated: true, destDir: dir, maxBytes: 1000,
    fetch: async () => fakeDownload([big])
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /cap/);
  assert.equal(fsx.readdirSync(dir).length, 0);
});

test('downloadUpdate refuses anything but a sanitized asset URL and a real folder', async () => {
  upd._reset();
  const dir = tmpDir();
  assert.equal((await upd.downloadUpdate({ asset: { name: 'a.exe', url: 'https://evil.example/a.exe' }, authenticated: true, destDir: dir })).ok, false);
  assert.equal((await upd.downloadUpdate({ asset: { name: '../a.exe', url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/a.exe' }, authenticated: true, destDir: dir })).ok, false);
  assert.equal((await upd.downloadUpdate({ asset: dlAsset(Buffer.from('x')), authenticated: true, destDir: '' })).ok, false);
  assert.equal((await upd.downloadUpdate({ asset: null, authenticated: true, destDir: dir })).ok, false);
  assert.equal(fsx.readdirSync(dir).length, 0);
});

test('downloadUpdate reports an HTTP failure as a failed download, not a throw', async () => {
  upd._reset();
  const dir = tmpDir();
  const r = await upd.downloadUpdate({
    asset: dlAsset(Buffer.from('x')), authenticated: true, destDir: dir,
    fetch: async () => fakeDownload([], false, 403)
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /403/);
  assert.match(upd.snapshot('1.0.0', NaN).download.error, /403/);
});

test('runUpdate launches the downloaded exe detached (and rejects anything else)', async () => {
  upd._reset();
  const calls = [];
  const fake = (cmd, args, options) => { calls.push({ cmd, args, options }); return { unref() {} }; };
  // The gate is by construction: only a path this module verified may spawn,
  // so the "accepted" leg downloads a verified file into a tmp dir first.
  const dir = tmpDir();
  const body = Buffer.from('gate-check');
  const dl = await upd.downloadUpdate({ asset: dlAsset(body), authenticated: true, destDir: dir, fetch: async () => fakeDownload([body]) });
  assert.equal(dl.ok, true);
  assert.equal(upd.runUpdate(dl.path, { spawn: fake }).ok, true);
  assert.deepEqual(calls[0], {
    cmd: dl.path,
    args: [],
    options: { detached: true, stdio: 'ignore' }
  });                                          // no shell: a spaced path is one path
  assert.equal(calls[0].options.detached, true);
  for (const bad of ['https://github.com/x/y', 'C:\\Windows\\explorer.cpl', 'C:\\a\\b.bat', null, '', 42, 'C:\\x\\y.exe']) {
    assert.equal(upd.runUpdate(bad, { spawn: fake }).ok, false, `must refuse ${String(bad)}`);
  }
  assert.equal(calls.length, 1);                               // nothing spawned for a refusal
  assert.equal(upd.runUpdate(dl.path, { spawn: () => { throw new Error('nope'); } }).ok, false);
});

test('a newer release clears stale download state — an old failure cannot hide the new offer', async () => {
  upd._reset();
  const dir = tmpDir();
  const bad = await upd.downloadUpdate({
    asset: dlAsset(Buffer.from('real'), { sha256: 'f'.repeat(64) }), tag: 'v1.2.0',
    authenticated: true, destDir: dir, fetch: async () => fakeDownload([Buffer.from('real')])
  });
  assert.equal(bad.ok, false);
  assert.ok(upd.snapshot('1.0.0', NaN).download.error, 'the failure is visible while the release is the same');
  await upd.check({
    fetch: async () => fakeResponse(ghRelease({ tag_name: 'v1.3.0' })),
    appVersion: '1.0.0', appPublishMs: NaN, now: () => 20
  });
  const s = upd.snapshot('1.0.0', NaN);
  assert.equal(s.info.tag, 'v1.3.0');
  assert.equal(s.status, 'available');
  assert.equal(s.download, null, 'the previous release’s download/error line must not follow the new one');
});

test('snapshot exposes no download at all before one has been attempted', () => {
  upd._reset();
  assert.equal(upd.snapshot('1.0.0', NaN).download, null);
});

/* ------------------------------ hardening -------------------------------- */

test('sanitizeRelease pins asset URLs to our repo or the GitHub asset CDN, https only', () => {
  const rel = sanitizeRelease(ghRelease({
    assets: [
      { name: 'ours.exe', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/ours.exe' },
      { name: 'cdn.exe', size: 1, browser_download_url: 'https://objects.githubusercontent.com/objects/1/cdn.exe' },
      { name: 'fork.exe', size: 1, browser_download_url: 'https://github.com/evil-owner/Nucleus/releases/download/v1.2.0/fork.exe' },
      { name: 'other.exe', size: 1, browser_download_url: 'https://github.com/mockcomic/other-repo/releases/download/v1.2.0/other.exe' },
      { name: 'down.exe', size: 1, browser_download_url: 'http://github.com/mockcomic/Nucleus/releases/download/v1.2.0/down.exe' },
      { name: 'codeload.exe', size: 1, browser_download_url: 'https://codeload.github.com/mockcomic/Nucleus/tar.gz/v1.2.0' },
      { name: 'query.exe', size: 1, browser_download_url: 'https://objects.githubusercontent.com/x/query.exe?token=abc' },
      { name: 'dotdot', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/dotdot' }
    ]
  }));
  assert.deepEqual(rel.assets.map((a) => a.name), ['ours.exe', 'cdn.exe', 'query.exe', 'dotdot']);
});

test('sanitizeRelease drops dot-only asset names (a basename of ".." is not a file)', () => {
  const rel = sanitizeRelease(ghRelease({
    assets: [
      { name: '..', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/x' },
      { name: '.', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/x' },
      { name: '.hidden', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/x' }
    ]
  }));
  assert.deepEqual(rel.assets.map((a) => a.name), ['.hidden']);
});

test('downloadUpdate follows redirects only back to the update hosts over https', async () => {
  const body = Buffer.from('installer-bytes');
  const good = cry.createHash('sha256').update(body).digest('hex');
  for (const [where, want] of [
    ['https://evil.example/f.exe', /left the update hosts/],
    ['http://objects.githubusercontent.com/f.exe', /left the update hosts/]
  ]) {
    upd._reset();
    const dir = tmpDir();
    const r = await upd.downloadUpdate({
      asset: dlAsset(body, { sha256: good }), authenticated: true, destDir: dir,
      fetch: async () => fakeDownload([body], true, 200, where)
    });
    assert.equal(r.ok, false, where);
    assert.match(r.error, want);
    assert.equal(fsx.readdirSync(dir).length, 0, 'a rejected redirect leaves nothing behind');
  }
  // A redirect that stays on github.com is fine.
  upd._reset();
  const dir = tmpDir();
  const r = await upd.downloadUpdate({
    asset: dlAsset(body), authenticated: true, destDir: dir,
    fetch: async () => fakeDownload([body], true, 200, 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/f.exe')
  });
  assert.equal(r.ok, true);
});

test('downloadUpdate refuses an asset with no digest to match (no unsigned fallback)', async () => {
  upd._reset();
  const dir = tmpDir();
  const body = Buffer.from('unverified-installer');
  const r = await upd.downloadUpdate({
    asset: dlAsset(body, { sha256: null }), destDir: dir, authenticated: true,
    fetch: async () => fakeDownload([body])
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/);
  assert.equal(fsx.readdirSync(dir).length, 0);
  assert.equal(upd.snapshot('1.0.0', NaN).download, null);   // refused before any state
});

test('runUpdate only spawns a path this module just sha256-verified', async () => {
  upd._reset();
  const calls = [];
  const fake = (c) => { calls.push(c); return { unref() {} }; };
  assert.equal(upd.runUpdate('C:\\Users\\me\\Downloads\\Nucleus-setup.exe', { spawn: fake }).ok, false);
  assert.equal(calls.length, 0, 'a never-downloaded path spawns nothing');
  const dir = tmpDir();
  const body = Buffer.from('verified-installer');
  const r = await upd.downloadUpdate({ asset: dlAsset(body), authenticated: true, destDir: dir, fetch: async () => fakeDownload([body]) });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(upd.runUpdate(r.path, { spawn: fake }).ok, true);
  assert.deepEqual(calls, [r.path]);
});

test('downloadUpdate clears a stale .part left by a killed run', async () => {
  upd._reset();
  const dir = tmpDir();
  const body = Buffer.from('fresh-installer');
  const asset = dlAsset(body);
  const name = asset.url.slice(asset.url.lastIndexOf('/') + 1);
  fsx.writeFileSync(pax.join(dir, name + '.part'), 'half a gig of junk');
  const r = await upd.downloadUpdate({ asset, authenticated: true, destDir: dir, fetch: async () => fakeDownload([body]) });
  assert.equal(r.ok, true);
  assert.equal(fsx.existsSync(r.path + '.part'), false);
  assert.deepEqual(fsx.readFileSync(r.path), body);
});

test('a checksum mismatch is still refused even after a redirect stays on-host', async () => {
  upd._reset();
  const dir = tmpDir();
  const r = await upd.downloadUpdate({
    asset: dlAsset(Buffer.from('real'), { sha256: 'f'.repeat(64) }), destDir: dir, authenticated: true,
    fetch: async () => fakeDownload([Buffer.from('tampered')], true, 200, 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/x.exe')
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /checksum/);
  assert.equal(fsx.readdirSync(dir).length, 0);
  assert.notEqual(upd._internals().download.verified, true);
});

/* --------------------------- signed manifests ------------------------------ */

const crypto2 = require('node:crypto');
/* The signing side, mirrored in production by scripts/sign-release.mjs: the
   manifest is signed as the exact bytes transmitted (detached signature), so
   verification needs no canonicalization rules. */
const kp = crypto2.generateKeyPairSync('ed25519');
function signManifest(manifestObj, key = kp.privateKey) {
  const bytes = Buffer.from(JSON.stringify(manifestObj, null, 1) + '\n', 'utf8');
  return { bytes, sig: crypto2.sign(null, bytes, key) };
}
const manifestFor = (over = {}) => Object.assign({
  schema: 1, repo: 'mockcomic/Nucleus', tag: 'v1.2.0',
  generatedAt: '2026-10-01T00:00:00Z', nonce: 'n1',
  assets: [{ name: 'Nucleus-1.2.0-b1-setup.exe', sha256: 'a'.repeat(64), size: 10 }]
}, over);

test('verifyManifest accepts a signature made by the trusted key', () => {
  const m = manifestFor();
  const { bytes, sig } = signManifest(m);
  const r = upd.verifyManifest(bytes, sig.toString('base64'), 'v1.2.0', { keyPem: kp.publicKey.export({ type: 'spki', format: 'pem' }) });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.manifest.tag, 'v1.2.0');
  assert.equal(r.manifest.assets[0].sha256, 'a'.repeat(64));
});

test('verifyManifest rejects a tampered manifest, a sig from the wrong key, and junk sigs', () => {
  const keyPem = kp.publicKey.export({ type: 'spki', format: 'pem' });
  const { bytes, sig } = signManifest(manifestFor());
  const bad = (b) => upd.verifyManifest(b, sig.toString('base64'), 'v1.2.0', { keyPem });
  assert.equal(bad(Buffer.concat([bytes, Buffer.from(' ')])).ok, false);                 // one appended byte
  assert.equal(bad(Buffer.from(bytes.toString().replace('"v1.2.0"', '"v9.9.9"'))).ok, false); // swapped tag (sig dropped)
  const other = crypto2.generateKeyPairSync('ed25519');
  const forged = signManifest(manifestFor(), other.privateKey);
  assert.equal(upd.verifyManifest(forged.bytes, forged.sig.toString('base64'), 'v1.2.0', { keyPem }).ok, false);
  for (const junk of ['', '!!!!', 'YWJj', 'x'.repeat(200)]) {
    assert.equal(upd.verifyManifest(bytes, junk, 'v1.2.0', { keyPem }).ok, false, `sig "${junk}"`);
  }
  assert.equal(upd.verifyManifest(bytes, sig.toString('base64'), 'v1.2.0', { keyPem: null }).ok, false); // no key = fail closed
});

test('verifyManifest rejects a tag mismatch, foreign repo, and unknown schema', () => {
  const keyPem = kp.publicKey.export({ type: 'spki', format: 'pem' });
  const V = (obj, tag) => { const { bytes, sig } = signManifest(obj); return upd.verifyManifest(bytes, sig.toString('base64'), tag, { keyPem }); };
  assert.equal(V(manifestFor({ tag: 'v1.1.9' }), 'v1.2.0').ok, false);   // signed for another release
  assert.equal(V(manifestFor({ tag: 'v1.2.0;' }), 'v1.2.0').ok, false);
  assert.equal(V(manifestFor({ repo: 'evil/Nucleus' }), 'v1.2.0').ok, false);
  assert.equal(V(manifestFor({ schema: 2 }), 'v1.2.0').ok, false);
  assert.equal(V(manifestFor({ generatedAt: 'not-a-date' }), 'v1.2.0').ok, false);
  assert.equal(V(manifestFor({ assets: [] }), 'v1.2.0').ok, false);      // nothing to pin = no purpose
  assert.equal(V(manifestFor({ assets: [{ name: 'ok.exe', sha256: 'zz'.repeat(32) }] }), 'v1.2.0').ok, false); // bad hex
  assert.equal(V(manifestFor({ assets: [{ name: 'ok.exe', sha256: 'a'.repeat(64) }] }), 'v1.2.0').ok, true);   // size optional
});

/* check() drives two fetch URLs: the release JSON, and (when the release
   carries the manifest assets) the manifest + signature. */
function fetchRouter(routes) {
  return async (url) => {
    const hit = routes.find((r) => r.on.test(url));
    if (!hit) return { ok: false, status: 404, url };
    return hit.res;
  };
}

test('a release with a valid signed manifest is authenticated and pins its digests', async () => {
  upd._reset();
  const setup = signManifest(manifestFor({
    assets: [{ name: 'Nucleus-1.2.0-b1-setup.exe', sha256: 'b'.repeat(64), size: 10 }]
  }));
  const rel = ghRelease({
    assets: [
      ghRelease().assets[0],
      { name: 'update-manifest.json', size: 200, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json' },
      { name: 'update-manifest.json.sig', size: 88, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json.sig' }
    ]
  });
  const r = await upd.check({
    fetch: fetchRouter([
      { on: /api\.github\.com/, res: fakeResponse(rel) },
      { on: /update-manifest\.json$/, res: fakeResponse(setup.bytes) },
      { on: /\.sig$/, res: fakeResponse(setup.sig.toString('base64')) }
    ]),
    appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 1, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
  });
  assert.equal(r.status, 'available');
  const s = upd.snapshot('1.0.0', Date.parse('2020-01-01'));
  assert.equal(s.info.authenticated, true);
  assert.equal(s.info.authReason, null);
  const exe = s.info.assets.find((a) => a.name === 'Nucleus-1.2.0-b1-setup.exe');
  assert.equal(exe.sha256, 'b'.repeat(64));          // the MANIFEST digest is the authority
});

test('a tampered manifest makes the release browse-only (fail-safe), never an error and never verified', async () => {
  upd._reset();
  const setup = signManifest(manifestFor());
  const tampered = Buffer.from(setup.bytes.toString().replace('"' + 'a'.repeat(64), '"' + 'c'.repeat(63) + '1'));
  const rel = ghRelease({
    assets: [
      { name: 'Nucleus-1.2.0-b1-setup.exe', size: 1, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/Nucleus-1.2.0-b1-setup.exe' },
      { name: 'update-manifest.json', size: 200, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json' },
      { name: 'update-manifest.json.sig', size: 88, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json.sig' }
    ]
  });
  const r = await upd.check({
    fetch: fetchRouter([
      { on: /api\.github\.com/, res: fakeResponse(rel) },
      { on: /update-manifest\.json$/, res: fakeResponse(tampered) },   // signed content, edited
      { on: /\.sig$/, res: fakeResponse(setup.sig.toString('base64')) }
    ]),
    appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 2, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
  });
  assert.equal(r.ok, true);
  assert.equal(r.status, 'available');                                 // still offered, browse-only
  const s = upd.snapshot('1.0.0', Date.parse('2020-01-01'));
  assert.equal(s.info.authenticated, false);
  assert.match(s.info.authReason, /signature/);
  const dl = await upd.downloadUpdate({
    asset: s.info.assets[0], destDir: tmpDir(),
    fetch: async () => fakeDownload([Buffer.from('anything')])
  });
  assert.equal(dl.ok, false);
  assert.match(dl.error, /authentic/);                                 // not even downloaded
});

test('a manifest pair missing from the release leaves GitHub-digest verification but no authentication', async () => {
  upd._reset();
  const r = await upd.check({
    fetch: fetchRouter([{ on: /api\.github\.com/, res: fakeResponse(ghRelease()) }]),
    appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 3, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
  });
  assert.equal(r.status, 'available');
  const s = upd.snapshot('1.0.0', Date.parse('2020-01-01'));
  assert.equal(s.info.authenticated, false);
  assert.equal(s.info.authReason, 'no manifest');
  const dl = await upd.downloadUpdate({
    asset: { ...s.info.assets[0], sha256: cry.createHash('sha256').update(Buffer.from('x')).digest('hex') },
    destDir: tmpDir(), fetch: async () => fakeDownload([Buffer.from('x')])
  });
  assert.equal(dl.ok, false);                                          // unsigned release: no auto-download
  assert.match(dl.error, /authentic/);
});

test('a half pair (manifest without signature or back) fails closed', async () => {
  for (const which of ['json', 'sig']) {
    upd._reset();
    const setup = signManifest(manifestFor());
    const assets = [ghRelease().assets[0]];
    if (which === 'json') assets.push({ name: 'update-manifest.json', size: 200, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json' });
    else assets.push({ name: 'update-manifest.json.sig', size: 88, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json.sig' });
    const r = await upd.check({
      fetch: fetchRouter([
        { on: /api\.github\.com/, res: fakeResponse(ghRelease({ assets })) },
        { on: /update-manifest\.json$/, res: fakeResponse(setup.bytes) },
        { on: /\.sig$/, res: fakeResponse(setup.sig.toString('base64')) }
      ]),
      appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 4, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
    });
    assert.equal(r.status, 'available');
    assert.equal(upd.snapshot('1.0.0', Date.parse('2020-01-01')).info.authenticated, false, which);
  }
});

test('a manifest signed by another key fails closed, and a network hiccup degrades to browse-only', async () => {
  upd._reset();
  const other = crypto2.generateKeyPairSync('ed25519');
  const setup = signManifest(manifestFor(), other.privateKey);
  const pair = [
    { name: 'update-manifest.json', size: 200, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json' },
    { name: 'update-manifest.json.sig', size: 88, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json.sig' }
  ];
  const r = await upd.check({
    fetch: fetchRouter([
      { on: /api\.github\.com/, res: fakeResponse(ghRelease({ assets: [ghRelease().assets[0], ...pair] })) },
      { on: /update-manifest\.json$/, res: fakeResponse(setup.bytes) },
      { on: /\.sig$/, res: fakeResponse(setup.sig.toString('base64')) }
    ]),
    appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 5, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
  });
  assert.equal(r.status, 'available');
  const s = upd.snapshot('1.0.0', Date.parse('2020-01-01'));
  assert.equal(s.info.authenticated, false);
  assert.match(s.info.authReason, /signature/);

  upd._reset();
  const r2 = await upd.check({
    fetch: fetchRouter([
      { on: /api\.github\.com/, res: fakeResponse(ghRelease({ assets: [ghRelease().assets[0], ...pair] })) },
      { on: /update-manifest\.json$/, res: { ok: false, status: 500 } },
      { on: /\.sig$/, res: fakeResponse('AA==') }
    ]),
    appVersion: '1.0.0', appPublishMs: Date.parse('2020-01-01'), now: () => 6, verifyKeyPem: kp.publicKey.export({ type: 'spki', format: 'pem' })
  });
  assert.equal(r2.status, 'available');                                // fail-soft on transport
  assert.equal(upd.snapshot('1.0.0', Date.parse('2020-01-01')).info.authenticated, false);
});

test('downloadUpdate requires an authenticated release and gates the run on authentication', async () => {
  upd._reset();
  const dir = tmpDir();
  const body = Buffer.from('signed-installer');
  const asset = dlAsset(body);                                          // correct published digest
  const calls = [];
  const fake = (c) => { calls.push(c); return { unref() {} }; };
  // Unauthenticated release: the right checksum alone is not enough anymore.
  const r0 = await upd.downloadUpdate({ asset, destDir: dir, fetch: async () => fakeDownload([body]) });
  assert.equal(r0.ok, false);
  assert.match(r0.error, /authentic/);
  assert.equal(fsx.readdirSync(dir).length, 0);
  // Authenticated release: download + run.
  const r = await upd.downloadUpdate({ asset, destDir: dir, authenticated: true, fetch: async () => fakeDownload([body]) });
  assert.equal(r.ok, true);
  assert.equal(r.verified, true);
  assert.equal(r.authenticated, true);
  assert.equal(upd.snapshot('1.0.0', NaN).download.authenticated, true);
  assert.equal(upd.runUpdate(r.path, { spawn: fake }).ok, true);
  assert.deepEqual(calls, [r.path]);
  // Authenticated release but no digest to pin (manifest lost): refuse.
  upd._reset();
  const dir2 = tmpDir();
  const r2 = await upd.downloadUpdate({ asset: dlAsset(body, { sha256: null }), destDir: dir2, authenticated: true, fetch: async () => fakeDownload([body]) });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /checksum/);
});

test('chooseAsset never mistakes the manifest files for an installer', () => {
  const rel = sanitizeRelease(ghRelease({
    assets: [
      { name: 'update-manifest.json', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json' },
      { name: 'update-manifest.json.sig', size: 1, browser_download_url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/update-manifest.json.sig' }
    ]
  }));
  assert.equal(chooseAsset(rel, false), null);
  assert.equal(chooseAsset(rel, true), null);
});

test('the cache round-trip keeps manifest digests but never carries authentication', () => {
  // A release as saved by saveCache (already sanitized, digests folded in,
  // authenticated from the last live verification) re-enters through
  // sanitizeRelease: digests survive, authenticated does not — until the
  // next check re-verifies, a cached release is browse-only (fail-closed).
  const cached = {
    tag: 'v1.2.0', versionLabel: '1.2.0', publishedAt: '2026-10-01T00:00:00Z',
    name: 'N', draft: false, prerelease: false,
    assets: [{ name: 'Nucleus-1.2.0-b1-setup.exe', size: 10, sha256: 'a'.repeat(64), url: 'https://github.com/mockcomic/Nucleus/releases/download/v1.2.0/Nucleus-1.2.0-b1-setup.exe' }],
    authenticated: true, authReason: null
  };
  const rel = sanitizeRelease(cached);
  assert.equal(rel.assets[0].sha256, 'a'.repeat(64));
  assert.notEqual(rel.authenticated, true);
});
