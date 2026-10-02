'use strict';
/* readCapped — the download byte-cap enforced DURING streaming (Low audit
   finding: content-length checks after full buffering let a lying host stream
   unbounded bytes into main). Pure, fake-response tests; no network. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { readCapped } = require('../../src/main/capped-fetch.js');

/* Fake Response: an async-iterable body plus a consumption counter, so the
   overflow test can prove the read bailed EARLY, not after the fact. */
function fakeRes(chunks, opts = {}) {
  let consumed = 0;
  const body = (async function* () {
    for (let i = 0; i < chunks.length; i++) {
      if (opts.throwAt === i) throw new Error('stream exploded');
      consumed++;
      yield chunks[i];
    }
  })();
  return { res: { body }, consumed: () => consumed };
}

const B = (s) => Buffer.from(s, 'latin1');

test('under the cap: returns the concatenated body', async () => {
  const { res } = fakeRes([B('abc'), B('def')]);
  const got = await readCapped(res, 1024);
  assert.equal(got.buf && got.buf.toString('latin1'), 'abcdef');
  assert.equal(got.overflow, undefined);
});

test('raw Uint8Array chunks (what undici yields) are accepted too', async () => {
  const { res } = fakeRes([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5])]);
  const got = await readCapped(res, 1024);
  assert.deepEqual([...got.buf], [1, 2, 3, 4, 5]);
});

test('over the cap: overflow reported WITHOUT consuming the whole body', async () => {
  const big = [B('x'.repeat(10)), B('x'.repeat(10)), B('x'.repeat(10)), B('x'.repeat(1000))];
  const { res, consumed } = fakeRes(big);
  const got = await readCapped(res, 15);
  assert.equal(got.overflow, true);
  assert.equal(got.buf, undefined);
  assert.ok(consumed() <= 3, `bailed at chunk ${consumed()}/4 — the lying tail never buffered`);
});

test('exactly-at-cap is not an overflow', async () => {
  const { res } = fakeRes([B('12345')]);
  const got = await readCapped(res, 5);
  assert.equal(got.buf && got.buf.length, 5);
});

test('empty body yields an empty buffer (callers decide the wording)', async () => {
  const { res } = fakeRes([]);
  const got = await readCapped(res, 10);
  assert.ok(Buffer.isBuffer(got.buf));
  assert.equal(got.buf.length, 0);
});

test('mid-stream error is reported as failed, never throws', async () => {
  const { res } = fakeRes([B('ab'), B('cd')], { throwAt: 1 });
  const got = await readCapped(res, 1024);
  assert.equal(got.failed, true);
  assert.equal(got.buf, undefined);
});

test('missing body or response is failed, not a crash', async () => {
  assert.equal((await readCapped({}, 10)).failed, true);
  assert.equal((await readCapped(null, 10)).failed, true);
});
