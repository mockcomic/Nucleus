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

/* Folder segments carry an inline sub-menu that branches radially on hover.
   Nesting is capped (folder-in-folder-in-folder) and each sub-menu is capped
   well below the ring cap — a fan of 24 children in a partial arc is unreadable.
   Mirrored by the settings renderer (it cannot require this CommonJS module). */
const MAX_CHILDREN = 12;
const MAX_FOLDER_DEPTH = 3;

/* App-specific wheel profiles: each profile carries its own rings plus the
   exe basenames that activate it. Caps mirrored by the settings renderer. */
const MAX_PROFILES = 8;
const MAX_PROFILE_APPS = 64;
const MAX_PROFILE_NAME = 40;

/* ------------------------------ config backups -----------------------------
   Rolling safety net for the destructive paths (Import…, Reset), whose in-UI
   Undo is a toast that dies with the Settings window. Backups are plain copies
   of the config file we are ABOUT to replace, kept in <userData>\backups with a
   sortable name so a user can pick one in Explorer — or through Advanced →
   "Restore a backup…", which opens that very folder.

   Autosave fires on every debounced edit, so ordinary saves are THROTTLED;
   a replace operation (import/reset) forces one. Failures here are logged and
   swallowed: losing a backup must never cost the user the save they asked for. */
const BACKUP_DIR_NAME = 'backups';
const MAX_BACKUPS = 12;
const BACKUP_MIN_INTERVAL_MS = 5 * 60 * 1000;   // 10 min between ordinary saves
const BACKUP_STEM_RE = /^config-[0-9]{8}-[0-9]{6}(?:-[a-z0-9]{1,12})?-r[0-9]+\.json$/;

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
      /* Where freshly-opened APP WINDOWS land when a segment launches them
         (winplace.js; the wheel overlay itself always follows the cursor):
         'default' = leave placement to the app (today's behavior),
         'cursor'  = center the window on the pointer at click time,
         'center'  = center it on the work area of the pointer's display.
         Whitelisted in validate; anything else falls back to 'default'. */
      appOpenPosition: 'default',
      /* When the summon trigger's main key is a mouse button, the press is
         swallowed by default so Middle click doesn't ALSO paste (etc.).
         True = the app under the cursor still receives the click. Inert for
         keyboard hotkeys. */
      mouseClickThrough: false,
      /* Dwell (ms) on a folder segment before its sub-menu branches open.
         0 = branch instantly on hover. */
      flyoutDwellMs: 180,
      gameMode: { enabled: false, apps: [] },
      /* App-specific wheels: when on, a summon probes the foreground app once
         and swaps in the first profile whose apps list matches (profiles.js).
         Off by default — zero probing while unused. */
      profilesEnabled: false,
      /* Press-drag-release selection (pie-menu marking). On by default: a
         plain click still fires (press and release land on the same plate),
         releasing off the wheel cancels instead of firing. */
      markingSelect: true,
      /* Typing while the wheel is open dims non-matching segments; Enter
         fires the best match. */
      typeToFilter: true,
      /* How many items the `recent` segment's auto-filled sub-menu shows. */
      recentsCount: 8,
      /* Soft synthesized hover/select ticks in the wheel overlay (Web Audio,
         generated in wheel-sound.js — no asset files). Opt-in: audio never
         makes a sound unless the user turns it on. */
      wheelSound: false,
      /* Opt-in: when an `app` segment names a .exe that already owns a
         visible window, raise that window instead of launching a second
         instance (macro.focusAppWindowByExe). Off by default — launching a
         new instance is what every existing install does today. */
      focusExistingApp: false,
      /* Devices the pickers hold back (app-level hiding — Windows itself is
         untouched). [{id, name}] per flow; the id hides, the name keeps the
         Manage panel readable when the device is unplugged. The CURRENT
         default is never filtered out of any list (audio.js rule), so this
         list can never make the picker lie. */
      audioHidden: { render: [], capture: [] }
    },
    theme: { id: DEFAULT_THEME_ID, customized: false, colors: { ...DEFAULT_COLORS } },
    userThemes: [],
    profiles: [],
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

const TYPES = new Set(['app', 'url', 'file', 'command', 'macro', 'sys', 'setting', 'folder', 'recent', 'mixer']);
const HOTKEY_RE = /^[a-z0-9+ ]{1,40}$/;

/* ---- behavior.audioHidden sanitization --------------------------------------
   The hidden-device lists ride the store like any other behavior field, so a
   hand-edited or imported config can never smuggle junk into the endpoint-id
   vocabulary: ids are held to the printable-ASCII shape Core Audio itself
   produces (the same policy as audio.js's sanitizeDeviceId), names are plain
   capped strings kept only so the Manage panel stays readable while a device
   is unplugged. Entries are objects {id, name}; anything else — bare
   strings, nulls, keyless objects — drops. Deduped by id, capped per flow:
   the lists are hand-built, so 128 is generous headroom, not a limit anyone
   meets. */
const HIDDEN_ID_RE = /^[\x20-\x7e]+$/;         // printable ASCII, no control chars
const HIDDEN_MAX_PER_FLOW = 128;
function normalizeHiddenList(raw) {
  const out = [];
  const seen = new Set();
  for (const e of Array.isArray(raw) ? raw : []) {
    if (!e || typeof e !== 'object') continue;
    const id = String(e.id == null ? '' : e.id).trim();
    if (!id || id.length > 512 || !HIDDEN_ID_RE.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: String(e.name == null ? '' : e.name).trim().slice(0, 512) });
    if (out.length >= HIDDEN_MAX_PER_FLOW) break;
  }
  return out;
}
function normalizeHiddenDevices(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return { render: normalizeHiddenList(src.render), capture: normalizeHiddenList(src.capture) };
}

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

  const cleanItem = (it, i, depth = 0) => {
    it = it && typeof it === 'object' ? it : {};
    let type = String(it.type || 'app').toLowerCase();
    if (!TYPES.has(type)) type = 'app';
    const isFolder = type === 'folder';
    // `recent` is a container too — its sub-menu is main-resolved at summon
    // time, so every action slot AND any hand-carried children are wiped.
    // `mixer` is a third: the volume-mixer segment is a pure flyout trigger
    // (the overlay panel reads/writes Core Audio through the audio channels),
    // so it launches nothing and carries nothing.
    const isContainer = isFolder || type === 'recent' || type === 'mixer';
    return {
      id: typeof it.id === 'string' && it.id ? it.id : nid(),
      label: String(it.label ?? `Item ${i + 1}`).slice(0, 40),
      icon: typeof it.icon === 'string' ? Array.from(it.icon).slice(0, 2).join('') : '',
      // Logo/artwork slot: a Dashboard Icons slug, a `custom:<hash>.<kind>`
      // key (see dashboard-icons.js and custom-icons.js), or the reserved
      // `builtin:app` key (icon-gen's own-app artwork). Anything neither
      // family recognises degrades to '' so the glyph fallback above works.
      iconImage: (() => {
        if (it.iconImage === require('./icon-gen').APP_ICON_KEY) return it.iconImage;
        const custom = require('./custom-icons').sanitizeKey(it.iconImage);
        return custom || require('./dashboard-icons').sanitizeSlug(it.iconImage) || '';
      })(),
      type,
      // Container segments launch nothing — folders carry the whole payload in
      // the sub-menu, recents resolve theirs at summon — so the action slots
      // are wiped instead of lingering invisibly across a switch.
      value: isContainer ? '' : String(it.value ?? '').slice(0, 2048),
      // Launch parameters for `app` items (the Settings "Arguments" box),
      // tokenized by src/main/args.js at launch. Kept only for `app` so a
      // stale string can't ride across a type switch.
      args: type === 'app' ? String(it.args ?? '').slice(0, 2048) : '',
      color: HEX.test(it.color || '') ? it.color : null,
      // Per-segment icon-only override; the global appearance.showLabels
      // toggle still wins when labels are off for everyone.
      hideLabel: !!it.hideLabel,
      // Optional parameter slot; currently only the sys `explorer` action
      // consumes it (the folder Explorer opens in). Wiped on containers and
      // on `setting` (whose only parameter is the setting id in `value`);
      // inert on the other action types.
      dir: !isContainer && type !== 'setting' && typeof it.dir === 'string' ? it.dir.trim().slice(0, 2048) : '',
      // Folder sub-menu tree, pruned at the caps above. Deeper folders simply
      // lose their own children (they render as empty sub-menus).
      children: isFolder && depth < MAX_FOLDER_DEPTH
        ? (Array.isArray(it.children) ? it.children.slice(0, MAX_CHILDREN) : []).map((c, k) => cleanItem(c, k, depth + 1))
        : []
    };
  };
  const cleanRing = (arr) => Array.isArray(arr) ? arr.slice(0, 24).map((it, i) => cleanItem(it, i, 0)) : [];

  /* Rings arrive keyed by numeric strings; normalize to a contiguous 1..N
     (ascending key order, renumbered, capped at MAX_RINGS, floor of two keys
     so the UI always has an inner + outer list). Empty rings are legal —
     the renderer skips them when laying out bands. Shared by the top-level
     wheel and every profile's rings. */
  const cleanRings = (ringsIn, { neverEmpty = false } = {}) => {
    const srcRings = (ringsIn && typeof ringsIn === 'object') ? ringsIn : {};
    const ringArrays = Object.keys(srcRings)
      .map((k) => ({ n: Number(k), arr: srcRings[k] }))
      .filter((r) => Number.isInteger(r.n) && r.n >= 1)
      .sort((a, b) => a.n - b.n)
      .slice(0, MAX_RINGS)
      .map((r) => cleanRing(r.arr));
    const rings = {};
    const nRings = Math.max(2, ringArrays.length);
    for (let i = 0; i < nRings; i++) rings[String(i + 1)] = ringArrays[i] || [];
    // The default wheel must never ship empty; a profile MAY be empty (it is
    // then skipped at activation — see profiles.pickProfile).
    if (neverEmpty && !ringArrays.some((a) => a.length)) rings['1'] = defaults().rings[1];
    return rings;
  };

  const rings = cleanRings(src.rings, { neverEmpty: true });

  const bhvIn = src.behavior || {};
  const hotkey = HOTKEY_RE.test(String(src.hotkey ?? '').toLowerCase().trim())
    ? String(src.hotkey).toLowerCase().trim() : base.hotkey;

  /* --- theme system (v2): user gallery + the active theme reference ------- */
  const takenNames = new Set(themes().map((t) => t.name.toLowerCase()));
  const userThemes = (Array.isArray(src.userThemes) ? src.userThemes : [])
    .slice(0, MAX_USER_THEMES)
    .map((it) => cleanUserTheme(it, takenNames))
    .filter(Boolean);

  /* --- app-specific wheel profiles (activated by the foreground app) ---- */
  const profiles = (Array.isArray(src.profiles) ? src.profiles.slice(0, MAX_PROFILES) : [])
    .map((p) => {
      if (!p || typeof p !== 'object' || Array.isArray(p)) return null;                       // junk profiles dropped, never defaulted
      let name = String(p.name ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_PROFILE_NAME);
      if (!name) name = 'Profile';
      // Same exe-basename normalizer gaming mode uses ("C:\Games\Foo.exe" -> "foo.exe").
      const cleanApp = require('./gamemode').cleanAppName;
      const apps = [];
      const seenApp = new Set();
      for (const it of (Array.isArray(p.apps) ? p.apps.slice(0, MAX_PROFILE_APPS) : [])) {
        const n = cleanApp(it);
        if (!n || seenApp.has(n)) continue;
        seenApp.add(n);
        apps.push(n);
      }
      return {
        id: typeof p.id === 'string' && p.id ? p.id.slice(0, 40) : nid(),
        name,
        apps,
        rings: cleanRings(p.rings)     // may be all-empty — such a profile never activates
      };
    })
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
      // Whitelist: only 'cursor' / 'center' engage window placement; anything
      // else (junk included) is 'default' — apps position themselves as today.
      appOpenPosition: bhvIn.appOpenPosition === 'cursor' || bhvIn.appOpenPosition === 'center'
        ? bhvIn.appOpenPosition : 'default',
      // Fail-closed on purpose: junk/absent means "swallow the click", the safe default.
      mouseClickThrough: bhvIn.mouseClickThrough === true,
      flyoutDwellMs: clamp(bhvIn.flyoutDwellMs, 0, 600, base.behavior.flyoutDwellMs),
      gameMode: require('./gamemode').sanitizeGameMode(bhvIn.gameMode),
      // Off unless explicitly true — activation probes the foreground, so an
      // absent/junk flag must not cost the summon that call.
      profilesEnabled: bhvIn.profilesEnabled === true,
      // Both opt-out only: absent/junk keeps the feature ON (plain clicks
      // still fire under marking; the filter never interferes with chords).
      markingSelect: bhvIn.markingSelect !== false,
      typeToFilter: bhvIn.typeToFilter !== false,
      recentsCount: clamp(bhvIn.recentsCount, 3, 12, base.behavior.recentsCount),
      // Opt-in, fail-closed like mouseClickThrough: absent/junk = silent wheel.
      wheelSound: bhvIn.wheelSound === true,
      // Same opt-in discipline: absent/junk = always launch (legacy behavior).
      focusExistingApp: bhvIn.focusExistingApp === true,
      // Always the full {render, capture} shape — a half-written field can
      // never leave one direction missing for the picker filter.
      audioHidden: normalizeHiddenDevices(bhvIn.audioHidden)
    },
    theme: {
      id: themeId,
      customized: thIn.customized === true || signature(colors) !== signature(baseline),
      colors: baseline
    },
    userThemes,
    profiles,
    rings
  };
}

/* Sanitize ONE renderer-supplied item (the Settings preview button) through
   the exact cleanItem pipeline the store uses: type whitelist, the 2048-char
   value/args/dir caps, folder slots wiped non-executable. Nothing is
   executed before this runs — a compromised page can at worst preview a
   bounds-capped copy of what it sent (audit: action:preview drift). */
function sanitizeItem(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return validate({ rings: { '1': [src] } }).rings['1'][0];
}

/* Walk every configured item — each ring's items and, depth-first, the
   children of every folder at any stored depth. Returning false from fn stops
   the whole walk. Used by anything treating "every item" as one pool: the
   segment-click id match (ipc.js), icon prefetch, the settings renderer's
   helpers. Profile rings are part of the same pool — a profile's segment must
   satisfy the overlay's live-id match and warm its icons just like the default
   wheel's. */
function walkItems(cfg, fn) {
  const groups = [];
  if (cfg && cfg.rings && typeof cfg.rings === 'object') groups.push(cfg.rings);
  if (cfg && Array.isArray(cfg.profiles)) {
    for (const p of cfg.profiles) if (p && p.rings && typeof p.rings === 'object') groups.push(p.rings);
  }
  const down = (arr, depth) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      if (fn(it, depth) === false) return false;
      if (Array.isArray(it.children) && it.children.length && down(it.children, depth + 1) === false) return false;
    }
    return true;
  };
  for (const rings of groups) {
    for (const k of Object.keys(rings)) if (down(rings[k], 0) === false) return;
  }
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

/* Backup file name: `config-20261004-063015-import-r12.json`. Lexicographic
   order == chronological order (fixed-width local timestamp), the optional
   reason tag says WHICH action displaced it, and every character comes from a
   whitelist — a renderer-supplied reason can never smuggle a path separator. */
function backupName(date, rev, reason) {
  const p = (n, w) => String(n).padStart(w, '0');
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const tag = String(reason || '').toLowerCase().replace(/[^a-z0-9]+/g, '').slice(0, 12);
  return `config-${p(d.getFullYear(), 4)}${p(d.getMonth() + 1, 2)}${p(d.getDate(), 2)}-${p(d.getHours(), 2)}${p(d.getMinutes(), 2)}${p(d.getSeconds(), 2)}`
    + (tag ? `-${tag}` : '') + `-r${Math.max(0, rev | 0)}.json`;
}

class ConfigStore extends EventEmitter {
  constructor() {
    super();
    this._cfg = validate({});
    this._createdNew = false;
    this._watcher = null;
    this._suppressUntil = 0;
    this._lastGood = null;
    /* Backup throttle clock: starting at NOW means a burst of autosaves right
       after boot cannot crowd the rotation — only the forced ones (Import… /
       Reset) get in immediately. */
    this._lastBackupAt = Date.now();
    this.rev = 0;   // bumped on every genuine content change; the settings window
                    // uses it to tell its own saves' echoes from external edits
  }

  file() { return path.join(app.getPath('userData'), 'config.json'); }

  backupDir() { return path.join(app.getPath('userData'), BACKUP_DIR_NAME); }

  /* Newest-first inventory of the rolling backups, for the restore picker.
     Any fs trouble answers [] — the panel then simply says "none yet". */
  listBackups(limit = 50) {
    const dir = this.backupDir();
    try {
      return fs.readdirSync(dir)
        .filter((f) => BACKUP_STEM_RE.test(f))
        .sort()
        .reverse()
        .slice(0, Math.max(1, Math.min(limit | 0 || 1, 200)))
        .map((f) => {
          const full = path.join(dir, f);
          let size = 0, mtimeMs = 0;
          try { const st = fs.statSync(full); size = st.size; mtimeMs = st.mtimeMs; } catch { /* vanished mid-list */ }
          return { name: f, path: full, size, mtimeMs };
        });
    } catch { return []; }
  }

  /**
   * Copy the OUTGOING config.json into the backups folder before it is replaced.
   * Skips: no file yet, a save that changes nothing on disk, and ordinary saves
   * inside the throttle window. `force` (import / reset) ignores the throttle —
   * those are the two actions whose Undo toast the user may never see.
   * Never throws: a backup problem is logged and the save proceeds.
   */
  _backupOutgoing(reason, force = false, newJson = null) {
    try {
      const p = this.file();
      if (!fs.existsSync(p)) return false;
      let old;
      try { old = fs.readFileSync(p, 'utf8'); } catch { return false; }
      if (!old) return false;
      if (newJson !== null && old === newJson) return false;   // the save is a no-op — nothing is being lost
      const now = Date.now();
      if (!force && now - this._lastBackupAt < BACKUP_MIN_INTERVAL_MS) return false;
      const dir = this.backupDir();
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, backupName(new Date(), this.rev, reason));
      fs.writeFileSync(dest, old, 'utf8');
      this._lastBackupAt = now;
      this._pruneBackups();
      log.info(`config backup kept: ${path.basename(dest)}`);
      return true;
    } catch (err) {
      log.warn('config backup skipped:', (err && err.message) || err);
      return false;
    }
  }

  /* Keep the newest MAX_BACKUPS files. Only ever deletes our own filename
     shape, so anything a user drops in the folder survives. */
  _pruneBackups() {
    try {
      const dir = this.backupDir();
      const names = fs.readdirSync(dir).filter((f) => BACKUP_STEM_RE.test(f)).sort().reverse();
      for (const f of names.slice(MAX_BACKUPS)) {
        try { fs.unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
      }
    } catch { /* pruning is housekeeping */ }
  }

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

  /* opts.backup === 'force' skips the throttle (the destructive paths: Import…
     and Reset), opts.reason tags the backup's file name. */
  set(newCfg, opts = {}) {
    const merged = validate({ ...newCfg, version: VERSION });
    const old = this._cfg;
    const oldGood = this._lastGood;
    const oldRev = this.rev;
    this._cfg = merged;
    this.rev++;
    try {
      this._write(opts);
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

  _write(opts = {}) {
    const p = this.file();
    const tmp = p + '.tmp';
    this._suppressUntil = Date.now() + 300;
    const json = JSON.stringify(this._cfg, null, 2);
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      // Safety net first (best-effort: never fails the save the user asked for).
      // The new JSON is passed in so a save that changes nothing on disk is not
      // worth a backup slot.
      this._backupOutgoing(opts.reason || (opts.backup === 'force' ? 'replace' : ''), opts.backup === 'force', json);
      fs.writeFileSync(tmp, json, 'utf8');
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

module.exports = { ConfigStore, validate, defaults, sanitizeItem, walkItems, backupName, VERSION, MAX_RINGS, MAX_CHILDREN, MAX_FOLDER_DEPTH, MAX_PROFILES, MAX_PROFILE_APPS, MAX_BACKUPS, BACKUP_MIN_INTERVAL_MS };
