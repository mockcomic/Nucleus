'use strict';
/* The `url` action's scheme guard is a real allowlist now: only http(s) and
   mailto pass through as written, everything else gets https:// prepended —
   so file:// and exotic protocol handlers can never reach shell.openExternal
   verbatim. Pure function; no shell interaction. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { safeExternalUrl } = require('../../src/main/actions.js');

test('allowed schemes pass through unchanged', () => {
  assert.equal(safeExternalUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(safeExternalUrl('http://example.com'), 'http://example.com');
  assert.equal(safeExternalUrl('HTTPS://Example.COM'), 'HTTPS://Example.COM', 'case-insensitive');
  assert.equal(safeExternalUrl('mailto:someone@example.com'), 'mailto:someone@example.com',
    'mailto has no "://" and must not be mangled by the https default');
});

test('bare hosts keep defaulting to https', () => {
  assert.equal(safeExternalUrl('example.com'), 'https://example.com');
  assert.equal(safeExternalUrl('example.com/path#frag'), 'https://example.com/path#frag');
});

test('hostile and exotic schemes are defused into https URLs', () => {
  for (const bad of [
    'file://C:/Windows/System32/calc.exe',
    'file:///etc/passwd',
    'ftp://example.com/pub',
    'javascript:alert(1)',
    'ldap://example.com/x',
    'search-ms://example',
    'ms-ms-settings:whatever',
    'https:file://C:/Windows/System32/calc.exe',
  ]) {
    const out = safeExternalUrl(bad);
    assert.notEqual(out, bad, `${bad} must not be forwarded as written`);
    assert.ok(out.startsWith('https://'), `${bad} must not reach openExternal as written (got ${out})`);
    assert.ok(!/^https:\/\/https?:|^https:\/\/mailto:/i.test(out), 'no double-scheme mangling of allowed forms');
    const parsed = new URL(out);
    assert.equal(parsed.protocol, 'https:');
  }
});
