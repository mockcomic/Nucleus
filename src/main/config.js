'use strict';
/* Config store: defaults, validation, atomic save, legacy import, external-edit watch. */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const EventEmitter = require('events');
const log = require('./logger');
const { themes, themeById, themeBySignature, signature } = require('./themes');

const VERSION = 2;
let idSeq = 0;
const nid = () => `i${Date.now().toString(36)}${(idSeq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const DEFAULT_COLORS = {
  bg: '#0f1419', ring1: '#1b2733', ring2: '#16202b',
  hover: '#2e7dd1', accent: '#4c9ff0', text: '#e8eef4', center: '#0a0e12'
};
const DEFAULT_THEME_ID = 'midnight';
const MAX_USER_THEMES = 24;
/* Rings are numbered 1..N outward (1 = innermost). One cap, mirrored in the
   settings renderer's Add-ring button. */
const MAX_RINGS = 4;

/* Optional persona fields on a palette; malformed entries are dropped, never
   defaulted (see themes.mjs sanitizePalette for the renderer-side mirror). */
function cleanPalette(raw) {
  if (!raw || typeof raw !== 'object') return null;
  for (const k of Object.keys(DEFAULT_COLORS)) if (!HEX.test(String(raw[k] || ''))) return null;
  const out = {};
  for (const k of Object.keys(DEFAULT_COLORS)) out[k] = String(raw[k]).toLowerCase();
  if (raw.mode === 'dark' || raw.mode === 'light') out.mode = raw.mode;
  for (const k of ['edge', 'stroke', 'shadow', 'sheen']) if (HEX.test(String(raw[k] || ''))) out[k] = String(raw[k]).toLowerCase();
  if (raw.chrome && typeof raw.chrome === 'object') {
    const c = {};
    for (const k of ['panel', 'card', 'line', 'dim', 'btnBg', 'wellHover', 'wellEdit',
      'wellTabHover', 'codeInk', 'accentDeep', 'danger', 'errBg', 'errInk', 'track',
      'previewHi', 'previewLo', 'scrollThumb', 'scrollThumbHover', 'sheenColor', 'chromeText', 'chromeEdge'])
      if (HEX.test(String(raw.chrome[k] || ''))) c[k] = String(raw.chrome[k]).toLowerCase();
    if (Object.keys(c).length) out.chrome = c;
  }
  return out;
}

function cleanUserTheme(it, takenNames) {
  it = it && typeof it === 'object' ? it : {};
  const colors = cleanPalette(it.colors);
  if (!colors) return null;
  let name = String(it.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 24);
  if (!name) name = 'Theme';
  let uniq = name, n = 2;
  // The counter suffix must be built from a base short enough to survive the
  // 24-char cap — slicing `${name} (n)` when name is already 24 long yields
  // the same string every pass (infinite loop in the main process). Kept
  // in sync with the settings renderer's theme-dedup (shared/naming.mjs).
  while (takenNames.has(uniq.toLowerCase()) && n <= 9999) uniq = `${name.slice(0, 18)} (${n++})`.slice(0, 24);
  if (takenNames.has(uniq.toLowerCase())) uniq = 'Theme ' + nid();   // absurd-collision escape hatch
  takenNames.add(uniq.toLowerCase());
  // Persist the DEDUPED name — storing the raw `name` would discard the work
  // above and let two imported themes carry the same displayed name.
  return { id: typeof it.id === 'string' && it.id ? it.id : nid(), name: uniq, colors };
}

function defaults() {
  return {
    version: VERSION,
    hotkey: 'ctrl+alt+space',
    appearance: {
      innerRadius: 70, outerRadius: 210, ringSplit: 0.5, startAngle: 0, gapDeg: 3,
      showLabels: true, fontSize: 12, centerLabel: '', animationMs: 160,
      colors: { ...DEFAULT_COLORS }
    },
    behavior: {
      autostart: true, dismissOnEscape: true, dismissOnRightClick: true,
      reTriggerToggles: true,
      /* When the summon trigger's main key is a mouse button, the press is
         swallowed by default so Middle click doesn't ALSO paste (etc.).
         True = the app under the cursor still receives the click. Inert for
         keyboard hotkeys. */
      mouseClickThrough: false,
      gameMode: { enabled: false, apps: [] }
    },
    theme: { id: DEFAULT_THEME_ID, customized: false, colors: { ...DEFAULT_COLORS } },
    userThemes: [],
    rings: {
      1: [
        { id: nid(), label: 'Browser', icon: '\uE774', type: 'url', value: 'https://google.com', color: null },
        { id: nid(), label: 'Files', icon: '\uE8B7', type: 'app', value: 'explorer.exe', color: null },
        { id: nid(), label: 'Settings', icon: '\uE713', type: 'sys', value: 'settings', color: null },
        { id: nid(), label: 'Notes', icon: '\uE70F', type: 'app', value: 'notepad.exe', color: null }
      ],
      2: [
        { id: nid(), label: 'Calculator', icon: '\uE8EF', type: 'app', value: 'calc.exe', color: null },
        { id: nid(), label: 'Screenshot', icon: '\uE7B5', type: 'sys', value: 'screenshot', color: null },
        { id: nid(), label: 'Mute', icon: '\uE74E', type: 'sys', value: 'mute', color: null },
        { id: nid(), label: 'Lock', icon: '\uE72E', type: 'sys', value: 'lock', color: null },
        { id: nid(), label: 'Sleep', icon: '\uE7E8', type: 'sys', value: 'sleep', color: null },
        { id: nid(), label: 'Recycle Bin', icon: '\uE74D', type: 'sys', value: 'recycle_bin', color: null },
        { id: nid(), label: 'Task Mgr', icon: '\uE9D9', type: 'sys', value: 'task_manager', color: null },
        { id: nid(), label: 'Desktop', icon: '\uE7F4', type: 'sys', value: 'show_desktop', color: null }
      ]
    }
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const clamp = (v, lo, hi, dflt) =>
  (typeof v === 'number' && isFinite(v)) ? Math.min(hi, Math.max(lo, v)) : dflt;

const TYPES = new Set(['app', 'url', 'file', 'command', 'macro', 'sys']);
const HOTKEY_RE = /^[a-z0-9+ ]{1,40}$/;

function validate(raw) {
  const base = defaults();
  const src = raw && typeof raw === 'object' ? raw : {};
  const ap = src.appearance || {};
  const colorsIn = ap.colors || {};
  const colors = {};
  for (const k of Object.keys(DEFAULT_COLORS)) colors[k] = HEX.test(colorsIn[k] || '') ? colorsIn[k] : DEFAULT_COLORS[k];
  /* persona fields ride along untouched when valid; the wheel renderer and the
     chrome derivation own their meaning (mirror: themes.mjs sanitizePalette) */
  for (const k of ['edge', 'stroke', 'shadow', 'sheen']) if (HEX.test(colorsIn[k] || '')) colors[k] = colorsIn[k];
  if (colorsIn.mode === 'dark' || colorsIn.mode === 'light') colors.mode = colorsIn.mode;

  const cleanItem = (it, i) => {
    it = it && typeof it === 'object' ? it : {};
    let type = String(it.type || 'app').toLowerCase();
    if (!TYPES.has(type)) type = 'app';
    return {
      id: typeof it.id === 'string' && it.id ? it.id : nid(),
      label: String(it.label ?? `Item ${i + 1}`).slice(0, 40),
      icon: typeof it.icon === 'string' ? Array.from(it.icon).slice(0, 2).join('') : '',
      // Dashboard Icons logo slug (see dashboard-icons.js); anything invalid
      // degrades to '' so the glyph fallback above keeps working.
      iconImage: require('./dashboard-icons').sanitizeSlug(it.iconImage) || '',
      type,
      value: String(it.value ?? '').slice(0, 2048),
      // Launch parameters for `app` items (the Settings "Arguments" box),
      // tokenized by src/main/args.js at launch. Kept only for `app` so a
      // stale string can't ride across a type switch.
      args: type === 'app' ? String(it.args ?? '').slice(0, 2048) : '',
      color: HEX.test(it.color || '') ? it.color : null,
      // Per-segment icon-only override; the global appearance.showLabels
      // toggle still wins when labels are off for everyone.
      hideLabel: !!it.hideLabel,
      // Optional parameter slot; currently only the sys `explorer` action
      // consumes it (the folder Explorer opens in). Inert on other types.
      dir: typeof it.dir === 'string' ? it.dir.trim().slice(0, 2048) : ''
    };
  };
  const cleanRing = (arr) => Array.isArray(arr) ? arr.slice(0, 24).map(cleanItem) : [];

  /* Rings arrive keyed by numeric strings; normalize to a contiguous 1..N
     (ascending key order, renumbered, capped at MAX_RINGS, floor of two keys
     so the UI always has an inner + outer list). Empty rings are legal —
     the renderer skips them when laying out bands. */
  const ringsIn = (src.rings && typeof src.rings === 'object') ? src.rings : {};
  const ringArrays = Object.keys(ringsIn)
    .map((k) => ({ n: Number(k), arr: ringsIn[k] }))
    .filter((r) => Number.isInteger(r.n) && r.n >= 1)
    .sort((a, b) => a.n - b.n)
    .slice(0, MAX_RINGS)
    .map((r) => cleanRing(r.arr));
  const rings = {};
  const nRings = Math.max(2, ringArrays.length);
  for (let i = 0; i < nRings; i++) rings[String(i + 1)] = ringArrays[i] || [];
  if (!ringArrays.some((a) => a.length)) rings['1'] = defaults().rings[1];  // never ship an empty wheel

  const bhvIn = src.behavior || {};
  const hotkey = HOTKEY_RE.test(String(src.hotkey ?? '').toLowerCase().trim())
    ? String(src.hotkey).toLowerCase().trim() : base.hotkey;

  /* --- theme system (v2): user gallery + the active theme reference ------- */
  const takenNames = new Set(themes().map((t) => t.name.toLowerCase()));
  const userThemes = (Array.isArray(src.userThemes) ? src.userThemes : [])
    .slice(0, MAX_USER_THEMES)
    .map((it) => cleanUserTheme(it, takenNames))
    .filter(Boolean);

  const thIn = src.theme && typeof src.theme === 'object' ? src.theme : {};
  let themeId = typeof thIn.id === 'string' ? thIn.id : null;
  let userTheme = userThemes.find((t) => t.id === themeId) || null;
  if (!userTheme) {
    if (!themeById(themeId) || themeId === null) themeId = DEFAULT_THEME_ID;
    userTheme = null;
  }
  /* Baseline = the palette the active theme owns. An edited theme carries its
     own saved baseline; a catalog theme's baseline is the catalog entry. */
  const baseline = userTheme ? userTheme.colors
    : cleanPalette(thIn.colors) || (themeById(themeId) && cleanPalette(themeById(themeId).colors))
    || { ...DEFAULT_COLORS };

  /* Cross-constraint: the ring band is (outerRadius - innerRadius) and a dial
     where inner >= outer has no band at all — hit-testing can never match and
     the hub swallows the whole overlay. Clamp inner down (mirrored by the
     slider pair in the Settings appearance section); old bad configs
     self-heal here on load. */
  const MIN_BAND = 24;
  const outerRadius = clamp(ap.outerRadius, 120, 360, base.appearance.outerRadius);
  const innerRadius = Math.max(24, Math.min(
    clamp(ap.innerRadius, 24, 140, base.appearance.innerRadius),
    outerRadius - MIN_BAND));

  return {
    version: VERSION,
    hotkey,
    appearance: {
      innerRadius,
      outerRadius,
      ringSplit: clamp(ap.ringSplit, 0.2, 0.8, base.appearance.ringSplit),
      startAngle: clamp(ap.startAngle, 0, 359.9, base.appearance.startAngle),
      gapDeg: clamp(ap.gapDeg, 0, 10, base.appearance.gapDeg),
      showLabels: ap.showLabels !== false,
      fontSize: clamp(ap.fontSize, 8, 20, base.appearance.fontSize),
      centerLabel: String(ap.centerLabel ?? '').slice(0, 24),
      animationMs: clamp(ap.animationMs, 0, 400, base.appearance.animationMs),
      colors
    },
    behavior: {
      autostart: bhvIn.autostart !== false,
      dismissOnEscape: bhvIn.dismissOnEscape !== false,
      dismissOnRightClick: bhvIn.dismissOnRightClick !== false,
      reTriggerToggles: bhvIn.reTriggerToggles !== false,
      // Fail-closed on purpose: junk/absent means "swallow the click", the safe default.
      mouseClickThrough: bhvIn.mouseClickThrough === true,
      gameMode: require('./gamemode').sanitizeGameMode(bhvIn.gameMode)
    },
    theme: {
      id: themeId,
      customized: thIn.customized === true || signature(colors) !== signature(baseline),
      colors: baseline
    },
    userThemes,
    rings
  };
}

/* Map the old Python wheel_config.json (flat items[] with ring field) into v1. */
function importLegacy(cfgDirCandidates) {
  for (const dir of cfgDirCandidates) {
    const p = path.join(dir, 'wheel_config.json');
    try {
      if (!fs.existsSync(p)) continue;
      const old = JSON.parse(fs.readFileSync(p, 'utf8'));
      const d = defaults();
      const out = {
        version: VERSION,
        hotkey: HOTKEY_RE.test(String(old.hotkey || '').toLowerCase()) ? old.hotkey.toLowerCase() : d.hotkey,
        appearance: {
          ...d.appearance,
          innerRadius: clamp(old.inner_radius, 24, 140, clamp((old.inner_radius || 95) * 0.74, 24, 140, 70)),
          outerRadius: clamp(old.outer_radius, 120, 360, d.appearance.outerRadius),
          ringSplit: clamp(old.ring_split, 0.2, 0.8, d.appearance.ringSplit),
          startAngle: typeof old.start_angle === 'number'
            ? (((90 - old.start_angle) % 360) + 360) % 360 : 0,
          colors: { ...d.appearance.colors, ...(old.colors || {}) },
          centerLabel: String(old.center_label || '')
        },
        behavior: { ...d.behavior },
        rings: { 1: [], 2: [] }
      };
      if (Array.isArray(old.font) && typeof old.font[1] === 'number')
        out.appearance.fontSize = clamp(old.font[1], 8, 20, 12);
      for (const it of (old.items || [])) {
        const ring = String(it.ring) === '2' ? '2' : '1';
        let type = String(it.type || 'app').toLowerCase();
        if (!TYPES.has(type)) type = 'app';
        out.rings[ring].push({ id: nid(), label: it.label || 'Item', icon: '', type, value: it.value || '', color: null });
      }
      return { config: validate(out), importedFrom: p };
    } catch { /* try next candidate */ }
  }
  return null;
}

/* The live registration depends on the spec AND on the mouse click-through
   policy, so a change to either must read as "hotkeyChanged" and re-arm the
   hook — otherwise toggling the checkbox would only take effect after a restart. */
const hotkeyPolicy = (c) => `${c.hotkey}|${c.behavior && c.behavior.mouseClickThrough ? 1 : 0}`;

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this._cfg = validate({});
    this._createdNew = false;
    this._watcher = null;
    this._suppressUntil = 0;
    this._lastGood = null;
    this.rev = 0;   // bumped on every genuine content change; the settings window
                    // uses it to tell its own saves' echoes from external edits
  }

  file() { return path.join(app.getPath('userData'), 'config.json'); }

  init() {
    const p = this.file();
    try {
      if (fs.existsSync(p)) {
        this._cfg = validate(JSON.parse(fs.readFileSync(p, 'utf8')));
        this._lastGood = this._cfg;
      } else {
        throw new Error('missing');
      }
    } catch (err) {
      const candidates = [app.getAppPath(), path.join(app.getAppPath(), 'archive'), app.getPath('userData')];
      const legacy = importLegacy(candidates);
      if (legacy) {
        this._cfg = legacy.config;
        this.importedFrom = legacy.importedFrom;
      } else {
        this._cfg = validate({});
      }
      this._createdNew = true;
      try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
      try {
        this._write();
      } catch (err2) {
        // Disk unavailable on a fresh install: run from the in-memory config,
        // stay resident, and let the Settings banner (broken flag) say so.
        log.error('could not write initial config:', err2 && err2.message);
        this.broken = true;
      }
      if (err.message === 'missing' && !legacy) {
        // brand-new install, nothing else to do
      } else if (err.message !== 'missing') {
        try { fs.copyFileSync(p, p + '.bad'); } catch {}
        this.broken = true;
      }
    }
    this._watch();
    return { config: this._cfg, createdNew: this._createdNew };
  }

  get() { return this._cfg; }

  set(newCfg) {
    const merged = validate({ ...newCfg, version: VERSION });
    const old = this._cfg;
    const oldGood = this._lastGood;
    const oldRev = this.rev;
    this._cfg = merged;
    this.rev++;
    try {
      this._write();
    } catch (e) {
      // disk refused the save — roll the store back so memory and file agree
      this._cfg = old;
      this._lastGood = oldGood;
      this.rev = oldRev;
      throw e;
    }
    this._lastGood = merged;
    this.emit('changed', { config: merged, old, rev: this.rev, hotkeyChanged: hotkeyPolicy(old) !== hotkeyPolicy(merged), autostartChanged: old.behavior.autostart !== merged.behavior.autostart });
    return merged;
  }

  reload() {
    try {
      const cfg = validate(JSON.parse(fs.readFileSync(this.file(), 'utf8')));
      const old = this._cfg;
      if (JSON.stringify(cfg) === JSON.stringify(old)) return cfg;   // no-op watch event — not an external change
      this._cfg = cfg;
      this._lastGood = cfg;
      this.rev++;
      this.emit('changed', { config: cfg, old, rev: this.rev, hotkeyChanged: hotkeyPolicy(old) !== hotkeyPolicy(cfg), autostartChanged: old.behavior.autostart !== cfg.behavior.autostart, reload: true });
      return cfg;
    } catch {
      if (this._lastGood) { this._cfg = this._lastGood; }
      return this._cfg;
    }
  }

  _write() {
    const p = this.file();
    const tmp = p + '.tmp';
    this._suppressUntil = Date.now() + 300;
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this._cfg, null, 2), 'utf8');
      fs.renameSync(tmp, p);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* leftover temp, best effort */ }
      // ENOENT/EACCES/EBUSY from AV locks, disk-full, unwritable userData…
      throw new Error(`could not save config (${e.code || e.message}) — is config.json locked?`);
    }
  }

  _watch() {
    const p = this.file();
    try {
      this._watcher && this._watcher.close();
      this._watcher = fs.watch(path.dirname(p), (evt, name) => {
        if (name !== 'config.json') return;
        if (Date.now() < this._suppressUntil) return;
        clearTimeout(this._t);
        this._t = setTimeout(() => this.reload(), 200);
      });
    } catch { /* watch is best-effort */ }
  }
}

module.exports = { ConfigStore, validate, defaults, VERSION, MAX_RINGS };
