'use strict';
/* Unit tests for src/main/netguard.js — the whole SSRF policy without a
   single socket: the address classifier, the URL shape gate, the connector's
   resolve-then-pin decision (with a fake dns.lookup), and the redirect walk
   (undici.fetch swapped for a fake through require-cache injection). */
const test = require('node:test');
const assert = require('node:assert/strict');

const ng = require('../../src/main/netguard.js');
const { blockedReason, isBlockedAddress, assertUrlAllowed, guardedConnector } = ng;

/* ------------------------------ IP classes ------------------------------- */

const BLOCKED_V4 = ['127.0.0.1', '127.0.0.53', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.99.99',
  '192.168.1.254', '169.254.169.254', '100.64.0.1', '100.127.9.9', '0.0.0.0', '224.0.0.1', '239.10.0.1',
  '192.0.0.1', '198.18.0.1', '203.0.113.5', '::ffff:127.0.0.1', '::ffff:192.168.0.7', '2002:7f00:1::'];
const PUBLIC_V4 = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '173.194.0.0', '185.199.108.153', '203.0.114.1'];

test('the loopback, private, CGNAT, link-local and reserved v4/v6 ranges are blocked', () => {
  for (const ip of BLOCKED_V4) assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  for (const ip of ['::1', 'fe80::1', 'fc00::1', 'fd12:3456::7', 'ff02::1', '::']) {
    assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`);
  }
  for (const ip of PUBLIC_V4) assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`);
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false);
  assert.equal(isBlockedAddress('2606:4700::6810:8f42'), false);   // cloudflare
});

test('the LAN toggle unblocks private ranges but never link-local, multicast, loopback or unspecified', () => {
  for (const ip of ['10.0.0.1', '192.168.1.5', '172.20.0.1', '100.70.0.1', 'fd00::1']) {
    assert.equal(isBlockedAddress(ip, { allowPrivate: true }), false, ip);
  }
  for (const ip of ['127.0.0.1', '169.254.1.1', 'fe80::1', '224.0.0.1', 'ff02::2', '::', '::1']) {
    assert.equal(isBlockedAddress(ip, { allowPrivate: true }), true, ip);
  }
});

test('garbage and hostnames are refused by the classifier (it speaks only literals)', () => {
  assert.equal(isBlockedAddress('localhost'), true);
  assert.equal(isBlockedAddress('999.1.1.1'), true);
  assert.equal(isBlockedAddress(''), true);
  assert.equal(isBlockedAddress(null), true);
});

/* -------------------------------- URL gate ------------------------------- */

test('https is always fine; http needs the LAN toggle; creds and junk schemes are refused', () => {
  assert.equal(assertUrlAllowed('https://example.com/a.png').url.href, 'https://example.com/a.png');
  assert.match(assertUrlAllowed("http://example.com/a.png").error, /HTTP/);
  assert.equal(assertUrlAllowed('http://example.com/a.png', { allowPrivate: true }).url.href, 'http://example.com/a.png');
  assert.match(assertUrlAllowed('ftp://example.com/a').error, /scheme/);
  assert.match(assertUrlAllowed('file:///C:/Windows/win.ini').error, /scheme/);
  assert.match(assertUrlAllowed('https://user:***@example.com/').error, /credential/);
  assert.equal(assertUrlAllowed('https://127.0.0.1/x.png').error, ng.BLOCKED_MSG);          // literal IP shape check
  assert.equal(assertUrlAllowed('https://[::1]/x.png').error, ng.BLOCKED_MSG);
  assert.match(assertUrlAllowed('https://example.com/' + 'p'.repeat(2100)).error, /invalid/);
  assert.match(assertUrlAllowed(null).error, /invalid/);
  assert.equal(assertUrlAllowed('https://example.com/x.png', { allowPrivate: true }).url.href, 'https://example.com/x.png');
});

/* ------------------------- connect-time IP pinning ------------------------ */

function fakeLookup(table) {
  return async (host) => {
    const rows = table[host];
    if (!rows) throw new Error('ENOTFOUND ' + host);
    return rows.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

/* Run the connector with a fake base: the outcome is either the error the
   guard raised pre-socket, or the (host, servername) it handed the socket —
   which IS the security-relevant decision (what literal we dial, which name
   TLS must see). */
function connectOutcome(host, table, policy = {}) {
  return new Promise((resolve) => {
    const connect = guardedConnector({
      lookupImpl: fakeLookup(table),
      baseConnect: (opts) => resolve({ dialed: opts.hostname, servername: opts.servername }),
      ...policy
    });
    connect({ hostname: host, protocol: 'https:' }, (err) => { if (err) resolve(err); });
  });
}

test('a name whose every answer is private is refused before any socket', async () => {
  const out = await connectOutcome('nas.home', { 'nas.home': ['192.168.0.180', 'fe80::2aa:bb:cc:dd:ee:ff'] });
  assert.ok(out instanceof Error);
  assert.equal(out.message, ng.BLOCKED_MSG);
});

test('a rebinding name (public first, internal second) dials the validated PUBLIC answer and keeps TLS SNI on the hostname', async () => {
  const out = await connectOutcome('evil.example', { 'evil.example': ['93.184.216.34', '127.0.0.1'] });
  assert.deepEqual(out, { dialed: '93.184.216.34', servername: 'evil.example' });   // the socket dials the LITERAL we vetted; the name cannot re-resolve under it
});

test('a name that resolves only to the blocked class fails; a literal blocked IP is refused with no lookup at all', async () => {
  let lookedUp = false;
  const out = await new Promise((resolve) => {
    const connect = guardedConnector({
      lookupImpl: async (h) => { lookedUp = true; return [{ address: '169.254.169.254', family: 4 }]; },
      baseConnect: () => resolve('socket')
    });
    connect({ hostname: 'meta.example', protocol: 'https:' }, (err) => resolve(err));
  });
  assert.equal(out.message, ng.BLOCKED_MSG);
  assert.equal(lookedUp, true);
  const lit = await connectOutcome('10.1.2.3', { 'never.used': [] });
  assert.equal(lit.message, ng.BLOCKED_MSG);       // literal check: no DNS consulted
});

test('unknown names fail with the generic message, not a leaked resolver error', async () => {
  const out = await connectOutcome('gone.example', {});
  assert.equal(out.message, ng.GENERIC_MSG);
});

/* ----------------------------- redirect walk ------------------------------ */

function fakeResponse(status, location) {
  return {
    status,
    headers: { get: (h) => (String(h).toLowerCase() === 'location' ? location : null) },
    body: { cancel: async () => {} }
  };
}
function redirectFetch(script) {
  const seen = [];
  return {
    seen,
    fetchImpl: async (url) => {
      seen.push(url);
      const step = script[seen.length - 1];
      if (!step) throw new Error('requested past the script: ' + url);
      return step;
    }
  };
}

test('redirects are followed, re-validated at every hop, and capped', async () => {
  // fine: https -> https
  let f = redirectFetch([fakeResponse(302, 'https://cdn.example/x.png'), fakeResponse(200)]);
  const r = await ng.guardedFetch('https://example.com/a', {}, { fetchImpl: f.fetchImpl });
  assert.equal(r.status, 200);
  assert.deepEqual(f.seen, ['https://example.com/a', 'https://cdn.example/x.png']);
  // redirect into loopback: refused, and the internal URL was never fetched
  f = redirectFetch([fakeResponse(301, 'http://127.0.0.1/admin')]);
  await assert.rejects(ng.guardedFetch('https://example.com/a', {}, { fetchImpl: f.fetchImpl, allowPrivate: false }), /not allowed|HTTP/);
  assert.deepEqual(f.seen, ['https://example.com/a']);
  // redirect to a foreign scheme: refused
  f = redirectFetch([fakeResponse(302, 'ftp://example.com/x')]);
  await assert.rejects(ng.guardedFetch('https://example.com/a', {}, { fetchImpl: f.fetchImpl }), /scheme/);
  // the 5th hop dies
  f = redirectFetch(Array.from({ length: 6 }, (_, i) => fakeResponse(302, 'https://hop' + i + '.example/x')));
  await assert.rejects(ng.guardedFetch('https://example.com/a', {}, { fetchImpl: f.fetchImpl }), /too many redirects/);
  assert.equal(f.seen.length, ng.MAX_REDIRECTS + 1);
  // http first hop only under the toggle
  f = redirectFetch([fakeResponse(200)]);
  await assert.rejects(ng.guardedFetch('http://example.com/a', {}, { fetchImpl: f.fetchImpl }), /HTTP/);
  f = redirectFetch([fakeResponse(200)]);
  await ng.guardedFetch('http://192.168.0.9/a.png', {}, { fetchImpl: f.fetchImpl, allowPrivate: true });
  assert.equal(f.seen.length, 1);
});
