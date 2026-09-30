/* Theme registry — single source of truth for the curated theme catalog and the
   chrome-token derivation. This file is PLAIN ESM with zero dependencies:
   the renderer imports it directly (settings.js), the main process evaluates
   the THEMES literal through themes.js (bare vm — keep the catalog literal
   data), and node:test imports it directly. No Electron, no DOM, no imports.

   A theme = the 7 editable wheel roles (bg, ring1, ring2, hover, accent, text,
   center) + optional persona fields (mode, stroke, edge, shadow, sheen) + an
   optional hand-tuned `chrome` block overriding derived Settings-window
   tokens. The wheel's identity lives in the roles; the Settings chrome is
   derived from them (AA-clamped), so even a user-saved theme can't ship an
   unreadable window. */

/* ─────────────────────────── color primitives ─────────────────────────── */

const HEX_RE = /^#[0-9a-fA-F]{6}$/;
export const isHex = (v) => HEX_RE.test(String(v || ''));
export const hexOk = (v, fb) => (HEX_RE.test(String(v || '')) ? String(v).toLowerCase() : fb);

export function parseHex(h) {
  const s = String(h).replace('#', '');
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export const toHex = (rgb) =>
  '#' + rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('');

export function mix(a, b, t) {
  const A = parseHex(a), B = parseHex(b);
  return toHex([0, 1, 2].map((i) => A[i] + (B[i] - A[i]) * t));
}

export function relLum(hex) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  const [r, g, b] = parseHex(hex).map(f);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

/* Push fg toward an extreme until contrast(fg, bg) >= target. */
export function withContrast(fg, bg, target, toward) {
  if (contrast(fg, bg) >= target) return fg;
  const anchor = toward || (relLum(fg) > relLum(bg) ? '#ffffff' : '#000000');
  let v = fg;
  for (let t = 0.06; t <= 1.0001; t += 0.06) {
    v = mix(fg, anchor, t);
    if (contrast(v, bg) >= target) return v;
  }
  return anchor;
}

/* Accent fill under white text: deepened toward black until white clears
   4.5:1. Hover lifts to the palette's own accent — always lighter than deep,
   so the deeper→lighter order is guaranteed by construction (full accent
   never sits under white text; it lost AA on Midnight the day it shipped). */
export function accentDeepPair(accent) {
  let deep = accent;
  for (let i = 0; i < 40 && contrast(deep, '#ffffff') < 4.5; i++)
    deep = mix(deep, '#000000', 0.12);
  return { deep, hi: accent };
}

/* ─────────────────────────── chrome derivation ─────────────────────────── */

/* camelCase key -> CSS custom property. ONLY surface/well tokens — the
   accent-deep pair, on-accent and canvas ink are deliberately NOT here:
   they are AA-critical derivations no theme may override. */
export const CHROME_VARS = {
  panel: '--panel', card: '--card', line: '--line', dim: '--dim',
  btnBg: '--btn-bg', wellHover: '--well-hover', wellEdit: '--well-edit',
  wellTabHover: '--well-tab-hover', codeInk: '--code-ink', accentDeep: '--accent-deep',
  danger: '--danger', errBg: '--err-bg', errInk: '--err-ink',
  track: '--track', previewHi: '--preview-hi', previewLo: '--preview-lo',
  scrollThumb: '--scroll-thumb', scrollThumbHover: '--scroll-thumb-hover', sheenColor: '--light-overlay',
};
/* Non-CSS chrome extras: chromeText restyles the SETTINGS INK only (the wheel
   keeps colors.text — Graphite's dark plate-ink must not darken the window);
   chromeEdge overrides the segment edge stroke used by the wheel renderer. */
export const CHROME_EXTRA = { chromeText: null, chromeEdge: null };
Object.assign(CHROME_VARS, CHROME_EXTRA);

/* Tonal ramp, per mode. Dark chrome stacks UP from bg (panel/card lighter,
   field sunk darker); light chrome stacks DOWN toward ink. Steps are tuned
   so every neighbor pair stays distinguishable at hairline distance. */
const RAMPS = {
  dark: { panel: 0.10, card: 0.16, line: 0.30, field: -0.90, btnBg: 0.22,
    wellHover: 0.20, wellEdit: 0.13, wellTabHover: 0.14, previewHi: 0.12, previewLo: -0.55 },
  light: { panel: 0.06, card: 0.10, line: 0.34, field: 0.17, btnBg: 0.09,
    wellHover: 0.12, wellEdit: 0.05, wellTabHover: 0.08, previewHi: -0.04, previewLo: 0.22 },
};

/* Derive every Settings-chrome token from a palette (AA-clamped). Hand-tuned
   `chrome` entries win, but only for keys in CHROME_VARS. */
export function computeChrome(pal) {
  const bg = pal.bg, text = pal.text, accent = pal.accent;
  const light = paletteMode(pal) === 'light';
  const inkDark = '#15181c', paper = '#f5f7fa';
  const ramp = { ...RAMPS[light ? 'light' : 'dark'] };
  const anchor = light ? inkDark : text;
  const stack = light ? inkDark : '#000000';
  /* signed step: positive stacks toward the anchor (lighter in dark mode,
     darker in light mode); negative sinks away from it */
  const step = (t) => t >= 0
    ? mix(bg, anchor, Math.min(0.98, t * 1.12))
    : mix(bg, stack, Math.min(0.98, -t));

  /* muted text: the text->bg fade; if it can't clear 4.5:1 on the card, walk
     toward whichever extreme reads best on THAT card — direction is a
     property of the surface pair, never of the mode label. */
  const cardGuess = () => step(ramp.card);
  let dim = mix(text, bg, 0.36);
  if (contrast(dim, cardGuess()) < 4.5) {
    let best = dim, bestC = contrast(dim, cardGuess());
    for (let t = 0.06; t <= 0.96; t += 0.06) {
      for (const ext of ['#000000', '#ffffff']) {
        const c = contrast(mix(text, ext, t), cardGuess());
        if (c > bestC) { best = mix(text, ext, t); bestC = c; }
      }
    }
    dim = best;
  }
  /* last resort: no ink value fits this ramp — deepen the whole stack
     (order preserved) until dim fits */
  for (let k = 1; k <= 4 && contrast(dim, cardGuess()) < 4.5; k++)
    for (const key of ['panel', 'card', 'line', 'btnBg', 'wellHover', 'wellEdit', 'wellTabHover'])
      ramp[key] *= 1.5;

  const trackBase = light ? mix(bg, inkDark, 0.26) : mix(bg, text, 0.40);
  const track = contrast(text, trackBase) >= 3 ? trackBase : mix(trackBase, light ? paper : '#ffffff', 0.25);

  const { deep, hi } = accentDeepPair(accent);
  const out = {
    bg, text, accent,
    panel: step(ramp.panel),
    card: step(ramp.card),
    line: step(ramp.line),
    dim,
    field: step(ramp.field),
    btnBg: step(ramp.btnBg),
    wellHover: step(ramp.wellHover),
    wellEdit: step(ramp.wellEdit),
    wellTabHover: step(ramp.wellTabHover),
    codeInk: light ? withContrast(mix(accent, inkDark, 0.4), bg, 4.5, inkDark)
      : mix(accent, paper, 0.55),
    danger: light ? '#b3261e' : '#e56b6b',
    errBg: light ? '#fbe2e0' : '#3a1d1d',
    errInk: light ? '#7a1414' : '#ffb3b3',
    track,
    accentDeep: deep,
    accentDeepHi: hi,
    accentDim: mix(accent, light ? paper : '#000000', 0.25),
    ringAccent: `rgba(${parseHex(accent).join(',')},0.16)`,
    accentActive: `rgba(${parseHex(accent).join(',')},0.25)`,
    onAccent: '#ffffff',
    previewHi: step(ramp.previewHi),
    previewLo: step(ramp.previewLo),
    scrollThumb: `rgba(${parseHex(text).join(',')},${light ? 0.30 : 0.14})`,
    scrollThumbHover: `rgba(${parseHex(text).join(',')},${light ? 0.42 : 0.22})`,
    rimColor: mix(text, bg, light ? 0.55 : 0.92),
    edgeStroke: pal.edge || pal.stroke || mix(text, bg, light ? 0.86 : 0.94),
    shadowColor: pal.shadow || (light ? 'rgba(0,0,0,0.30)' : 'rgba(0,0,0,0.55)'),
    sheenColor: pal.sheen || '#ffffff',
    lightOverlay: light ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.06)',
  };
  out.sheen = `linear-gradient(180deg, ${out.lightOverlay}, rgba(0,0,0,0) 45%)`;
  out.sheenQuiet = `linear-gradient(180deg, rgba(${parseHex(out.sheenColor).join(',')},${light ? 0.05 : 0.022}), rgba(0,0,0,0) 60%)`;
  if (pal.chrome) for (const k of Object.keys(CHROME_VARS)) if (isHex(pal.chrome[k])) out[k] = pal.chrome[k];
  /* The preview well exists to hold the wheel — a plate one value step from
     the well vanishes into it (the machined #17202a well sat a single digit
     from Ocean/Midnight's ring2). In dark themes, sink the well toward black
     regardless of hand-tuned values; the hue rides on bg, so the theme's tint
     survives while the plates gain guaranteed separation. */
  if (!light) {
    out.previewHi = mix(bg, '#000000', 0.32);
    out.previewLo = mix(bg, '#000000', 0.68);
  }
  /* chromeText is the chrome's ink — it may differ from the wheel's plate ink
     (Graphite: dark text on light plates, light text in a dark window) */
  out.text = out.chromeText || text;
  return out;
}

/* Flat CSS-var map for documentElement.style — solid colors only; structural
   tokens (shadows, sheen cadence, radii) stay in CSS and flip on data-mode. */
export function chromeVarMap(chrome) {
  return {
    '--bg': chrome.bg, '--panel': chrome.panel, '--card': chrome.card, '--line': chrome.line,
    '--text': chrome.text, '--dim': chrome.dim, '--accent': chrome.accent, '--accent-dim': chrome.accentDim,
    '--accent-deep': chrome.accentDeep, '--accent-deep-hi': chrome.accentDeepHi,
    '--field': chrome.field, '--btn-bg': chrome.btnBg,
    '--well-hover': chrome.wellHover, '--well-edit': chrome.wellEdit, '--well-tab-hover': chrome.wellTabHover,
    '--code-ink': chrome.codeInk,
    '--danger': chrome.danger, '--err-bg': chrome.errBg, '--err-ink': chrome.errInk,
    '--track': chrome.track,
    '--ring-accent': chrome.ringAccent, '--ring-active': chrome.accentActive,
    '--on-accent': chrome.onAccent,
    '--preview-hi': chrome.previewHi, '--preview-lo': chrome.previewLo,
    '--scroll-thumb': chrome.scrollThumb, '--scroll-thumb-hover': chrome.scrollThumbHover,
  };
}

/* ─────────────────────────── palette sanitizing ─────────────────────────── */

export const REQUIRED_ROLES = ['bg', 'ring1', 'ring2', 'hover', 'accent', 'text', 'center'];
const OPTIONAL_HEX = ['edge', 'stroke', 'shadow', 'sheen'];
const CHROME_KEYS = Object.keys(CHROME_VARS);

export function paletteMode(pal) {
  if (pal && (pal.mode === 'dark' || pal.mode === 'light')) return pal.mode;
  return relLum((pal && pal.bg) || '#000000') >= 0.4 ? 'light' : 'dark';
}

/* Coerce any object into a valid palette or null. The 7 wheel roles must be
   hex; persona fields and chrome overrides are optional and dropped when
   malformed (never silently defaulted). */
export function sanitizePalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const k of REQUIRED_ROLES) {
    if (!isHex(raw[k])) return null;
    out[k] = String(raw[k]).toLowerCase();
  }
  if (raw.mode === 'dark' || raw.mode === 'light') out.mode = raw.mode;
  for (const k of OPTIONAL_HEX) if (isHex(raw[k])) out[k] = String(raw[k]).toLowerCase();
  if (raw.chrome && typeof raw.chrome === 'object') {
    const c = {};
    for (const k of CHROME_KEYS) if (isHex(raw.chrome[k])) c[k] = String(raw.chrome[k]).toLowerCase();
    if (Object.keys(c).length) out.chrome = c;
  }
  return out;
}

/* The identity of a palette for theme matching: the 7 editable roles only —
   persona fields (mode/stroke/edge/shadow/sheen) never flip the Custom flag. */
export function signature(pal) {
  return REQUIRED_ROLES.map((k) => String((pal && pal[k]) || '').toLowerCase()).join('|');
}

/* ─────────────────────────── the curated catalog ─────────────────────────── */

/* The incumbent machined-midnight chrome — verbatim from settings.css :root.
   Every original dark preset keeps it, so nothing about today's look drifts. */
const DARK_CHROME = {
  panel: '#131a22', card: '#161f29', line: '#21303e', dim: '#8fa3b5',
  btnBg: '#1d2a37', wellHover: '#182330',
  wellEdit: '#121a23', wellTabHover: '#1a2430', codeInk: '#a8d0f0',
  danger: '#e56b6b', errBg: '#3a1d1d', errInk: '#ffb3b3',
  track: '#24303d', previewHi: '#17202a', previewLo: '#0b1015',
  scrollThumb: '#24303d', sheenColor: '#ffffff',
};

export const THEMES = [
  {
    id: 'midnight', name: 'Midnight',
    colors: {
      bg: '#0f1419', ring1: '#1b2733', ring2: '#16202b', hover: '#2e7dd1',
      accent: '#4c9ff0', text: '#e8eef4', center: '#0a0e12',
      mode: 'dark', chrome: { ...DARK_CHROME, accentDeep: '#2768b5' },
    },
  },
  {
    id: 'ocean', name: 'Ocean',
    colors: {
      bg: '#08131c', ring1: '#123047', ring2: '#0d2333', hover: '#1a7f9e',
      accent: '#33c6e8', text: '#e6f6fb', center: '#061018',
      mode: 'dark', chrome: DARK_CHROME,
    },
  },
  {
    id: 'grape', name: 'Grape',
    colors: {
      bg: '#120b1c', ring1: '#2c1b45', ring2: '#221436', hover: '#7b3fd1',
      accent: '#a86bff', text: '#f0e8fb', center: '#0b0714',
      mode: 'dark', chrome: { ...DARK_CHROME, track: '#372a4d', previewHi: '#1d1430', previewLo: '#0d0716' },
    },
  },
  {
    id: 'graphite', name: 'Graphite',
    colors: {
      bg: '#171717', ring1: '#2b2b2b', ring2: '#222222', hover: '#e0e0e0',
      accent: '#d0d0d0', text: '#111111', center: '#0d0d0d',
      mode: 'dark', stroke: '#000000', edge: '#f2f2f2',
      chrome: { ...DARK_CHROME, dim: '#9a9a9a', track: '#333333', codeInk: '#d8d8d8', chromeText: '#e8e8e8' },
    },
  },
  {
    id: 'ember', name: 'Ember',
    colors: {
      bg: '#160d0a', ring1: '#3a1e12', ring2: '#2b160d', hover: '#d1652e',
      accent: '#ff944c', text: '#fbefe8', center: '#0f0805',
      mode: 'dark', chrome: { ...DARK_CHROME, track: '#40281c', previewHi: '#241410', previewLo: '#0e0705' },
    },
  },
  {
    id: 'porcelain', name: 'Porcelain',
    colors: {
      bg: '#e7ebee', ring1: '#d8dfe6', ring2: '#c7d2dc', hover: '#9db6d0',
      accent: '#2f6fb2', text: '#182430', center: '#eef2f5',
      mode: 'light', stroke: '#182430',
      chrome: { dim: '#475a6f', codeInk: '#20527f' },
    },
  },
  {
    id: 'linen', name: 'Linen',
    colors: {
      bg: '#ece2d0', ring1: '#e0d0b4', ring2: '#cfb891', hover: '#b98a5a',
      accent: '#9a5b2d', text: '#33261a', center: '#f4ecdd',
      mode: 'light', stroke: '#33261a',
      chrome: { dim: '#624f3a', codeInk: '#7c441f' },
    },
  },
  {
    id: 'paper', name: 'Paper',
    colors: {
      bg: '#f4f6f8', ring1: '#e6eaee', ring2: '#d3dae1', hover: '#a9c7ec',
      accent: '#0a66c2', text: '#101418', center: '#ffffff',
      mode: 'light', stroke: '#101418',
      chrome: { dim: '#4a5763', codeInk: '#0a4e97' },
    },
  },
  {
    id: 'hc-black', name: 'HC Black',
    colors: {
      bg: '#000000', ring1: '#141414', ring2: '#0a0a0a', hover: '#9c7d00',
      accent: '#ffffff', text: '#ffffff', center: '#1c1c1c',
      mode: 'dark', stroke: '#ffffff', sheen: '#ffffff',
      chrome: {
        panel: '#000000', card: '#0a0a0a', line: '#ffffff', dim: '#ffffff',
        btnBg: '#141414', wellHover: '#1f1f1f', wellEdit: '#0f0f0f', wellTabHover: '#1a1a1a',
        accentDeep: '#000000',
        track: '#3d3d3d', codeInk: '#9ae6ff', danger: '#ffb3b3', errBg: '#330000', errInk: '#ffffff',
        previewHi: '#0d0d0d', previewLo: '#000000', scrollThumb: '#4d4d4d', sheenColor: '#ffffff',
      },
    },
  },
  {
    id: 'hc-white', name: 'HC White',
    colors: {
      bg: '#ffffff', ring1: '#ffffff', ring2: '#e8e8e8', hover: '#f2f2f2',
      accent: '#005fb8', text: '#000000', center: '#fbfbfb',
      mode: 'light', stroke: '#000000',
      chrome: {
        panel: '#ffffff', card: '#ffffff', line: '#000000', dim: '#1f1f1f',
        btnBg: '#ededed', wellHover: '#e2e2e2', wellEdit: '#f5f5f5', wellTabHover: '#ebebeb',
        accentDeep: '#004a94',
        track: '#b3b3b3', codeInk: '#003a70', danger: '#8a1111', errBg: '#ffe0e0', errInk: '#5c0000',
        previewHi: '#f2f2f2', previewLo: '#d9d9d9', scrollThumb: '#808080', sheenColor: '#000000',
      },
    },
  },
  {
    id: 'solar', name: 'Solar',
    colors: {
      bg: '#1a1206', ring1: '#453215', ring2: '#33240e', hover: '#8a4d0a',
      accent: '#f5b34c', text: '#f7e9c9', center: '#0f0a03',
      mode: 'dark', chrome: { ...DARK_CHROME, track: '#453215', previewHi: '#241a0b', previewLo: '#0d0803' },
    },
  },
  {
    id: 'meadow', name: 'Meadow',
    colors: {
      bg: '#071610', ring1: '#14372a', ring2: '#0f2b20', hover: '#1e6b42',
      accent: '#5fd39a', text: '#e6f6ec', center: '#04110b',
      mode: 'dark', stroke: '#9fdcb8',
      chrome: { ...DARK_CHROME, track: '#1c4433', previewHi: '#10281e', previewLo: '#061209' },
    },
  },
  /* Apple-inspired pair. Aqua: iOS light mode — white plates on the
     grouped-background grey, System Blue accent, Apple's marketing ink.
     dim/codeInk hand-set to iOS secondaryLabel / link blue; both clear the
     AA floors on the derived card (the purity gate re-verifies). */
  {
    id: 'aqua', name: 'Aqua',
    colors: {
      bg: '#f2f2f7', ring1: '#ffffff', ring2: '#e9e9eb', hover: '#a8ccf5',
      accent: '#007aff', text: '#1d1d1f', center: '#fbfbfd',
      mode: 'light', stroke: '#1c1c1e',
      chrome: { dim: '#3c3c43', codeInk: '#0066cc' },
    },
  },
  /* Space Gray: iOS dark mode — neutral elevated greys (no blue tint, so
     DARK_CHROME is replaced wholesale by the neutral set) under dark-mode
     System Blue. hover sits at the AA-safe deep blue; preview wells are
     force-sunk by computeChrome, never hand-set here. */
  {
    id: 'space-gray', name: 'Space Gray',
    colors: {
      bg: '#1a1a1c', ring1: '#2c2c2e', ring2: '#232325', hover: '#0a66c2',
      accent: '#0a84ff', text: '#f5f5f7', center: '#0f0f10',
      mode: 'dark',
      chrome: {
        panel: '#1c1c1e', card: '#242426', line: '#3a3a3c', dim: '#98989d',
        btnBg: '#2c2c2e', wellHover: '#333335', wellEdit: '#1f1f21', wellTabHover: '#2a2a2c',
        codeInk: '#6cb6ff', danger: '#ff453a', errBg: '#3a1d1d', errInk: '#ffb3b3',
        track: '#3a3a3c', scrollThumb: '#3a3a3c', sheenColor: '#ffffff',
      },
    },
  },
];

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || null;
}
export function themeBySignature(s) {
  return THEMES.find((t) => signature(t.colors) === s) || null;
}
