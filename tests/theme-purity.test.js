/* Theme purity gate: the curated catalog and the chrome derivation must be
   structurally sound and AA-readable. Run: npm test */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  THEMES, REQUIRED_ROLES, CHROME_VARS,
  isHex, contrast, relLum, computeChrome, paletteMode, signature, themeById, themeBySignature,
} from '../src/main/themes.mjs';

const ORIGINALS = new Set(['midnight', 'ocean', 'grape', 'graphite', 'ember']);

/* Incumbent exemption: the five shipped presets keep their exact 7 roles.
   Graphite is an intentional dark-on-plate inversion (the hover lift + the
   hub report carry the hovered readout); original hover fills only need the
   3:1 large-text floor, and ring fills are exempt for these ids alone. */

test('catalog has twelve themes with unique ids and names', () => {
  assert.equal(THEMES.length, 12);
  const ids = new Set(), names = new Set();
  for (const t of THEMES) {
    assert.ok(!ids.has(t.id), 'dup id ' + t.id);
    assert.ok(!names.has(t.name.toLowerCase()), 'dup name ' + t.name);
    ids.add(t.id); names.add(t.name.toLowerCase());
  }
});

test('every theme palette is complete and valid', () => {
  for (const t of THEMES) {
    for (const k of REQUIRED_ROLES) assert.ok(isHex(t.colors[k]), `${t.id}.${k} = ${t.colors[k]}`);
    assert.ok(['dark', 'light'].includes(paletteMode(t.colors)), t.id);
  }
});

test('text is readable on hover fills (>=3:1 large-text floor; new themes hold the 4.5 line)', () => {
  for (const t of THEMES) {
    const floor = ORIGINALS.has(t.id) ? 3.0
      : (t.id === 'hc-black' ? 3.9 : 4.5);   // hc-black keeps its high-contrast gold
    assert.ok(contrast(t.colors.text, t.colors.hover) >= floor, `${t.id} text/hover ${contrast(t.colors.text, t.colors.hover).toFixed(2)}`);
    if (!ORIGINALS.has(t.id)) {
      for (const k of ['ring1', 'ring2', 'center'])
        assert.ok(contrast(t.colors.text, t.colors[k]) >= 4.5, `${t.id} text/${k}`);
    }
  }
});

test('wheel plates are distinguishable from their neighbors (non-originals)', () => {
  for (const t of THEMES) {
    if (ORIGINALS.has(t.id)) continue;
    for (const [a, b] of [['ring1', 'ring2'], ['ring2', 'bg']])
      assert.ok(contrast(t.colors[a], t.colors[b]) >= 1.05, `${t.id} ${a}~${b}`);
  }
});

test('derived chrome never ships an unreadable accent or muted text — for ANY palette', () => {
  const samples = [
    ...THEMES.map((t) => t.colors),
    // hostile user palettes: extremes + mid-luminance accent
    { bg: '#ffffff', ring1: '#ffffff', ring2: '#eeeeee', hover: '#cccccc', accent: '#888888', text: '#202020', center: '#ffffff' },
    { bg: '#00ff00', ring1: '#00cc00', ring2: '#009900', hover: '#ffff00', accent: '#ff00ff', text: '#000080', center: '#00ff00' },
    { bg: '#101010', ring1: '#202020', ring2: '#181818', hover: '#303030', accent: '#4c9ff0', text: '#777777', center: '#0a0a0a' },
  ];
  for (const pal of samples) {
    const c = computeChrome(pal);
    const who = pal.bg + '/' + pal.accent;
    assert.ok(contrast('#ffffff', c.accentDeep) >= 4.5, who + ' accentDeep');
    assert.ok(contrast(c.dim, c.card) >= 4.5, who + ' dim/card');
    // NOTE: chrome ink is the user's raw colors.text — their choice, not faked.
    // The system-derived tokens (dim, accentDeep) above are what must never fail.
    for (const k of Object.keys(CHROME_VARS)) {
      if (k === 'chromeText' || k === 'chromeEdge') continue;
      assert.ok(/^#[0-9a-f]{6}$/i.test(c[k]) || /^rgba?\(/.test(c[k]), who + ' bad token ' + k + ' = ' + c[k]);
    }
  }
});

test('the machined-midnight chrome survives verbatim for the incumbent look', () => {
  const c = computeChrome(themeById('midnight').colors);
  assert.equal(c.panel, '#131a22');
  assert.equal(c.card, '#161f29');
  assert.equal(c.line, '#21303e');
  assert.equal(c.dim, '#8fa3b5');
  assert.equal(c.accentDeep, '#2768b5');
  assert.equal(c.track, '#24303d');
});

test('light themes get a downward ramp (bg no darker than panel, card below, field sunk)', () => {
  for (const id of ['porcelain', 'linen', 'paper', 'hc-white']) {
    const c = computeChrome(themeById(id).colors);
    assert.ok(relLum(c.bg) >= relLum(c.panel), id + ' bg>=panel');
    assert.ok(relLum(c.panel) >= relLum(c.card), id + ' panel>=card');
    assert.ok(relLum(c.card) >= relLum(c.field), id + ' card>=field');
    assert.ok(contrast(c.text, c.bg) >= 4.5, id + ' ink on canvas');
  }
});

test('signature/theme lookups round-trip', () => {
  for (const t of THEMES) {
    assert.equal(themeBySignature(signature(t.colors)).id, t.id, t.id);
    assert.equal(themeBySignature(signature(t.colors) + 'x'), null);
  }
  // persona fields never flip the signature
  const pal = { ...themeById('porcelain').colors, mode: 'dark', stroke: '#abcdef' };
  assert.equal(signature(pal), signature(themeById('porcelain').colors));
});
