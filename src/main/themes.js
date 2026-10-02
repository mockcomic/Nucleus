'use strict';
/* Main-process bridge to the shared theme registry (themes.mjs).
   themes.mjs is plain ESM so the renderer and node:test import it directly.
   Electron's main process is CommonJS and must not require ESM, so we read
   the file and evaluate it in a bare vm context: every `export ` prefix is
   stripped (declarations stay) and the program value becomes THEMES. Keep
   themes.mjs dependency-free (no imports) — that's what makes this sound,
   and node --test (tests/theme-purity.test.js) verifies the catalog anyway. */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const log = require('./logger');

const FILE = path.join(__dirname, 'themes.mjs');

function loadThemes() {
  let src = fs.readFileSync(FILE, 'utf8');
  if (/^\s*import\s/m.test(src)) throw new Error('themes.mjs must stay dependency-free for the vm loader');
  src = src.replace(/^export\s+(?=(const|function|class|let|var)\b)/gm, '');
  if (!/\bTHEMES\b/.test(src)) throw new Error('THEMES not found');
  return vm.runInNewContext(src + '\n;THEMES');
}

let THEMES = null;
function themes() {
  if (THEMES === null) {
    try {
      THEMES = loadThemes();
      if (!Array.isArray(THEMES) || !THEMES.length) throw new Error('empty catalog');
    } catch (err) {
      log.error('catalog load failed, using fallback:', err && err.message);
      THEMES = [{ id: 'midnight', name: 'Midnight', colors: {
        bg: '#0f1419', ring1: '#1b2733', ring2: '#16202b', hover: '#2e7dd1',
        accent: '#4c9ff0', text: '#e8eef4', center: '#0a0e12',
      } }];
    }
  }
  return THEMES;
}

function themeById(id) {
  return themes().find((t) => t.id === id) || null;
}

/* The 7 editable roles, joined for theme matching. Kept byte-for-byte
   compatible with themes.mjs signature() — each side only ever compares
   strings produced through its own sanitizer. */
function signature(pal) {
  return ['bg', 'ring1', 'ring2', 'hover', 'accent', 'text', 'center']
    .map((k) => String((pal && pal[k]) || '').toLowerCase()).join('|');
}

function themeBySignature(s) {
  return themes().find((t) => signature(t.colors) === s) || null;
}

module.exports = { themes, themeById, themeBySignature, signature };
