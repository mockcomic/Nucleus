'use strict';
/* Unit tests for src/main/args.js — the quote-aware tokenizer feeding the
   `app` action's launch parameters. Pure module: no Electron, no spawning. */
const test = require('node:test');
const assert = require('node:assert/strict');

const { splitArgs, MAX_TOKENS } = require('../../src/main/args');

test('splitArgs: empty and whitespace-only inputs yield no tokens', () => {
  for (const junk of ['', '   ', '\t \n ', null, undefined]) {
    assert.deepEqual(splitArgs(junk), [], `input ${JSON.stringify(junk)}`);
  }
});

test('splitArgs: plain whitespace runs split, collapse, and trim', () => {
  assert.deepEqual(splitArgs('a  b\tc   d'), ['a', 'b', 'c', 'd']);
  assert.deepEqual(splitArgs('  --flag=1  /x  '), ['--flag=1', '/x']);
});

test('splitArgs: quoted phrase is one token with quotes consumed', () => {
  assert.deepEqual(splitArgs('--path "C:\\My Docs" /x'), ['--path', 'C:\\My Docs', '/x']);
  assert.deepEqual(splitArgs('"hello world"'), ['hello world']);
});

test('splitArgs: attached quote group continues the same token', () => {
  assert.deepEqual(splitArgs('--flag="a b"'), ['--flag=a b']);
  assert.deepEqual(splitArgs('-p"C:\\x y"'), ['-pC:\\x y']);
});

test('splitArgs: unclosed quote takes the remainder, no throw', () => {
  assert.deepEqual(splitArgs('say "hello'), ['say', 'hello']);
  assert.deepEqual(splitArgs('--x "a b'), ['--x', 'a b']);
});

test('splitArgs: "" is one explicit empty argument, not nothing', () => {
  assert.deepEqual(splitArgs('""'), ['']);
  assert.deepEqual(splitArgs('"" x'), ['', 'x']);
  assert.deepEqual(splitArgs('a "" b'), ['a', '', 'b']);
});

test('splitArgs: token cap folds the overflow into the last token', () => {
  const many = Array.from({ length: MAX_TOKENS + 36 }, (_, i) => `t${i}`).join(' ');
  const out = splitArgs(many);
  assert.equal(out.length, MAX_TOKENS);
  assert.equal(out[MAX_TOKENS - 2], `t${MAX_TOKENS - 2}`);
  assert.equal(out[MAX_TOKENS - 1],
    Array.from({ length: 37 }, (_, k) => `t${MAX_TOKENS - 1 + k}`).join(' '));
});

test('splitArgs: non-string input is coerced, never crashes', () => {
  assert.deepEqual(splitArgs(42), ['42']);
  assert.deepEqual(splitArgs({ toString: () => 'a "b c"' }), ['a', 'b c']);
});
