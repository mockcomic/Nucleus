/* Renderer-contract tests: the theme chips build through the shared wheel
   renderer, and every CSS var the renderer injects has a :root fallback in
   settings.css. Tiny DOM stub — no jsdom dependency, per test-bootstrap. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { buildWheel } from '../src/renderer/shared/wheel-core.js';
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
