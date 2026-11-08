'use strict';
/* The one network policy for every image the app fetches (custom icons,
   dashboard logos) and for the update system's downloads: what a URL may
   point AT, not just what it says. A pasted icon URL is untrusted input;
   an unchecked fetch turns it into a free probe of the user's network
   (http://127.0.0.1:3000, the cloud metadata IP, a redirect to either).

   Three layers, one source of truth:
     1. assertUrlAllowed  — URL shape: https (http only under the LAN
        opt-in), no credentials, and a hostname that is not ITSELF a
        blocked literal address.
     2. connect-time IP pinning — we resolve the hostname ourselves
        (dns.lookup all), reject the request when EVERY answer is blocked,
        then connect with options.hostname = the chosen IP while keeping
        servername = the original host. TLS SNI and certificate checks stay
        hostname-correct, and the name cannot be re-resolved to an internal
        address between the check and the connect (DNS rebinding), because
        the socket dials the validated literal.
     3. redirect walking — redirect:'manual' here; every hop re-runs layer 1
        (+2 at connect), and the walk dies at MAX_REDIRECTS.

   Blocked address classes (both families): loopback, RFC1918 + CGNAT
   100.64/10, link-local, multicast, unspecified, IPv6 unique-local, and
   IPv4-mapped v6 whose v4 half is blocked. 6to4 (2002::/16) is checked on
   its embedded v4 too — 2002:7f00:1:: is 127.0.0.1 in a trench coat.

   Errors are GENERIC on purpose: the user pastes a URL, the user does not
   need to learn that 10.0.4.7:8080 refused it — internal topology is
   exactly what an SSRF oracle would leak. */
const net = require('net');
const dns = require('node:dns').promises;
const undici = require('undici');

const MAX_REDIRECTS = 4;
const BLOCKED_MSG = 'that address is not allowed (it looks like a private or local network host)';
const GENERIC_MSG = 'Could not reach that address';

/** Address-class policy for one literal IP. Returns a reason string when
    blocked, null when public-enough to fetch. allowPrivate: the LAN toggle
    unblocks everything except the unspecified address and the metadata-ish
    link-local range users rarely serve icons from (we keep link-local and
    multicast blocked even under the toggle: they are not "my NAS"). */
function blockedReason(ip, { allowPrivate = false } = {}) {
  const v6mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (v6mapped && v6mapped[1] !== ip) return blockedReason(v6mapped[1], { allowPrivate });
  if (net.isIPv4(ip)) {
    const o = ip.split('.').map(Number);
    if (o[0] === 0) return 'unspecified';                            // 0.0.0.0/8
    if (o[0] === 127) return 'loopback';
    if (o[0] === 10) return allowPrivate ? null : 'private';
    if (o[0] === 172 && o[1] >= 16 && o[1] <= 31) return allowPrivate ? null : 'private';
    if (o[0] === 192 && o[1] === 168) return allowPrivate ? null : 'private';
    if (o[0] === 100 && o[1] >= 64 && o[1] <= 127) return allowPrivate ? null : 'carrier-nat';
    if (o[0] === 169 && o[1] === 254) return 'link-local';
    if (o[0] >= 224) return 'multicast/reserved';
    if (!allowPrivate && o[0] === 192 && o[1] === 0 && (o[2] === 0 || o[2] === 2)) return 'reserved'; // 192.0.0/24, 192.0.2 TEST-NET
    if (!allowPrivate && o[0] === 198 && (o[1] === 18 || o[1] === 19)) return 'benchmark';
    if (!allowPrivate && o[0] === 198 && o[1] === 51 && o[2] === 100) return 'reserved';
    if (!allowPrivate && o[0] === 203 && o[1] === 0 && o[2] === 113) return 'reserved';
    return null;
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (x === '::' || x === '::0') return 'unspecified';
    if (x === '::1') return 'loopback';
    const p = x.split('%')[0].split(':');
    // Expand embedded trailing IPv4 (::ffff:1.2.3.4 handled above; ::1.2.3.4 style too)
    const last = p[p.length - 1];
    if (net.isIPv4(last)) return blockedReason(last, { allowPrivate });
    const head = p[0] ? parseInt(p[0], 16) : 0;
    if ((head & 0xfe00) === 0xfc00) return allowPrivate ? null : 'unique-local';   // fc00::/7
    if ((head & 0xffc0) === 0xfe80) return 'link-local';                            // fe80::/10
    if ((head & 0xff00) === 0xff00) return 'multicast';                             // ff00::/12
    const g0 = parseInt(p[0] || '0', 16);
    const g1 = parseInt(p[1] || '0', 16);
    if (g0 === 0x2001 && g1 === 0x0000) {                                             // Teredo 2001:0000::/32 carries a v4 peer
      const relay = parseInt(p[2] || '0', 16), peer = parseInt(p[3] || '0', 16) ^ 0xffff;
      const peerIp = `${(peer >> 8) & 255}.${peer & 255}`;
      if (relay === 0 || blockedReason(peerIp, { allowPrivate })) return 'teredo-private';
      return null;
    }
    if (g0 === 0x2002) {                                                              // 6to4 embeds v4 in groups 1-2
      const r = blockedReason(`${(g1 >> 8) & 255}.${g1 & 255}.0.0`, { allowPrivate });
      if (r === 'loopback' || r === 'private' || r === 'carrier-nat' || r === 'link-local') return '6to4-' + r;
      return null;
    }
    return null;
  }
  return 'not-an-address';
}

/** True when a literal IP must not be dialed under the current policy. */
function isBlockedAddress(ip, policy = {}) { return blockedReason(ip, policy) !== null; }

/** Layer 1. Returns a WHATWG URL, or { error } — the error is user-safe
    (never echoes internals). Also honors the shape rules the icon store
    already enforced: no embedded credentials (they would be written to
    config.json forever), sane length. */
function assertUrlAllowed(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 2000) return { error: 'invalid URL' };
  let u;
  try { u = new URL(raw.trim()); } catch { return { error: 'invalid URL' }; }
  if (u.protocol !== 'https:') {
    if (u.protocol === 'http:') { if (!allowPrivate) return { error: 'plain HTTP is only allowed with the local-network icon setting on' }; }
    else return { error: 'unsupported URL scheme' };
  }
  if (u.username || u.password) return { error: 'URLs with embedded credentials are not allowed' };
  if (!u.hostname) return { error: 'invalid URL' };
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, ''))) {
    const r = blockedReason(u.hostname.replace(/^\[|\]$/g, ''), { allowPrivate });
    if (r) return { error: BLOCKED_MSG };
  }
  return { url: u };
}

/** Layer 2: an undici connector that resolves, classifies, and PINs.
    `lookupImpl` injectable for tests. Rejects before the socket when every
    A/AAAA answer is blocked; otherwise dials the chosen literal (SNI still
    carries the original host for correct certificate validation). */
function guardedConnector({ allowPrivate = false, lookupImpl = dns.lookup, baseConnect } = {}) {
  const base = baseConnect || undici.buildConnector({ allowH2: true });
  return function connect(options, callback) {
    const host = options.hostname || options.host;
    (async () => {
      if (!host) throw new Error(GENERIC_MSG);
      if (net.isIP(host)) {
        if (isBlockedAddress(host, { allowPrivate })) throw new Error(BLOCKED_MSG);
        return { ...options, host, hostname: host };
      }
      let answers;
      try {
        answers = await lookupImpl(host, { all: true, verbatim: true });
      } catch { throw new Error(GENERIC_MSG); }
      const ips = (answers || []).map((a) => a && a.address).filter(Boolean);
      if (!ips.length) throw new Error(GENERIC_MSG);
      const allowed = ips.find((ip) => !isBlockedAddress(ip, { allowPrivate }));
      if (!allowed) throw new Error(BLOCKED_MSG);
      return { ...options, host: allowed, hostname: allowed, servername: host };
    })().then((pinned) => {
      base(pinned, callback);
    }, (err) => callback(err));
  };
}

/* Undici dispatcher built lazily and cached per policy: one socket pool per
   (allowPrivate) class, not per request. allowH2 matches undici's default
   modern behavior and keeps the pooled connections reusable. */
const dispatchers = new Map();
function guardedDispatcher(policy = {}) {
  const key = policy.allowPrivate ? 'lan' : 'public';
  let d = dispatchers.get(key);
  if (!d) {
    d = new undici.Agent({
      connect: guardedConnector({ allowPrivate: policy.allowPrivate, lookupImpl: policy.lookupImpl }),
      allowH2: true, connections: 8, keepAliveTimeout: 4000, keepAliveMaxTimeout: 10000
    });
    dispatchers.set(key, d);
  }
  return d;
}

/** The one fetch every untrusted URL goes through. Manual redirects (layer
    3): follow ≤ MAX_REDIRECTS hops, assertUrlAllowed on every Location
    BEFORE requesting it, same guarded dispatcher throughout (so the hop's
    own DNS answer is pinned too). Body is returned as-is; callers keep
    using readCapped for size. Throws with user-safe messages. */
async function guardedFetch(rawUrl, init = {}, policy = {}) {
  const doFetch = policy.fetchImpl || undici.fetch;
  const dispatcher = policy.fetchImpl ? undefined : guardedDispatcher(policy);   // fakes never need (or build) a pool
  let next = assertUrlAllowed(rawUrl, policy);
  if (next.error) throw new Error(next.error);
  for (let hop = 0; ; hop++) {
    const res = await doFetch(next.url.href, {
      ...init, redirect: 'manual', dispatcher,
      signal: init.signal
    });
    const loc = res.status >= 301 && res.status < 308 && res.headers.get('location');
    if (!loc) return res;
    if (hop >= MAX_REDIRECTS) throw new Error('too many redirects');
    const drained = await res.body.cancel().catch(() => {});
    void drained;
    next = assertUrlAllowed(new URL(loc, next.url).href, policy);
    if (next.error) throw new Error(next.error);
  }
}

module.exports = {
  MAX_REDIRECTS, BLOCKED_MSG, GENERIC_MSG,
  blockedReason, isBlockedAddress, assertUrlAllowed, guardedConnector, guardedDispatcher, guardedFetch
};
