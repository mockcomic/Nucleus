/* Disclosure-key decision for the Settings → Segments list
   (shared/seg-keys.collapseEditorKey) — the one line that decides what stays
   open when a chevron closes. Pure, so the sub-menu collapse regression is
   covered without a DOM. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { collapseEditorKey } from '../../src/renderer/shared/seg-keys.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/* ------------------------- the reported regression --------------------------
   Folder row "1-0" is open; its child "1-0/0" is opened, then closed. The
   parent's sub-menu manager survives only while openEditorKey still carries a
   "1-0/…" descendant key — so closing the child must fall back to "1-0",
   never to null (that collapsed the whole folder panel). */
test('closing a sub-menu row hands the panel back to its parent folder row', () => {
  assert.equal(collapseEditorKey('1-0/0'), '1-0');
});

test('the fallback is one level only — a grandchild returns to its own folder', () => {
  assert.equal(collapseEditorKey('1-0/2/1'), '1-0/2');
  assert.equal(collapseEditorKey('2-11/0/3/2'), '2-11/0/3');
});

/* ------------------------------ ring-level rows -----------------------------
   Nothing contains them, so they still collapse to nothing (unchanged). */
test('closing a ring-level row collapses to nothing — there is no ancestor', () => {
  for (const k of ['1-0', '3-11', '']) assert.equal(collapseEditorKey(k), null, k);
});

test('junk keys collapse to nothing instead of throwing', () => {
  for (const k of [null, undefined, 42, {}, ['/x'], true]) {
    assert.equal(collapseEditorKey(k), null, String(k));
  }
});

test('a nested key never falls back to a prefix that is not its parent', () => {
  // ring "11" must not be mistaken for the parent of ring "1"
  assert.equal(collapseEditorKey('11-0/0'), '11-0');
});

/* --------------------------- the consumer's contract ------------------------ */
test('settings.js routes the disclosure close through the helper (no bare null)', () => {
  const src = readFileSync(path.join(ROOT, 'src/renderer/settings/settings.js'), 'utf8');
  const body = src.slice(src.indexOf('const toggleEditor = () => {'));
  const lines = body.slice(0, body.indexOf('};')).split('\n').filter((l) => l.includes('openEditorKey ='));
  assert.equal(lines.length, 1, 'toggleEditor assigns openEditorKey exactly once');
  assert.match(lines[0], /collapseEditorKey\(key\)/, 'the close branch restores the ancestor key');
  assert.ok(!/= null/.test(lines[0]), 'the close branch does not blank the key');
});
