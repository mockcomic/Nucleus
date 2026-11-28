/* Renderer-contract tests: the theme chips build through the shared wheel
   renderer, and every CSS var the renderer injects has a :root fallback in
   settings.css. Tiny DOM stub — no jsdom dependency, per test-bootstrap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildWheel } from '../src/renderer/shared/wheel-core.js';
import { TYPE_ICON, TYPE_ICON_FALLBACK } from '../src/renderer/shared/icon-catalog.js';
import { THEMES, chromeVarMap, computeChrome } from '../src/main/themes.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ── DOM stub ── */
function makeNode() {
  return {
    children: [], attrs: {}, style: { setProperty(k, v) { this[k] = v; } },
    classList: { add() {}, remove() {}, toggle() {} },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    removeAttribute(k) { delete this.attrs[k]; },
    getAttribute(k) { return this.attrs[k]; },
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c) { this.children.unshift(c); return c; },
    addEventListener() {},
    textContent: '', innerHTML: '',
  };
}
globalThis.document = {
  createElementNS(_ns, tag) { const n = makeNode(); n.tag = tag; return n; },
};
globalThis.matchMedia = () => ({ matches: false });

test('theme chips: buildWheel renders a themed mini wheel for every catalog theme', () => {
  for (const t of THEMES) {
    const host = makeNode();
    const cfg = {
      appearance: {
        innerRadius: 12, outerRadius: 27, ringSplit: 0.5, startAngle: 0, gapDeg: 3,
        showLabels: false, fontSize: 12, centerLabel: '', animationMs: 0, colors: t.colors,
      },
      rings: {
        1: Array.from({ length: 4 }, (_, i) => ({ id: 'a' + i, label: 'x', icon: '\uE700', type: 'app', value: '', color: null })),
        2: Array.from({ length: 8 }, (_, i) => ({ id: 'b' + i, label: 'y', icon: '', type: 'app', value: '', color: null })),
      },
    };
    const w = buildWheel(host, cfg, { preview: true, scale: 1 });
    assert.ok(w.segments.length >= 12, t.id + ' segments');
    const first = w.segments[0].path.attrs;
    assert.equal(first.fill, t.colors.ring1, t.id + ' ring1 fill');
    assert.equal(w.segments.find((s) => s.ring === 2).path.attrs.fill, t.colors.ring2, t.id + ' ring2 fill');
    // hover swap keeps text readable — the renderer's one role in the a11y chain
    w.setHover(w.segments[0]);
    assert.equal(w.segments[0].path.attrs.fill, t.colors.hover, t.id + ' hover fill');
  }
});

test('the machined rim is the only disc appearance.showRim removes', () => {
  const discs = (appearance) => {
    const host = makeNode();
    buildWheel(host, {
      appearance: {
        innerRadius: 12, outerRadius: 27, ringSplit: 0.5, startAngle: 0, gapDeg: 3,
        showLabels: false, fontSize: 12, centerLabel: '', animationMs: 0,
        colors: THEMES[0].colors, ...appearance,
      },
      rings: { 1: Array.from({ length: 6 }, (_, i) => ({ id: 'a' + i, label: 'x', icon: '', type: 'app', value: '', color: null })) },
    }, { preview: true, scale: 1 });
    const found = [];
    (function walk(n) {
      if (n.attrs && typeof n.attrs.class === 'string') found.push(n.attrs.class);
      for (const c of n.children || []) walk(c);
    })(host);
    return found;
  };
  assert.ok(discs({}).includes('rim'), 'absent flag = the rim every pre-toggle config drew');
  assert.ok(discs({ showRim: true }).includes('rim'), 'explicit on = rim');
  const off = discs({ showRim: false });
  assert.ok(!off.includes('rim'), 'off = no rim disc at all');
  assert.ok(off.includes('top-light') && off.includes('hub-top'), 'the rest of the machined-light pass survives');
});

test('every segment type has its own default glyph', () => {
  const codes = Object.values(TYPE_ICON);
  assert.equal(new Set(codes).size, codes.length, 'two types share a default glyph');
  assert.ok(!codes.includes(TYPE_ICON_FALLBACK), 'the fallback must not collide with a real type');
});

/* Plate-content rule: a plate carries a label, chosen art, or — when it
   shows no label — the TYPE_ICON default. Blank squares were the bug. */
test('artless plates wear their type glyph; labeled plates stay clean', () => {
  const appearance = (over) => ({
    innerRadius: 12, outerRadius: 60, ringSplit: 0.5, startAngle: 0, gapDeg: 3,
    showLabels: true, fontSize: 12, centerLabel: '', animationMs: 0,
    colors: THEMES[0].colors, ...over,
  });
  const glyphsIn = (host) => {
    const found = [];
    (function walk(n) {
      if (n.attrs && n.attrs.class === 'seg-icon') found.push(n.textContent);
      for (const c of n.children || []) walk(c);
    })(host);
    return found;
  };
  const types = Object.keys(TYPE_ICON);
  const items = types.map((t, i) => ({
    id: 't' + i, label: 'Seg ' + t, icon: '', iconImage: '', type: t, value: '',
    hideLabel: true,   // the user's live config: every container hid its label
  }));
  const host = makeNode();
  buildWheel(host, { appearance: appearance({}), rings: { 1: items } }, { preview: true, scale: 1 });
  assert.deepEqual(glyphsIn(host), types.map((t) => TYPE_ICON[t]), 'each type must draw its own default');

  // A plate that shows its label keeps the deliberate text-only look.
  const labeled = makeNode();
  buildWheel(labeled, {
    appearance: appearance({}),
    rings: { 1: [{ id: 'a', label: 'Notepad', icon: '', type: 'app', value: 'notepad.exe' }] },
  }, { preview: true, scale: 1 });
  assert.deepEqual(glyphsIn(labeled), [], 'a labelled artless plate draws no default glyph');

  // A chosen icon is never overridden by the map, label or no label.
  const chosen = makeNode();
  buildWheel(chosen, {
    appearance: appearance({}),
    rings: { 1: [{ id: 'a', label: 'X', icon: '\uE72C', type: 'folder', value: '' }] },
  }, { preview: true, scale: 1 });
  assert.deepEqual(glyphsIn(chosen), ['\uE72C']);

  // Legacy/hand-edited configs: an unmapped type still gets a neutral mark,
  // and the decorative theme chips opt out entirely (plates are the message).
  const legacy = makeNode();
  buildWheel(legacy, {
    appearance: appearance({}),
    rings: { 1: [{ id: 'a', label: '', icon: '', type: 'widget', value: '' }] },
  }, { preview: true, scale: 1 });
  assert.deepEqual(glyphsIn(legacy), [TYPE_ICON_FALLBACK]);
  const chip = makeNode();
  buildWheel(chip, {
    appearance: appearance({ showLabels: false }),
    rings: { 1: [{ id: 'a', label: 'X', icon: '', type: 'app', value: '' }] },
  }, { preview: true, scale: 1, noTypeIcon: true });
  assert.deepEqual(glyphsIn(chip), [], 'noTypeIcon suppresses the default');
});

test('chromeVarMap covers exactly the vars settings.css consumes from <html>', () => {
  const css = readFileSync(path.join(ROOT, 'src/renderer/settings/settings.css'), 'utf8');
  const map = chromeVarMap(computeChrome(THEMES[0].colors));
  for (const v of Object.keys(map)) {
    assert.ok(css.includes('var(' + v + ')') || css.includes(v + ':'), 'settings.css never uses ' + v);
  }
});

test('chrome values are empty-safe for a midnight palette (no undefined vars applied)', () => {
  const map = chromeVarMap(computeChrome(THEMES[0].colors));
  for (const [k, v] of Object.entries(map)) {
    assert.ok(typeof v === 'string' && v && !v.includes('undefined'), k + ' = ' + v);
  }
});
