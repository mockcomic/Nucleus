/* Pure decision helpers for marking selection and type-to-filter
   (wheel-core.decideMarking / rankMatches) — the tables the overlay gestures
   run on, covered without a DOM (import is document-free at top level). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideMarking, rankMatches } from '../../src/renderer/shared/wheel-core.js';

/* ------------------------------ decideMarking ------------------------------ */
const leaf = { item: { id: 'l', type: 'app' } };
const folder = { item: { id: 'f', type: 'folder', children: [] } };

test('release on a leaf plate fires — including the plate the press started on (plain click)', () => {
  assert.equal(decideMarking({ pressSeg: leaf, releaseSeg: leaf }), 'fire');
  assert.equal(decideMarking({ pressSeg: null, releaseSeg: leaf }), 'fire');   // press off-wheel, release on a leaf (sweep-in)
});

test('release on a folder plate toggles its fan (never fires — containers execute nothing)', () => {
  assert.equal(decideMarking({ pressSeg: leaf, releaseSeg: folder }), 'toggle');
  assert.equal(decideMarking({ pressSeg: folder, releaseSeg: folder }), 'toggle');
});

test('release off the wheel cancels — the wheel stays open and nothing runs', () => {
  assert.equal(decideMarking({ pressSeg: leaf, releaseSeg: null }), 'cancel');
  assert.equal(decideMarking({}), 'cancel');
});

test('release on the hub is the back-out/dismiss gesture', () => {
  assert.equal(decideMarking({ pressSeg: leaf, releaseSeg: leaf, onHub: true }), 'dismiss');
  assert.equal(decideMarking({ onHub: true }), 'dismiss');
});

test('a folder record without item type still fires safely (junk config guard)', () => {
  assert.equal(decideMarking({ releaseSeg: {} }), 'fire');                      // no .item → not a folder
});

/* -------------------------------- rankMatches ------------------------------- */
const items = [
  { id: '1', label: 'Calculator', value: 'calc.exe' },
  { id: '2', label: 'Studio Calculator Pro', value: 'calcpro.exe' },
  { id: '3', label: 'Browser', value: 'https://calc.dev' },
  { id: '4', label: 'Notes', value: 'notepad.exe' },
  null, 'junk', 42
];

test('empty / whitespace queries match nothing (the wheel stays untouched)', () => {
  assert.deepEqual(rankMatches(items, ''), []);
  assert.deepEqual(rankMatches(items, '   '), []);
  assert.deepEqual(rankMatches(items, null), []);
});

test('label prefixes outrank label substrings, which outrank value hits', () => {
  const got = rankMatches(items, 'calc').map((x) => x.id);
  assert.deepEqual(got, ['1', '2', '3']);      // Calculator(prefix) < Studio Calculator Pro(sub) < value url
});

test('matching is case-insensitive on both label and value', () => {
  assert.deepEqual(rankMatches(items, 'NOTES').map((x) => x.id), ['4']);
  assert.deepEqual(rankMatches(items, 'CALC.DEV').map((x) => x.id), ['3']);
});

test('junk entries are skipped without throwing', () => {
  assert.deepEqual(rankMatches(items, 'calc').length, 3);
  assert.deepEqual(rankMatches(null, 'x'), []);
  assert.deepEqual(rankMatches(undefined, 'x'), []);
});

test('a query nothing matches returns the empty list (everything dims, nothing selected)', () => {
  assert.deepEqual(rankMatches(items, 'zzzz'), []);
});
