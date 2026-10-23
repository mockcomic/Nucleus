import { buildWheel, createFlyoutNavigator } from '../shared/wheel-core.js';
import { THEMES, themeById, themeBySignature, signature, computeChrome, chromeVarMap, paletteMode } from '../../main/themes.mjs';
import { ICON_CATALOG } from '../shared/icon-catalog.js';

const api = window.wheelAPI;
const $ = (s, r = document) => r.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

let cfg = null;
let dirty = false;
let saveTimer = null;
let openEditorKey = null;          // "ring-index" of the expanded row
let iconModalTarget = null;        // item currently picking an icon

/* ------------------------------ ring helpers -------------------------------
   Rings are keyed 1..N outward in cfg.rings (config.js normalizes to a
   contiguous range and enforces the same cap). */
const MAX_RINGS = 4;
/* Keep in sync with src/main/config.js — the renderer cannot require it. */
const MAX_CHILDREN = 12;        // segments inside one folder sub-menu
const MAX_FOLDER_DEPTH = 3;     // folder-in-folder-in-folder
const MAX_PROFILES = 8;         // app profiles (config.js MAX_PROFILES)

/* Which ring tree the editor shows: the default wheel, or one app profile's.
   activeProfileId rides the session only (not config) — opening Settings
   always lands back on the default wheel. */
let activeProfileId = null;
function profileById(id) {
  if (!id || !cfg || !Array.isArray(cfg.profiles)) return null;
  return cfg.profiles.find((p) => p && p.id === id) || null;
}
function activeProfile() {
  const p = profileById(activeProfileId);
  if (!p) activeProfileId = null;          // profile vanished (external reload / reset)
  return p;
}
/* The rings object every segment UI reads and writes: profile rings when one
   is selected, the default wheel otherwise. */
function ringsModel(c = cfg) {
  const p = (c === cfg) ? activeProfile() : null;
  return (p ? p.rings : (c && c.rings)) || {};
}

function ringKeys(c = cfg) {
  const src = ringsModel(c);
  const ns = Object.keys(src || {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  return (ns.length ? ns : [1, 2]).map(String);
}
function ringItems(c = cfg) {
  const src = ringsModel(c);
  return ringKeys(c).flatMap((k) => (Array.isArray(src[k]) ? src[k] : []));
}
/* Mirror of config.js walkItems: every item INCLUDING folder children,
   depth-first, of the EDITED ring tree (active profile or default). Anything
   treating "every item" as one pool (icon prefetch, modal target lookup)
   uses this, not ringItems(). */
function allItems(c = cfg) {
  const out = [];
  const src = ringsModel(c);
  const down = (arr, d) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      out.push(it);
      if (Array.isArray(it.children) && it.children.length && d < MAX_FOLDER_DEPTH) down(it.children, d + 1);
    }
  };
  for (const k of ringKeys(c)) down(src[k], 0);
  return out;
}
function ringTitle(n, N) {
  if (N <= 2) return n === '1' ? 'Inner ring' : 'Outer ring';
  return `Ring ${n}` + (n === '1' ? ' (inner)' : n === String(N) ? ' (outer)' : '');
}
/* Compact form for the editor's radio group. */
function ringRadioLabel(r, keys) {
  if (keys.length <= 2) return r === '1' ? 'inner' : 'outer';
  if (r === '1') return 'inner';
  if (r === keys[keys.length - 1]) return 'outer';
  return 'ring ' + r;
}

function el(tag, cls, attrs = {}, parent = null) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'text') e.textContent = v;
    else if (k === 'html') e.innerHTML = v;
    else e.setAttribute(k, v);
  }
  if (parent) parent.appendChild(e);
  return e;
}

/* ------------------------------- toasts ---------------------------------- */
function toast(msg, isError = false, undoFn = null, ttl = 2600) {
  const t = el('div', 'toast' + (isError ? ' error' : ''), {}, $('#toasts'));
  el('span', null, { text: msg }, t);
  // A toast the user can still hold is a toast they can still act on: the ttl
  // freezes while the pointer or keyboard focus is inside it, so an Undo link
  // is catchable, not lucky. (Autosave has already committed — this is the net.)
  let left = ttl, timer = null, at = 0;
  const arm = () => {
    at = Date.now();
    timer = setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, left);
  };
  const stop = () => {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    left = Math.max(800, left - (Date.now() - at));   // never resume to less than a beat
  };
  if (undoFn) {
    const u = el('button', 'undo', { text: 'Undo', type: 'button' }, t);
    u.onclick = () => { stop(); undoFn(); t.remove(); };
    ttl = left = 6000;
  }
  t.addEventListener('mouseenter', stop);
  t.addEventListener('mouseleave', arm);
  t.addEventListener('focusin', stop);
  t.addEventListener('focusout', arm);
  arm();
}

/* ------------------------------- persistence ------------------------------ */
function setSaveState(text, state = '') {
  const s = $('#save-state');
  if (s) { s.textContent = text; s.className = 'save-state' + (state ? ' ' + state : ''); }
}

function touch(rerender = true) {
  dirty = true;
  setSaveState('Saving…');
  if (rerender) renderSegments();
  renderPreview();                      // the preview must track EVERY model change, even mid-keystroke edits that skip the row-list rebuild
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 450);
}

async function persist() {
  dirty = false;
  const sent = JSON.stringify(cfg);
  let r = null;
  try {
    r = await api.setConfig(cfg);
  } catch (err) {
    // Handlers are written to answer {ok:false}, but the invoke can still
    // reject (window reloaded mid-save) — never leave the UI stuck "Saving…".
    r = { ok: false, error: String((err && err.message) || err) };
  }
  if (r && r.ok) {
    if (typeof r.rev === 'number') storeRev = r.rev;   // our graph now matches the store's revision
    // Do NOT adopt the reply blindly: it is a fresh object graph, and swapping
    // it in would orphan the item refs the open editor/modal captured. Adopt
    // only when the store normalized our payload (and nothing was typed during
    // the round-trip — that newer local data must survive until the next save).
    const local = JSON.stringify(cfg);
    if (local === sent && local !== JSON.stringify(r.config)) {
      cfg = r.config;
      renderAll();
    }
    updateHotkeyChip();
    setSaveState('Saved');
    const warn = $('#cfg-warn');
    if (warn) warn.classList.add('hidden');   // a good save means config.json is fine now
    if (r.hotkeyError) showHkError(r.hotkeyError);
    if (pendingExternal) showConflict();       // disk changed while we typed — the user picks
  } else {
    dirty = true;
    setSaveState('Not saved', 'err');
    toast('Could not save: ' + ((r && r.error) || 'unknown'), true);
    // Retry shortly on our own — waiting for the user to type again would
    // silently drop the edits if they never touch an input before quitting.
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 2000);
  }
}

/* -------------------------------- tabs ------------------------------------ */
const tabBtns = [...document.querySelectorAll('.tab-btn')];
/* Set by wireAdvanced(): the Usage panel re-reads its counts every time the
   tab is opened, so the numbers never go stale behind the user's back. */
let onAdvancedTab = null;
/* Set by wireAudio(): opening the Audio tab (re)loads devices/levels/sessions
   and arms the live poll; leaving it — or the window hiding — stops that poll,
   so nothing runs in the background while the user is anywhere else. */
let onAudioTab = null;
let audioTabLeaveHook = null;      // set by wireAudio(): stopAudioPoll
function selectTab(b, focus = false) {
  tabBtns.forEach((x) => {
    x.classList.toggle('active', x === b);
    x.setAttribute('aria-selected', String(x === b));
    x.tabIndex = x === b ? 0 : -1;
  });
  document.querySelectorAll('.tab').forEach((t) => t.classList.add('hidden'));
  const panel = $('#tab-' + b.dataset.tab);
  panel.classList.remove('hidden');
  panel.setAttribute('role', 'tabpanel');
  panel.setAttribute('aria-labelledby', 'tabbtn-' + b.dataset.tab);
  if (b.dataset.tab === 'advanced' && onAdvancedTab) { try { onAdvancedTab(); } catch { /* a stale panel must never block tabbing */ } }
  if (b.dataset.tab === 'audio' && onAudioTab) { try { onAudioTab(); } catch { /* ditto */ } }
  if (b.dataset.tab !== 'audio' && audioTabLeaveHook) { try { audioTabLeaveHook(); } catch { /* stop failed, timer will self-cancel */ } }
  if (focus) b.focus();
}
tabBtns.forEach((b) => {
  b.id = 'tabbtn-' + b.dataset.tab;
  b.setAttribute('role', 'tab');
  b.setAttribute('aria-controls', 'tab-' + b.dataset.tab);
  b.addEventListener('click', () => selectTab(b));
  b.addEventListener('keydown', (e) => {
    const i = tabBtns.indexOf(b);
    let n = -1;
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % tabBtns.length;
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + tabBtns.length) % tabBtns.length;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = tabBtns.length - 1;
    if (n >= 0) { e.preventDefault(); selectTab(tabBtns[n], true); }
  });
});
const navEl = document.querySelector('#sidebar nav');
if (navEl) navEl.setAttribute('role', 'tablist');
selectTab(tabBtns[0]);

/* ---------------------- dashboard-icons logo resolution ------------------- */
/* item.iconImage holds a dashboardicons slug; main hands us data: URLs (and
   caches the bytes on disk). Successes are cached forever; failures only get
   a 60 s cooldown — a cache that never retried kept every logo glyph-only
   until app restart once the wheel had popped while offline. */
const imgCache = new Map();
const failedAt = new Map();          // slug -> ms timestamp of last failed resolve
const ICON_FAIL_TTL = 60000;
const iconPending = new Set();
const liveIconSpans = [];        // [{span, item, fallback}] — repopulated by renderSegments

function fillIconSpan(span, item, fallback) {
  const url = item.iconImage ? imgCache.get(item.iconImage) : null;
  if (url) {
    span.innerHTML = '';
    const im = document.createElement('img');
    im.className = 'seg-ico-img';
    im.src = url;
    im.alt = '';
    span.appendChild(im);
  } else {
    span.textContent = fallback;
  }
}

function registerIconSpan(span, item, fallback) {
  liveIconSpans.push({ span, item, fallback });
  fillIconSpan(span, item, fallback);
  if (item.iconImage && !imgCache.get(item.iconImage)) requestIconImage(item.iconImage);
}

function requestIconImage(slug) {
  const hit = imgCache.get(slug);
  if (hit) return Promise.resolve(hit);
  const at = failedAt.get(slug) || 0;
  if (at && Date.now() - at < ICON_FAIL_TTL) return Promise.resolve(null);   // fresh failure — cool down
  if (iconPending.has(slug)) return Promise.resolve(null);
  iconPending.add(slug);
  return api.iconDataUrl(slug).then((r) => {
    iconPending.delete(slug);
    const url = r && r.ok ? r.dataUrl : null;
    if (url) { imgCache.set(slug, url); failedAt.delete(slug); }
    else failedAt.set(slug, Date.now());
    refreshIconSpans();
    renderPreview();
    return url;
  }, () => {
    iconPending.delete(slug);
    failedAt.set(slug, Date.now());
    return null;
  });
}

function refreshIconSpans() {
  for (const { span, item, fallback } of liveIconSpans) if (span.isConnected) fillIconSpan(span, item, fallback);
}

function ensureAllIcons() {
  if (!cfg) return;
  for (const it of allItems()) if (it.iconImage) requestIconImage(it.iconImage);
}

/* ------------------------------- segments --------------------------------- */
/* The type vocabulary the user sees. The config keeps the raw type words
   (app, url, sys …); every USER-FACING string is the plain-English form:
   `menu` in the Type dropdown — grouped, so the power-user types (shell
   commands, the macro DSL) sit out of a beginner's way instead of leading
   the list — and `chip` on the collapsed row (raw `app`/`sys` strings read
   like an error log to a non-tech person). */
const TYPE_META = {
  app:     { chip: 'program',    menu: 'Open a program', group: 0 },
  url:     { chip: 'website',    menu: 'Open a website', group: 0 },
  file:    { chip: 'file',       menu: 'Open a file', group: 0 },
  sys:     { chip: 'Windows',    menu: 'Windows action — lock, volume, Explorer…', group: 0 },
  mixer:   { chip: 'mixer',      menu: 'App volume mixer — flyout with quick sliders and device pickers', group: 0 },
  setting: { chip: 'app toggle', menu: 'Flip one of Nucleus\u2019s own switches', group: 0 },
  folder:  { chip: 'folder',     menu: 'Folder — sub-menu that branches on hover', group: 1 },
  recent:  { chip: 'recents',    menu: 'Recents — fills itself with your most-used segments', group: 1 },
  command: { chip: 'command',    menu: 'Run a command or script — for power users', group: 2 },
  macro:   { chip: 'keystrokes', menu: 'Type or click for you (macro) — for power users', group: 2 }
};
const TYPE_GROUP_LABELS = ['Everyday actions', 'Organize the wheel', 'Power user'];

function typeChip(t) { return (TYPE_META[t] || {}).chip || t; }
function typeMenuLabel(t) { return (TYPE_META[t] || {}).menu || t; }

/* The old flat TYPE_OPTIONS put 'command — shell command / script' one slot
   from 'app — launch program'; the dropdown now renders TYPE_META through
   the groups above. */
function fillTypeSelect(selType, current) {
  const groups = TYPE_GROUP_LABELS.map(() => null);
  for (const t of Object.keys(TYPE_META)) {
    const g = TYPE_META[t].group;
    if (!groups[g]) groups[g] = el('optgroup', null, { label: TYPE_GROUP_LABELS[g] }, selType);
    el('option', null, { value: t, text: TYPE_META[t].menu }, groups[g]);
  }
  // A config can carry a type the UI no longer lists (hand-edited, or from an
  // older build) — keep it selectable so the select never lies about the
  // stored value.
  if (current && !Object.prototype.hasOwnProperty.call(TYPE_META, current)) {
    el('optgroup', null, { label: 'Other' }, selType)
      .appendChild(el('option', null, { value: current, text: current }));
  }
}

/* Reserved iconImage key for the app's own wheel artwork (mirrors
   icon-gen's APP_ICON_KEY — the renderer cannot require the main module). */
const APP_ICON_IMAGE_KEY = 'builtin:app';

/* What goes in the value box, per type — a single "Target" label asked the user
   to guess; each type now names its own parameter. */
const TARGET_LABELS = { app: 'Program', url: 'Link', file: 'File', command: 'Command', macro: 'Keys', sys: 'Action', setting: 'Setting' };

/* Browse… dialogs per type (title + file filters passed to the main process). */
const BROWSE_OPTS = {
  app: { title: 'Choose a program', extensions: ['exe', 'lnk', 'bat', 'cmd', 'msc'] },
  file: { title: 'Choose a file' },
  command: { title: 'Choose a script to run', filterName: 'Scripts & programs', extensions: ['bat', 'cmd', 'ps1', 'exe'] }
};

function renderSegments() {
  liveIconSpans.length = 0;
  const host = $('#ring-lists');
  host.innerHTML = '';
  const R = ringsModel();                       // the default wheel — or the selected profile's rings
  const keys = ringKeys();
  const N = keys.length;
  let createdRing = false;
  for (const ring of keys) {
    if (!R[ring]) { R[ring] = []; createdRing = true; }
    const sec = el('div', 'ring-sec', {}, host);
    const head = el('div', 'ring-head', {}, sec);
    el('h3', null, { text: ringTitle(ring, N) }, head);
    el('span', 'muted', { text: `${R[ring].length} segment${R[ring].length === 1 ? '' : 's'}` }, head);
    const add = el('button', 'btn small', { text: '+ Add' }, head);
    add.onclick = () => {
      const item = newSegItem();
      R[ring].push(item);
      openEditorKey = `${ring}-${R[ring].length - 1}`;
      touch();
      // touch() rerendered synchronously — land the caret in the new row's Label box
      // so the user can type the name right away (and pre-select "New item" to replace it).
      const lbl = document.querySelector(`[data-seg-key="${openEditorKey}"] .seg-edit input`);
      if (lbl) { lbl.focus(); lbl.select(); }
    };
    if (ring === keys[N - 1] && N >= 3) {
      const rm = el('button', 'btn small glyph', { text: '\uE75D', title: 'Remove this ring', 'aria-label': 'Remove ' + ringTitle(ring, N) }, head);
      rm.onclick = () => removeRing(ring);
    }
    if (!R[ring].length) {
      el('div', 'empty-hint muted', { text: 'Empty — this ring won\u2019t render.' }, sec);
      continue;
    }
    const list = el('div', 'seg-list', {}, sec);
    R[ring].forEach((item, i) => list.appendChild(segRow({ ring, owner: R[ring], item, i, key: `${ring}-${i}`, depth: 0 })));
  }
  // renderSegments created a missing ring array — model mutated in render;
  // flag it (preview-only touch) so the repair reaches disk without a keystroke.
  if (createdRing) touch(false);
  if (N < MAX_RINGS) {
    const addRing = el('button', 'btn', { text: '+ Add ring', title: `Add ring ${N + 1} (outermost)` }, host);
    addRing.style.marginTop = '4px';
    addRing.onclick = () => {
      R[String(N + 1)] = [];
      touch();
      toast(`Ring ${N + 1} added — its segments sit outside the current outer ring`, false, () => {
        if ((R[String(N + 1)] || []).length) return;   // in use — keep it
        delete R[String(N + 1)];
        touch();
      });
    };
  } else {
    el('div', 'empty-hint muted', { text: `Ring limit reached (${MAX_RINGS}).` }, host);
  }
}

/* Remove the outermost ring: items migrate inward if the neighbour can take
   them (the 24-per-ring cap holds); removal undo restores ring + items. */
function removeRing(ring) {
  const R = ringsModel();
  const items = R[ring] || [];
  const inner = R[String(Number(ring) - 1)];
  if (items.length && inner.length + items.length > 24) {
    toast(`Can\u2019t fold ${items.length} segments into the ring below (max 24) — move or delete some first`, true);
    return;
  }
  delete R[ring];
  inner.push(...items);
  if (openEditorKey && openEditorKey.startsWith(ring + '-')) openEditorKey = null;
  touch();
  const moved = items.slice();
  toast(`Removed ${ringTitle(ring, ringKeys().length + 1)}`, false, () => {
    const R2 = ringsModel();
    for (const it of moved) {
      const k = inner.indexOf(it);
      if (k >= 0) inner.splice(k, 1);        // pull the migrated items back
    }
    R2[ring] = moved;                        // and re-raise the ring (on the model being edited)
    touch();
  });
}

/* Previewing these can affect the machine or the app itself — a setting fire
   really mutates the live config — so Play arms on the first click. */
const GUARDED_TYPES = new Set(['command', 'macro', 'sys', 'setting']);

/* Row + editor work on an OWNER ARRAY, not a ring key, so the same component
   renders ring segments (depth 0, owner = cfg.rings[ring]) and folder children
   (depth > 0, owner = parentItem.children). `key` addresses disclosure state
   across the tree ("1-3", "1-3/0", …). */
function newSegItem(type = 'app') {
  const it = { id: crypto.randomUUID(), label: 'New item', icon: '', iconImage: '', type, value: '', color: null };
  if (type === 'folder') it.children = [];
  return it;
}

/* Deep-copy with FRESH ids throughout the subtree: the overlay matches
   clicked items against the live config by id (ipc.js), so a duplicated
   folder must not smuggle its children's old ids back in. */
function renewIds(it) {
  const c = clone(it);
  const down = (x) => { x.id = crypto.randomUUID(); (Array.isArray(x.children) ? x.children : []).forEach(down); };
  down(c);
  return c;
}

function segRow(ctx) {
  const { owner, item, key, depth } = ctx;
  const row = el('div', 'seg-row');
  row.dataset.segKey = key;
  if (depth > 0) row.classList.add('seg-kid');
  const main = el('div', 'seg-main', {}, row);

  // Proper disclosure button (mouse click on the row also opens the editor below).
  const disc = el('button', 'btn mini seg-disc', {
    title: openEditorKey === key ? 'Close editor' : 'Edit segment',
    'aria-label': `Edit segment ${item.label || '(no name)'}`,
    'aria-expanded': String(openEditorKey === key)
  }, main);
  el('span', 'g', { text: '\uE70D' }, disc);   // ChevronDown

  const icoSpan = el('span', 'seg-ico', {}, main);
  registerIconSpan(icoSpan, item, item.icon || (item.type === 'folder' ? '\uE838' : item.type === 'recent' ? '\uE823' : item.type === 'mixer' ? '\uE767' : item.type === 'sys' || item.type === 'setting' ? '\uE713' : '\uE76C'));
  el('span', 'seg-name', { text: item.label || '(no name)' }, main);
  // Friendly chip (program/website/Windows…) — the raw type word only survives
  // as the tooltip and as the fallback for types the UI does not list.
  el('span', 'seg-type', { text: typeChip(item.type), title: typeMenuLabel(item.type) }, main);
  el('span', 'seg-val', { text: rowValueText(item) }, main);

  const acts = el('div', 'seg-actions', {}, main);
  const mini = (glyph, label, fn, cls = '', tip = label) => {
    const b = el('button', 'btn mini' + (cls ? ' ' + cls : ''), { title: tip, 'aria-label': label }, acts);
    el('span', 'g', { text: glyph }, b);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  /* Row carries four live controls + disclosure. Reorder acts on item identity,
     not the captured index: hold-to-repeat keeps stepping across rerenders
     while the item itself keeps moving. Ring-move and Duplicate live in the
     editor — seven anonymous glyphs on one row read like a generic toolbar. */
  const stepMove = (dir) => {
    const a = owner;
    const j = a.indexOf(item);
    const k = j + dir;
    if (j < 0 || k < 0 || k >= a.length) return false;
    [a[j], a[k]] = [a[k], a[j]];
    touch();
    return true;
  };
  const holdRepeat = (btn, dir) => {
    let t0 = null, t1 = null;
    const stop = () => { clearTimeout(t0); clearInterval(t1); t0 = t1 = null; };
    btn.addEventListener('pointerdown', () => {
      // click = one step; holding past 420ms steps every 110ms until release or edge
      t0 = setTimeout(() => { t1 = setInterval(() => { if (!stepMove(dir)) stop(); }, 110); }, 420);
      // the row rerenders mid-hold (touch() rebuilds it), so the release
      // listener sits on window — but registered only WHILE a hold is live:
      // at-render-time registration left rows×2 window listeners behind on
      // every full re-render, each pinning its detached button.
      window.addEventListener('pointerup', () => stop(), { once: true });
    });
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('blur', stop);
  };
  holdRepeat(mini('\uE74A', 'Move earlier', () => stepMove(-1), '', 'Move earlier — hold to keep moving'), -1);
  holdRepeat(mini('\uE74B', 'Move later', () => stepMove(1), '', 'Move later — hold to keep moving'), 1);
  // One hairline separates the transport pair from the live-action pair —
  // the slip-guard margins were conceding the mis-click; this resolves it.
  el('span', 'act-sep', { 'aria-hidden': 'true' }, acts);
  // Play can fire arbitrary shell commands, injected keystrokes, or lock/sleep
  // — those require a deliberate second click, not a slip from Delete.
  if (item.type !== 'folder' && item.type !== 'recent' && item.type !== 'mixer') {
    // A folder/recents/mixer container executes nothing (main refuses them
    // too) — no Play affordance to dangle.
    let armed = false, armTimer = null;
    const runBtn = mini('\uE9A1', 'Try this action now', async () => {   // Play — E768 renders the catalog's Mic glyph
      if (GUARDED_TYPES.has(item.type) && !armed) {
        armed = true;
        runBtn.querySelector('.g').textContent = '\uE7BA';   // Warning
        runBtn.classList.add('armed');
        runBtn.title = `Really run “${item.label}”? This ${item.type} can affect other apps — click again within 3s`;
        clearTimeout(armTimer);
        armTimer = setTimeout(disarm, 3000);
        return;
      }
      disarm();
      const r = await api.previewAction(item);
      toast(r.ok ? `Ran “${item.label}”` : `“${item.label}” failed: ${r.error}`, !r.ok);
    }, 'act-run');
    function disarm() {
      armed = false;
      clearTimeout(armTimer);
      runBtn.querySelector('.g').textContent = '\uE9A1';
      runBtn.classList.remove('armed');
      runBtn.title = 'Try this action now';
    }
  }
  mini('\uE75D', 'Delete segment', () => {   // Trash (E894 stays reserved for clear/close)
    if (depth === 0 && ringItems().length <= 1) {
      toast('The wheel needs at least one segment', true);
      return;
    }
    // Inverse-op undo: the item goes back exactly where it was, and every
    // edit made AFTER the delete survives. (Graph-swap undos silently ate
    // unrelated later work — the critique's P1.)
    const from = owner;
    const idx = from.indexOf(item);
    from.splice(idx, 1);
    touch();
    toast(`Removed “${item.label}”`, false, () => {
      // Re-fetch the live array: an external-config swap replaces ring arrays
      // wholesale; a folder's children array rides on its parent item.
      const RM = ringsModel();
      const cur = depth === 0 ? (RM[ctx.ring] || (RM[ctx.ring] = [])) : owner;
      if (cur.some((x) => x.id === item.id)) return;   // already restored meanwhile
      cur.splice(Math.min(idx, cur.length), 0, item);
      touch();
    });
  }, 'act-del');

  const toggleEditor = () => {
    openEditorKey = openEditorKey === key ? null : key;
    renderSegments();
    const rowEl = document.querySelector(`[data-seg-key="${key}"]`);
    const ed = rowEl && rowEl.querySelector('.seg-edit');
    if (ed) ed.querySelector('input')?.focus();
    else rowEl?.querySelector('.seg-disc')?.focus();
  };
  disc.onclick = (e) => { e.stopPropagation(); toggleEditor(); };
  main.addEventListener('click', toggleEditor);

  // Own editor opens the full form; a DESCENDANT's editor keeps just the
  // folder manager visible, so opening a child never hides the child list
  // you clicked through.
  const openSelf = openEditorKey === key;
  const openDesc = !openSelf && typeof openEditorKey === 'string' && openEditorKey.startsWith(key + '/');
  if (openSelf || openDesc) row.appendChild(segEditor(ctx, openSelf));
  return row;
}

function sysLabel(id) {
  const c = sysEntry(id);
  return c ? c.label : id;
}

function sysEntry(id) {
  return (sysCatalogCache || []).find((x) => x.id === id) || null;
}

/* Row caption: a folder-capable sys action (File Explorer) additionally shows
   the picked folder's leaf name, so a wheel with several Explorer segments
   stays readable. The leaf mirrors main's normalizeFolder() — quotes and
   trailing separators never reach the caption. */
function sysDisplayText(item) {
  const label = sysLabel(item.value);
  const ent = sysEntry(item.value) || {};
  if (item.dir && ent.hasDevice) return `${label} — ${audioDeviceLabel(item.dir)}`;
  if (item.dir && ent.hasDir) {
    const leaf = String(item.dir).trim().replace(/^["']+|["']+$/g, '')
      .replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (leaf) return `${label} — ${leaf}`;
  }
  return label;
}

/* Collapsed-row caption for every type: the sys display text, or the target
   plus (for app items) the launch parameters, so a set Arguments box is
   visible without opening the editor. */
function rowValueText(item) {
  if (item.type === 'folder') {
    const n = Array.isArray(item.children) ? item.children.length : 0;
    return n ? `${n} segment${n === 1 ? '' : 's'} inside` : 'empty sub-menu';
  }
  if (item.type === 'sys') return sysDisplayText(item);
  if (item.type === 'recent') return 'fills itself from your most-recently-used segments';
  if (item.type === 'mixer') return 'volume-mixer flyout — master + per-app sliders and the default device pickers on the wheel';
  if (item.type === 'setting') return settingLabel(item.value);
  if (item.type === 'app' && String(item.args || '').trim()) return item.value + '  ' + String(item.args).trim();
  return item.value;
}

let sysCatalogCache = null;

/* type: 'setting' — catalog of app parameters, loaded from main beside
   sysCatalogCache at boot. One entry per toggle; ids match main's
   appsettings.js gate (execution refuses anything outside it). */
let appSettingsCatalogCache = null;

/* ---------------- audio endpoint caches (shared by the Audio tab and the
   segment editor's device picker) -------------------------------------------
   Lists come from main's Core Audio module; names are cached by endpoint id
   so a bound segment can still show "Headphones" as its caption after the
   user moves on. The caches are per-flow and lazy — cold until first asked. */
const audioDeviceCache = { render: null, capture: null };
const audioDeviceNames = new Map();          // endpoint id -> friendly name

async function loadAudioDevices(flow, force = false) {
  if (audioDeviceCache[flow] && !force) return audioDeviceCache[flow];
  const r = await safe(() => api.audioDevices(flow));
  const list = (r && r.ok && Array.isArray(r.devices)) ? r.devices : [];
  list.forEach((d) => { if (d && d.id) audioDeviceNames.set(d.id, d.name || d.id); });
  audioDeviceCache[flow] = list;
  return list;
}

/* The hidden-device manager's view of the SAME endpoint list: main filters
   the shared audio:devices channel app-wide, so the manager asks for the
   unfiltered truth (strict includeHidden === true) and offers Hide/Restore
   for every endpoint Windows has, not just the visible ones. */
async function loadAllAudioDevices(flow) {
  const r = await safe(() => api.audioDevices(flow, true));
  const list = (r && r.ok && Array.isArray(r.devices)) ? r.devices : null;
  if (list) list.forEach((d) => { if (d && d.id) audioDeviceNames.set(d.id, d.name || d.id); });
  return list;
}

/* Caption for a bound endpoint id when the cache is cold: the id's own tail,
   mirroring main's fallbackName so the two never disagree on junk. */
function audioDeviceLabel(id) {
  const hit = audioDeviceNames.get(id);
  if (hit) return hit;
  const s = String(id || '');
  const tail = s.includes('::') ? s.slice(s.lastIndexOf('::') + 2) : s;
  return (tail.replace(/[{}]/g, '') || s).slice(0, 60);
}

function settingEntry(id) {
  return (appSettingsCatalogCache || []).find((x) => x.id === id) || null;
}

function settingLabel(id) {
  const c = settingEntry(id);
  return c ? c.label : id;
}

function segEditor(ctx, withFields = true) {
  const { owner, item, key, depth } = ctx;
  const ring = ctx.ring;
  const f = el('div', 'seg-edit');
  // A DESCENDANT editor is open (this folder's own fields are collapsed):
  // keep just the branch manager on screen so the tree never hides itself.
  if (withFields === false && item.type === 'folder') { folderManager(ctx, f); return f; }
  const uid = `se-${item.id}`;
  // Text inputs must NOT rerender the row list mid-keystroke — renderSegments()
  // tears down host.innerHTML and destroys the focused input. Write the model,
  // sync the row captions in place, debounce-save without rerender.
  const bind = (inputEl, apply, evt = 'input') => {
    inputEl.addEventListener(evt, () => { apply(inputEl); syncRowText(); touch(false); });
    return inputEl;
  };
  const syncRowText = () => {
    const row = f.closest('.seg-row');
    if (!row) return;
    const name = row.querySelector('.seg-name');
    if (name) name.textContent = item.label || '(no name)';
    const val = row.querySelector('.seg-val');
    if (val) val.textContent = rowValueText(item);
  };

  /* One form row = label cell + control cell; every control shares one left
     anchor (CSS owns .f-label/.f-ctl/.f-hint). The old 4-column grid assumed
     a double-width pane and shoved Type/Color off the card edge. */
  const field = (labelText, forId) => {
    if (labelText) el('label', 'f-label', forId ? { text: labelText, for: forId } : { text: labelText }, f);
    else el('span', 'f-label', {}, f);
    return el('div', 'f-ctl', {}, f);
  };
  const hint = (o) => el('div', 'f-hint', o, f);

  const cLabel = field('Label', uid + '-label');
  const inLabel = bind(el('input', null, { type: 'text', maxlength: '40', value: item.label, id: uid + '-label' }), (e) => item.label = e.value);
  cLabel.appendChild(inLabel);
  const hideLb = el('label', 'chk', { title: 'Show this segment as icon only — hides its label on the wheel' }, cLabel);
  const chkHide = el('input', null, { type: 'checkbox', 'aria-label': 'Hide label on wheel' }, hideLb);
  el('span', null, { text: 'Hide label' }, hideLb);
  chkHide.checked = !!item.hideLabel;
  chkHide.addEventListener('change', () => { item.hideLabel = chkHide.checked; touch(false); });

  const cType = field('Type', uid + '-type');
  const selType = el('select', null, { id: uid + '-type' }, cType);
  fillTypeSelect(selType, item.type);
  selType.value = item.type;
  selType.addEventListener('change', () => {
    const oldType = item.type;
    item.type = selType.value;
    // Each type owns a disjoint value namespace — carrying an old one over
    // left the parameter box showing a sys catalog id as "Keys" (and an
    // unknown id parked in the Action select at selectedIndex -1).
    if (item.type === 'folder') {
      item.value = '';
      item.args = '';
      item.dir = '';                                 // folders execute nothing
      if (!Array.isArray(item.children)) item.children = [];
      if (!item.icon && !item.iconImage) item.icon = '\uE838';   // open-folder glyph
    } else if (item.type === 'recent') {
      item.value = '';
      item.args = '';
      item.dir = '';
      item.children = [];                            // main fills the fan at summon time
      if (!item.icon && !item.iconImage) item.icon = '\uE823';   // history-clock glyph
    } else if (item.type === 'mixer') {
      item.value = '';
      item.args = '';
      item.dir = '';
      item.children = [];                            // the card is built live from Core Audio — nothing stored
      if (!item.icon && !item.iconImage) item.icon = '\uE767';   // volume-mixer glyph
    } else if (oldType === 'folder' || oldType === 'recent' || oldType === 'mixer') {
      item.children = [];                            // the sub-menu slot is container-only
    } else if (item.type === 'sys') {
      if (!(sysCatalogCache || []).some((c) => c.id === item.value)) {
        item.value = (sysCatalogCache && sysCatalogCache[0] && sysCatalogCache[0].id) || '';
      }
    } else if (item.type === 'setting') {
      // The setting id reuses the value slot; sys and setting ids never
      // overlap, so a carried-over id simply fails the membership test.
      item.args = '';
      item.dir = '';
      if (!(appSettingsCatalogCache || []).some((c) => c.id === item.value)) {
        item.value = (appSettingsCatalogCache && appSettingsCatalogCache[0] && appSettingsCatalogCache[0].id) || '';
      }
      // Setting segments wear the app's own icon — unless the user already chose art.
      if (!item.icon && !item.iconImage) item.iconImage = APP_ICON_IMAGE_KEY;
    } else if (oldType === 'sys' || oldType === 'setting') {
      item.value = '';
      item.dir = '';                                 // the folder slot is sys-only
    } else if (oldType === 'app') {
      item.args = '';                                // the arguments slot is app-only
    }
    touch();                                     // rebuilds the editor for the new type
    document.querySelector(`[data-seg-key="${key}"] .seg-edit select`)?.focus();   // keep the keyboard in the editor
  });

  if (item.type === 'folder') {
    const cKids = field('Sub-menu');
    cKids.classList.add('kid-ctl');
    folderManager(ctx, cKids);
  } else if (item.type === 'recent') {
    const cAuto = field('Contents');
    el('div', 'f-hint', {
      text: 'Fills itself at every wheel opening with your most-recently-used segments — the count is set in Hotkey & Behavior. Nothing to edit here; clicks inside the fan run the real segments.'
    }, cAuto);
  } else if (item.type === 'mixer') {
    const cMix = field('Contents');
    el('div', 'f-hint', {
      text: 'Clicking this segment pops a volume flyout beside the wheel — the default output and input device pickers, master output, microphone, and a slider for every app that is playing audio. Picking a device switches it system-wide, exactly like this tab\u2019s dropdowns. Nothing is launched and nothing to configure; Esc closes an open device list first, then the card, and it reads live levels, sessions, and endpoints fresh at every opening.'
    }, cMix);
  } else if (item.type === 'sys') {
    const cTarget = field(TARGET_LABELS.sys, uid + '-target');
    sysActionCombo(item, cTarget, `${uid}-list`, syncRowText);
    if ((sysEntry(item.value) || {}).hasDir) {
      const cDir = field('Folder', uid + '-dir');
      const inD = bind(el('input', null, {
        type: 'text', value: item.dir || '', id: uid + '-dir',
        placeholder: 'e.g. C:\\Users\\you\\Downloads — empty opens Quick access',
        spellcheck: 'false'
      }), (e) => item.dir = e.value);
      cDir.appendChild(inD);
      const bd = el('button', 'btn small', { text: 'Browse…' }, cDir);
      bd.onclick = async (ev) => {
        ev.stopPropagation();
        const p = await api.pickFile({ title: 'Choose a folder', directory: true });
        if (p) { item.dir = p; syncRowText(); touch(); }
      };
      hint({
        text: 'The folder File Explorer opens in — paths with spaces, %VARIABLES%, ~/Name, or a shell: verb. Empty opens the default view.'
      });
    }
    /* hasDevice (set_output_device / set_input_device): the same `dir` field,
       filled from the live endpoint list instead of free text. A bound id
       that's no longer present (unplugged device) keeps a visible orphan row
       so the segment never silently points at nothing. */
    const devEnt = sysEntry(item.value) || {};
    if (devEnt.hasDevice) {
      const flow = devEnt.hasDevice === 'capture' ? 'capture' : 'render';
      const cDev = field('Audio device', uid + '-dev');
      const selDev = el('select', null, { id: uid + '-dev', 'aria-label': 'Audio device this segment switches to' }, cDev);
      const fillDev = (devices) => {
        selDev.innerHTML = '';
        el('option', null, { text: '(pick a device…)', value: '' }, selDev);
        const orphan = item.dir && !devices.some((d) => d.id === item.dir);
        if (orphan) el('option', null, { text: '(unplugged — re-pick) ' + audioDeviceLabel(item.dir), value: item.dir }, selDev);
        devices.forEach((d) => el('option', null, { text: d.name + (d.isDefault ? '  ·  system default' : ''), value: d.id }, selDev));
        selDev.value = item.dir || '';
      };
      fillDev(audioDeviceCache[flow] || []);
      if (!audioDeviceCache[flow]) loadAudioDevices(flow).then((ds) => { if (selDev.isConnected) fillDev(ds); });
      const devRg = el('button', 'btn small', { title: 'Reload the device list', 'aria-label': 'Reload the device list' }, cDev);
      el('span', 'g', { text: '\uE72C' }, devRg);   // Refresh
      devRg.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const ds = await loadAudioDevices(flow, true);
        if (selDev.isConnected) fillDev(ds);
      });
      selDev.addEventListener('change', () => { item.dir = selDev.value; syncRowText(); touch(false); });
      hint({
        text: devEnt.hasDevice === 'capture'
          ? 'Firing this segment makes that microphone the system default input — the same choice Windows sound settings offers.'
          : 'Firing this segment makes that speaker or headphone the system default output — the same choice Windows sound settings offers.'
      });
    }
  } else if (item.type === 'setting') {
    const cTarget = field(TARGET_LABELS.setting, uid + '-target');
    settingActionCombo(item, cTarget, `${uid}-list`, syncRowText);
    hint({
      text: 'Firing this segment flips that switch on the spot — the same as changing it under Hotkey & Behavior. The segment wears the app icon.'
    });
  } else {
    const cTarget = field(TARGET_LABELS[item.type] || 'Target', uid + '-target');
    const inV = bind(el('input', null, { type: 'text', value: item.value, placeholder: valueHint(item.type), id: uid + '-target' }), (e) => item.value = e.value);
    cTarget.appendChild(inV);
    const browseOpts = BROWSE_OPTS[item.type];
    if (browseOpts) {
      const b = el('button', 'btn small', { text: 'Browse…' }, cTarget);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const p = await api.pickFile(browseOpts);
        if (p) { item.value = p; touch(); }
      };
    }
    if (item.type === 'app') {
      const cArgs = field('Arguments', uid + '-args');
      const inA = bind(el('input', null, {
        type: 'text', value: item.args || '', maxlength: '2048',
        placeholder: valueHint('args'), id: uid + '-args',
        'aria-label': 'Launch parameters passed to the program'
      }), (e) => item.args = e.value);
      cArgs.appendChild(inA);
      hint({ text: 'Passed to the program when it starts — quote parameters that contain spaces.' });
    }
    if (item.type === 'command') {
      // Say what the box takes — cmd.exe syntax vs. a picked script file.
      hint({
        html: 'Type it exactly as in <b>Command Prompt</b>, or use Browse… to pick a <code>.bat</code> / <code>.cmd</code> / <code>.ps1</code> file — the chosen path runs like a double-click.'
      });
    }
    if (item.type === 'app') appCombo(item, inV, f);
    // The macro DSL ('ctrl+c, wait=0.2, hold=f15=1.5') was the one wall between
    // a non-tech person and this tab — the helper builds correct steps; the
    // raw Keys box stays fully editable for power users.
    if (item.type === 'macro') macroBuilder(item, f, inV, syncRowText);
  }

  const cIcon = field('Icon');
  const iconPrev = el('span', 'seg-ico' + (item.icon || item.iconImage ? '' : ' none'), {}, cIcon);
  registerIconSpan(iconPrev, item, item.icon || '—');
  const pick = el('button', 'btn small', { text: 'Choose…' }, cIcon);
  pick.onclick = () => openIconModal(item, pick);
  const clr = el('button', 'btn small glyph', { text: '\uE894', title: 'Clear icon', 'aria-label': 'Clear icon' }, cIcon);
  // Clears BOTH slots — with the setting type auto-assigning the app image,
  // a glyph-only clear would leave the segment looking un-clearable.
  clr.onclick = () => { item.icon = ''; item.iconImage = ''; renderSegments(); touch(); };

  const cColor = field('Color');
  const chkAuto = el('input', null, { type: 'checkbox' }, cColor);
  chkAuto.checked = !item.color;
  el('span', 'muted ctl-note', { text: 'auto' }, cColor);
  const colIn = el('input', null, { type: 'color', value: item.color || cfg.appearance.colors[Number(ring) % 2 === 1 ? 'ring1' : 'ring2'] }, cColor);
  chkAuto.addEventListener('change', () => { item.color = chkAuto.checked ? null : colIn.value; touch(false); });
  colIn.addEventListener('input', () => { if (!chkAuto.checked) { item.color = colIn.value; touch(false); } });

  if (depth === 0) {
  const cRing = field('Ring');
  const ringBox = el('div', 'ring-pick', {}, cRing);
  const allKeys = ringKeys();
  for (const r of allKeys) {
    const lb = el('label', 'chk', {}, ringBox);
    const rb = el('input', null, { type: 'radio', name: 'ringpick-' + item.id }, lb);
    rb.checked = String(ring) === r;
    rb.addEventListener('change', () => {
      if (rb.checked && String(ring) !== r) {
        const RM = ringsModel();           // re-resolved at click time — profile may have changed
        if (RM[r].length >= 24) {   // config.js cleanRing cap
          const cur = ringBox.querySelector(`input[value="${ring}"]`);
          if (cur) cur.checked = true;
          toast(`Ring ${r} holds at most 24 segments`, true);
          return;
        }
        const from = RM[ring];
        const idx = from.indexOf(item);
        from.splice(idx, 1);
        RM[r].push(item);
        openEditorKey = null;
        touch();
        // Inverse-op undo — returns the item to its old ring and position;
        // later edits made after the move survive.
        const t = ringRadioLabel(r, allKeys);
        const dest = (t === 'inner' || t === 'outer') ? `the ${t} ring` : t;
        toast(`Moved “${item.label || '(no name)'}” to ${dest}`, false, () => {
          const R2 = ringsModel();
          const cur = R2[r];
          const k = cur.indexOf(item);
          if (k < 0) return;                        // moved on — inverse op is a no-op
          cur.splice(k, 1);
          const back = R2[ring] || (R2[ring] = []);
          back.splice(Math.min(idx, back.length), 0, item);
          touch();
        });
      }
    });
    rb.value = r;
    lb.appendChild(document.createTextNode(ringRadioLabel(r, allKeys)));
  }
  makeDupButton(ringBox, ringsModel()[ring], 24, item, 'A ring holds at most 24 segments');
  } else {
    // Duplicate is the only child-level placement control (the ring radios are
    // root-only); no label needed — the button names itself.
    const cPlace = field(null);
    const box = el('div', 'ring-pick', {}, cPlace);
    makeDupButton(box, owner, MAX_CHILDREN, item, `A sub-menu holds at most ${MAX_CHILDREN} segments`);
  }
  return f;
}

/* --------------------------- macro step helper -----------------------------
   Guided builder for the `macro` Keys box. The wire format is main/macro.js's
   grammar (see the step-grammar block there); this UI only ever EMITS valid
   steps — the same bounds main enforces at execution (wait ≤ 5 s, scroll ≤ 25
   notches, repeat ≤ 20, spec ≤ 2048 chars, ≤ 128 steps) are enforced here so
   the user learns about a mistake at build time, not fire time. The raw Keys
   box remains the single source of truth: chips render it, add/delete write
   it, and free typing in it is never blocked. */
const MACRO_MAX_SPEC = 2048, MACRO_MAX_STEPS = 128, MACRO_MAX_REPEAT = 20, MACRO_MAX_SCROLL = 25;

const MACRO_STEP_KINDS = [
  ['keys',   'Press keys (Ctrl+C, F1…)'],
  ['click',  'Mouse click'],
  ['wait',   'Pause'],
  ['scroll', 'Scroll the wheel'],
  ['hold',   'Hold a key down'],
  ['type',   'Type text'],
  ['repeat', 'Repeat a step']
];
const MACRO_CLICK_STEPS = [
  ['click', 'Left click'], ['rclick', 'Right click'], ['mclick', 'Middle click'],
  ['dblclick', 'Double click'], ['back', 'Browser back'], ['forward', 'Browser forward']
];

/* Top-level comma split. `type:` consumes the rest of the spec (must be last),
   so once one is found everything after it belongs to that step. */
function splitMacroSteps(spec) {
  const raw = String(spec || '').trim();
  if (!raw) return [];
  const parts = raw.split(',');
  for (let i = 0; i < parts.length; i++) {
    if (/^\s*type:/i.test(parts[i])) {
      const tail = parts.slice(i).join(',');
      return i ? parts.slice(0, i).concat(tail) : [tail];
    }
  }
  return parts;
}

const RESERVED_STEP = /^(?:wait|hold|repeat|scroll|wheel)\s*[=:]|^type\s*:/i;
const looksTyped = (s) => /^\s*type\s*:/i.test(s);

function macroBuilder(item, f, inV, syncRowText) {
  el('label', 'f-label', { text: 'Steps' }, f);
  const ctl = el('div', 'f-ctl macro-steps', {}, f);
  const list = el('div', 'ms-list', {}, ctl);
  const builder = el('div', 'ms-builder', {}, ctl);

  const commit = (steps) => {
    item.value = steps.join(', ');
    inV.value = item.value;
    syncRowText();
    touch(false);
    renderChips();
  };
  const renderChips = () => {
    const steps = splitMacroSteps(item.value);
    list.innerHTML = '';
    if (!steps.length) {
      el('div', 'ms-empty', { text: 'Nothing yet — pick a step below and press Add. Steps run top to bottom.' }, list);
    }
    steps.forEach((s, i) => {
      const chip = el('span', 'ms-chip', {}, list);
      el('span', 'ms-n', { text: String(i + 1) }, chip);
      el('span', 'ms-t', { text: s.trim() || '(empty)' }, chip);
      const x = el('button', 'ms-x', { type: 'button', text: '×', title: 'Remove this step', 'aria-label': `Remove step ${i + 1}` }, chip);
      x.onclick = (e) => { e.stopPropagation(); const a = splitMacroSteps(item.value); a.splice(i, 1); commit(a); };
    });
  };

  const kindSel = el('select', null, { 'aria-label': 'Step type' }, builder);
  for (const [v, t] of MACRO_STEP_KINDS) el('option', null, { value: v, text: t }, kindSel);
  const params = el('span', 'ms-params', {}, builder);
  const addBtn = el('button', 'btn small', { type: 'button', text: 'Add' }, builder);
  addBtn.onclick = () => { /* replaced per step kind by buildParams */ };

  // One fresh set of parameter controls per step kind — cheap to rebuild, and
  // it keeps every kind's validation local to its own maker.
  const num = (v, min, max, step = 'any') => el('input', null, { type: 'number', value: String(v), min: String(min), max: String(max), step, 'aria-label': 'Amount' });
  const txt = (ph, aria) => el('input', null, { type: 'text', placeholder: ph, 'aria-label': aria, spellcheck: 'false' });

  const addStep = (step) => {
    const steps = splitMacroSteps(item.value);
    if (steps.length >= MACRO_MAX_STEPS) { toast(`A macro holds at most ${MACRO_MAX_STEPS} steps`, true); return; }
    if (steps.length && looksTyped(steps[steps.length - 1])) {
      toast('Typed text swallows everything after it — remove the “Type text” step first', true);
      return;
    }
    if (looksTyped(step) && steps.some(looksTyped)) {
      toast('A macro can only type text once — it must be the last step', true);
      return;
    }
    const next = steps.concat(step).join(', ');
    if (next.length > MACRO_MAX_SPEC) { toast('This macro is getting too long — shorten a step or start a new one', true); return; }
    commit(steps.concat(step));
  };

  const buildParams = () => {
    params.innerHTML = '';
    const kind = kindSel.value;
    const focusFirst = () => { const inp = params.querySelector('input, select'); if (inp) inp.focus(); };
    if (kind === 'keys') {
      const inK = txt('ctrl+shift+t', 'Keys pressed together');
      params.appendChild(inK);
      addBtn.onclick = () => {
        const v = inK.value.trim();
        if (!v) { toast('Type the keys first — for example ctrl+shift+t', true); return; }
        if (v.includes(',') || v.includes('=') || RESERVED_STEP.test(v)) { toast('That mixes in another step type — press one key combo, or pick the right step below', true); return; }
        addStep(v); focusFirst();
      };
    } else if (kind === 'click') {
      const sel = el('select', null, { 'aria-label': 'Click type' }, params);
      for (const [v, t] of MACRO_CLICK_STEPS) el('option', null, { value: v, text: t }, sel);
      addBtn.onclick = () => addStep(sel.value);
    } else if (kind === 'wait') {
      const n = num(0.5, 0, 5, 0.1); params.appendChild(n);
      el('span', 'ms-unit', { text: 'sec' }, params);
      addBtn.onclick = () => {
        const v = parseFloat(n.value);
        if (!Number.isFinite(v) || v < 0) { toast('Enter a pause in seconds — e.g. 0.5', true); return; }
        addStep('wait=' + Math.min(5, Math.round(v * 100) / 100)); focusFirst();
      };
    } else if (kind === 'scroll') {
      const n = num(3, -MACRO_MAX_SCROLL, MACRO_MAX_SCROLL, 1); params.appendChild(n);
      el('span', 'ms-unit', { text: 'clicks down (negative = up)' }, params);
      addBtn.onclick = () => {
        const v = Math.round(parseFloat(n.value));
        if (!Number.isFinite(v) || v === 0) { toast('Enter how far to scroll — e.g. 3, or -2 for up', true); return; }
        if (Math.abs(v) > MACRO_MAX_SCROLL) { toast(`Scroll is capped at ${MACRO_MAX_SCROLL} clicks`, true); return; }
        addStep('scroll=' + v); focusFirst();
      };
    } else if (kind === 'hold') {
      const inK = txt('f15', 'Keys to hold'); params.appendChild(inK);
      const n = num(1.5, 0.05, 5, 0.05); params.appendChild(n);
      el('span', 'ms-unit', { text: 'sec' }, params);
      addBtn.onclick = () => {
        const v = inK.value.trim();
        const s = parseFloat(n.value);
        if (!v || v.includes(',') || v.includes('=') || RESERVED_STEP.test(v)) { toast('Enter the key or combo to hold — e.g. f15 or ctrl+c', true); return; }
        if (!Number.isFinite(s) || s <= 0) { toast('Enter how long to hold, in seconds — e.g. 1.5', true); return; }
        addStep(`hold=${v}=${Math.min(5, Math.round(s * 100) / 100)}`); focusFirst();
      };
    } else if (kind === 'type') {
      const inT = txt('hello world', 'Text to type'); params.appendChild(inT);
      addBtn.onclick = () => {
        const v = inT.value;
        if (!v) { toast('Type the text first', true); return; }
        addStep('type:' + v);
      };
    } else if (kind === 'repeat') {
      const n = num(3, 1, MACRO_MAX_REPEAT, 1); params.appendChild(n);
      el('span', 'ms-unit', { text: '×' }, params);
      const inS = txt('ctrl+v', 'Step to repeat'); params.appendChild(inS);
      addBtn.onclick = () => {
        const c = Math.round(parseFloat(n.value));
        const s = inS.value.trim();
        if (!Number.isFinite(c) || c < 1) { toast('How many times? — e.g. 3', true); return; }
        if (c > MACRO_MAX_REPEAT) { toast(`A step can repeat at most ${MACRO_MAX_REPEAT} times`, true); return; }
        if (!s) { toast('Enter the step to repeat — e.g. ctrl+v', true); return; }
        if (/^(?:wait\s*=|repeat\s*[=:]|type\s*:)/i.test(s)) { toast('Pauses, typed text and repeats can’t themselves be repeated', true); return; }
        addStep(`repeat=${c}:${s}`); focusFirst();
      };
    }
  };
  kindSel.addEventListener('change', () => { buildParams(); });
  buildParams();
  renderChips();

  el('div', 'f-hint', {
    text: 'Mouse steps click wherever the cursor ends up once the wheel closes — usually the spot the wheel covered. The Keys box stays editable for anything the helper doesn’t cover.'
  }, f);
}

/* One Duplicate button for both placement levels. Cap + toast text vary
   (24-per-ring vs 12-per-sub-menu); the copy always gets fresh ids so the
   overlay's live-config id match (ipc.js) stays unambiguous. */
function makeDupButton(host, ownerArr, cap, item, capMsg) {
  const dup = el('button', 'btn small', { type: 'button', text: 'Duplicate', title: 'Copy this segment into the next position' }, host);
  dup.onclick = (e) => {
    e.stopPropagation();
    if (ownerArr.length >= cap) { toast(capMsg, true); return; }
    const copy = renewIds(item);
    ownerArr.splice(ownerArr.indexOf(item) + 1, 0, copy);
    openEditorKey = null;
    touch();
    toast(`Duplicated “${item.label || '(no name)'}”`, false, () => {
      const k = ownerArr.findIndex((x) => x.id === copy.id);
      if (k >= 0) { ownerArr.splice(k, 1); touch(); }
    });
  };
  return dup;
}

/* Sub-menu list inside a folder's editor. Child rows reuse the ordinary
   segment row component — editors, reorder, delete-and-undo, icon picker and
   all — addressed by path keys (parent key + "/index"), so the nesting UI is
   literally the same UI at every level. */
function folderManager(ctx, host) {
  const item = ctx.item;
  if (!Array.isArray(item.children)) item.children = [];
  const kids = item.children;
  const d = ctx.depth || 0;
  const canNest = d + 1 < MAX_FOLDER_DEPTH;
  const addKid = (type) => {
    if (kids.length >= MAX_CHILDREN) { toast(`A sub-menu holds at most ${MAX_CHILDREN} segments`, true); return; }
    kids.push(newSegItem(type));
    openEditorKey = `${ctx.key}/${kids.length - 1}`;
    touch();
    // land the caret in the new row's Label box, pre-selected like ring rows do
    const lbl = document.querySelector(`[data-seg-key="${openEditorKey}"] .seg-edit input`);
    if (lbl) { lbl.focus(); lbl.select(); }
  };
  const addButtons = (where) => {
    const b = el('button', 'btn small', { type: 'button', text: '+ Add segment', title: 'Add an action inside this sub-menu' }, where);
    b.onclick = (e) => { e.stopPropagation(); addKid('app'); };
    if (canNest) {
      const s = el('button', 'btn small', { type: 'button', text: '+ Add sub-folder', title: 'Add a folder that branches further outward' }, where);
      s.onclick = (e) => { e.stopPropagation(); addKid('folder'); };
    }
  };
  if (!kids.length) {
    // One dashed empty state — explains what belongs here and offers the action.
    const box = el('div', 'empty-hint kid-empty', {}, host);
    el('div', null, { text: 'No segments yet — actions added here branch outward when the pointer rests on this folder.' }, box);
    addButtons(el('div', 'row-line kid-add', {}, box));
    return;
  }
  el('div', 'f-hint', {
    text: canNest
      ? `Branches outward when the pointer rests on this folder — up to ${MAX_CHILDREN} segments.`
      : `Deepest folder level — its segments branch out as actions.`
  }, host);
  const listBox = el('div', 'kid-list', {}, host);
  kids.forEach((kid, j) => listBox.appendChild(segRow({ owner: kids, item: kid, i: j, key: `${ctx.key}/${j}`, depth: d + 1 })));
  addButtons(el('div', 'row-line kid-add', {}, host));
}

/* ------------------------------ profiles bar -------------------------------
   The Segments tab edits the DEFAULT wheel or one APP PROFILE at a time —
   picking a chip retargets the entire ring editor + live preview (ringsModel),
   so profile authoring reuses the segment UI exactly instead of cloning it. */
function renderProfileBar() {
  const bar = $('#profile-bar');
  if (!bar) return;
  bar.innerHTML = '';
  if (!Array.isArray(cfg.profiles)) cfg.profiles = [];
  const list = cfg.profiles;
  const p = activeProfile();                       // self-heals a vanished selection
  const card = el('div', 'card profile-card', {}, bar);
  const row = el('div', 'row-line wrap', {}, card);
  el('span', 'card-title', { text: 'Editing' }, row);
  const chip = (label, on, onclick, title) => {
    const b = el('button', 'btn small' + (on ? ' primary' : ''), { text: label, type: 'button', title: title || '' }, row);
    b.setAttribute('aria-pressed', String(on));
    b.onclick = onclick;
    return b;
  };
  chip('Default wheel', !p, () => {
    if (p) { activeProfileId = null; renderProfileBar(); renderSegments(); renderPreview(); }
  }, 'The wheel every app gets');
  for (const pr of list) {
    chip(pr.name || 'Profile', p === pr, () => {
      if (p !== pr) { activeProfileId = pr.id; renderProfileBar(); renderSegments(); renderPreview(); }
    }, (pr.apps && pr.apps.length) ? 'Apps: ' + pr.apps.join(', ') : 'No apps listed — this profile never activates');
  }
  if (list.length < MAX_PROFILES) {
    const add = el('button', 'btn small', { text: '+ Profile', type: 'button', title: 'Add an app profile' }, row);
    add.onclick = () => {
      const np = { id: crypto.randomUUID(), name: 'Profile ' + (list.length + 1), apps: [], rings: { 1: [], 2: [] } };
      list.push(np);
      activeProfileId = np.id;
      touch();                       // persists + rerenders; the new profile starts empty (shows nothing until filled)
      renderProfileBar();
    };
  } else {
    el('span', 'muted', { text: `Profile limit (${MAX_PROFILES}).` }, row);
  }

  if (p) {
    const grid = el('div', 'row-line wrap', {}, card);
    grid.style.marginTop = '8px';
    const nameIn = el('input', null, { type: 'text', maxlength: '40', value: p.name || '', 'aria-label': 'Profile name', style: 'width:190px' }, grid);
    nameIn.oninput = () => { p.name = nameIn.value; touch(false); };
    nameIn.onchange = () => renderProfileBar();     // chip label follows the committed text
    el('label', 'hint muted', { text: 'Activate when these apps have focus:' }, grid);
    const appsIn = el('input', null, {
      type: 'text', maxlength: '500', value: (p.apps || []).join(', '),
      placeholder: 'e.g. code.exe, blender.exe',
      'aria-label': 'Apps that activate this profile, comma-separated',
      style: 'flex:1;min-width:220px'
    }, grid);
    appsIn.onchange = () => {
      p.apps = parseAppList(appsIn.value);
      appsIn.value = p.apps.join(', ');             // reflect normalization, like the gaming-mode list
      touch(false);
    };
    const del = el('button', 'btn small danger', { text: 'Delete profile', type: 'button' }, grid);
    let armed = false, armTimer = null;
    del.onclick = () => {
      if (!armed) {
        armed = true;
        del.textContent = 'Click again to delete';
        clearTimeout(armTimer);
        armTimer = setTimeout(() => { if (del.isConnected) { armed = false; del.textContent = 'Delete profile'; } }, 3000);
        return;
      }
      const idx = list.indexOf(p);
      list.splice(idx, 1);
      activeProfileId = null;
      touch();
      renderProfileBar();
      toast(`Deleted profile “${p.name || 'Profile'}”`, false, () => {
        list.splice(Math.min(idx, list.length), 0, p);
        activeProfileId = p.id;
        touch();
        renderProfileBar();
      });
    };
    if (!(p.apps || []).length) {
      el('div', 'hint muted', { text: 'No apps listed — this profile can never activate. Comma-separated exe names; full paths are fine.' }, card);
    }
  }

  // Falling-back hint: an active profile with nothing in it shows the default wheel instead.
  if (p && !Object.values(p.rings || {}).some((a) => Array.isArray(a) && a.length)) {
    el('div', 'hint muted', { text: 'This wheel is empty — until it has segments, the app it matches keeps showing the DEFAULT wheel.' }, card);
  }
  if (!cfg.behavior || !cfg.behavior.profilesEnabled) {
    el('div', 'hint muted', { text: 'Profiles are OFF — turn on “Use a different wheel per app” under Hotkey & Behavior to activate them.' }, card);
  }
}

/* ---------------- installed-programs dropdown (type: app) ----------------- */
let appsCache = null;   // { loading, items }

/* Popup sizing shared by both searchable combos. The list lives inside the
   .seg-edit card, which the .seg-list's overflow:clip cuts off — a tall fixed
   popup "dropped down" past the card edge and was clipped mid-row. Instead:
   cap the view at COMBO_VISIBLE_ROWS option rows (the rest scroll) and flip
   the popup above the input when the card has no room left below it.
   Must be called while the list is displayed, after its rows are final. */
const COMBO_VISIBLE_ROWS = 5;

function fitComboList(list) {
  list.style.maxHeight = '';                       // re-measure from natural layout
  list.classList.remove('flip-up');
  if (!list.getClientRects().length) return;       // hidden — the CSS fallback covers it
  const rows = list.querySelectorAll('.combo-row');
  if (rows.length <= COMBO_VISIBLE_ROWS) return;
  const listTop = list.getBoundingClientRect().top;
  const lastEdge = rows[COMBO_VISIBLE_ROWS - 1].getBoundingClientRect().bottom;
  // Keep the "N of M" foot visible under the cap: it is the popup's caption,
  // not a row — 5 is the number of *options* that peek through the window.
  const foot = list.querySelector('.combo-foot');
  const footH = foot ? foot.offsetHeight + parseFloat(getComputedStyle(foot).marginTop || '0') : 0;
  list.style.maxHeight = Math.ceil(lastEdge - listTop + footH + 5) + 'px';   // + padding-bottom/border
  // Flip if the capped popup would run past the clipping card or the window.
  const card = list.closest('.seg-list') || document.body;
  const room = Math.min(card.getBoundingClientRect().bottom, window.innerHeight);
  if (list.getBoundingClientRect().bottom > room - 4) list.classList.add('flip-up');
}

function appCombo(item, inV, f) {
  const host = el('div', 'f-full', {}, f);
  const row = el('div', 'row-line', {}, host);
  el('span', 'muted ctl-note', { text: 'Installed programs' }, row);
  const search = el('input', null, { type: 'text', placeholder: 'Start typing to search…  (▾ opens the full list)', 'aria-label': 'Search installed programs', role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': `list-${item.id}` }, row);
  const ddBtn = el('button', 'btn small', { title: 'Show all installed programs', 'aria-label': 'Show all installed programs' }, row);
  el('span', 'g', { text: '\uE70D' }, ddBtn);   // ChevronDown
  const scanBtn = el('button', 'btn small', { title: 'Re-scan the installed programs list', 'aria-label': 'Re-scan the installed programs list' }, row);
  el('span', 'g', { text: '\uE72C' }, scanBtn); // Refresh
  const list = el('div', 'combo-list hidden', { id: `list-${item.id}`, role: 'listbox', 'aria-label': 'Installed programs' }, host);

  let rows = [];
  let active = -1;

  function renderList() {
    const q = search.value.trim().toLowerCase();
    list.innerHTML = ''; rows = []; active = -1;
    search.removeAttribute('aria-activedescendant');
    if (appsCache && appsCache.loading) { el('div', 'combo-empty muted', { text: 'Scanning installed programs…', role: 'presentation' }, list); fitComboList(list); return; }
    const all = (appsCache && appsCache.items) || [];
    const shown = (q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q)) : all).slice(0, 120);
    if (!shown.length) { el('div', 'combo-empty muted', { text: q ? 'No installed program matches “' + q + '” — keep typing, or Browse… for an exact path.' : 'No installed programs found.' }, list); fitComboList(list); return; }
    shown.forEach((a, idx) => {
      const r = el('div', 'combo-row', { role: 'option', 'aria-selected': 'false', id: `opt-${item.id}-${idx}` }, list);
      el('span', 'cr-name', { text: a.name }, r);
      el('span', 'cr-cat', { text: a.category }, r);
      el('span', 'cr-path', { text: a.path }, r);
      r.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(a); });
      rows.push(r);
    });
    el('div', 'combo-foot muted', { text: `${shown.length} of ${all.length} — click to fill “Target”` }, list);
    fitComboList(list);
  }

  function pick(a) {
    item.value = a.path; inV.value = a.path;
    list.classList.add('hidden');
    touch(false);
    toast(`Target set to ${a.name}`);
  }
  function showList() { clearTimeout(listHideTimer); list.classList.remove('hidden'); ensureLoaded(); renderList(); }
  async function ensureLoaded(force) {
    if (appsCache && !force) return;
    appsCache = { loading: true, items: [] };
    renderList();
    const items = await api.installedApps(!!force);
    appsCache = { loading: false, items };
    renderList();
  }

  let listHideTimer = null;   // cancellable — a quick refocus must not lose the open list
  search.addEventListener('focus', () => { clearTimeout(listHideTimer); ensureLoaded(); list.classList.remove('hidden'); renderList(); });
  search.addEventListener('input', () => { clearTimeout(listHideTimer); list.classList.remove('hidden'); renderList(); });
  search.addEventListener('blur', () => { clearTimeout(listHideTimer); listHideTimer = setTimeout(() => list.classList.add('hidden'), 180); });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault(); showList();
      if (!rows.length) return;
      active = ev.key === 'ArrowDown' ? (active + 1) % rows.length : (active - 1 + rows.length) % rows.length;
      rows.forEach((r, i) => { r.classList.toggle('active', i === active); r.setAttribute('aria-selected', String(i === active)); });
      rows[active].scrollIntoView({ block: 'nearest' });
      search.setAttribute('aria-activedescendant', rows[active].id);
    } else if (ev.key === 'Enter') {
      if (active >= 0 && rows[active]) { ev.preventDefault(); rows[active].dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }
    } else if (ev.key === 'Escape') { list.classList.add('hidden'); }
  });
  ddBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); if (list.classList.contains('hidden')) showList(); else list.classList.add('hidden'); search.focus(); });
  scanBtn.addEventListener('mousedown', (ev) => { ev.preventDefault(); ensureLoaded(true); showList(); search.focus(); });
}

/* ---------------- catalog searchable dropdowns (sys / setting) ------------
    Same shape as appCombo: search input + ▾ button + .combo-list popup. The
    catalogs are small and fully in-memory, so there is no scan/cache — the
    list renders instantly, grouped with headers and each entry's own glyph.
    The input is a display field, not free text: blur always restores it to
    the selected entry, and only a pick from the list writes item.value.
    catalogCombo is shared; the two wrappers differ only in data source,
    wording, and onPick side effects (sys's Folder field). */
function catalogCombo(item, cTarget, listId, syncRowText, o) {
  const host = el('div', 'combo-host', {}, cTarget);
  const search = el('input', null, {
    type: 'text', placeholder: o.placeholder,
    'aria-label': o.aria, role: 'combobox', 'aria-autocomplete': 'list',
    'aria-controls': listId, autocomplete: 'off', spellcheck: 'false'
  }, host);
  search.value = o.text(o.entry(item.value));
  const ddBtn = el('button', 'btn small', { type: 'button', title: o.title, 'aria-label': o.title }, host);
  el('span', 'g', { text: '\uE70D' }, ddBtn);   // ChevronDown
  const list = el('div', 'combo-list hidden', { id: listId, role: 'listbox', 'aria-label': o.aria }, host);

  let rows = [];
  let active = -1;
  let hideTimer = null;

  function match(c, q) {
    const hay = `${c.label} ${c.group} ${c.id}`.toLowerCase();
    if (hay.includes(q)) return true;
    // "volumemixer" finds "Volume Mixer" — space-insensitive like the ALIAS map in main.
    return hay.replace(/\s+/g, '').includes(q.replace(/\s+/g, ''));
  }

  function renderList(useQuery) {
    const q = useQuery ? search.value.trim().toLowerCase() : '';
    list.innerHTML = ''; rows = []; active = -1;
    search.removeAttribute('aria-activedescendant');
    const all = o.entries();
    const shown = q ? all.filter((c) => match(c, q)) : all;
    if (!shown.length) {
      el('div', 'combo-empty muted', { text: `No ${o.noun} matches “${search.value.trim()}”` }, list);
      fitComboList(list);
      return;
    }
    let lastGroup = null;
    shown.forEach((c, idx) => {
      if (c.group !== lastGroup) {
        lastGroup = c.group;
        el('div', 'combo-grp', { text: c.group, role: 'presentation' }, list);
      }
      const r = el('div', 'combo-row combo-sys', { role: 'option', 'aria-selected': 'false', id: `${listId}-opt-${idx}` }, list);
      el('span', 'g cs-ico', { text: c.icon || o.iconDefault }, r);
      el('span', 'cr-name', { text: c.label }, r);
      if (c.id === item.value) r.classList.add('selected');
      r.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(c); });
      rows.push(r);
    });
    el('div', 'combo-foot muted', { text: `${shown.length} of ${all.length} — click or Enter to select` }, list);
    fitComboList(list);
  }

  function pick(c) {
    const needsRerender = o.onPick(c, item) === true;
    search.value = o.text(o.entry(item.value));
    list.classList.add('hidden');
    syncRowText();
    // A side field appearing/vanishing (the sys Folder box) needs the editor
    // rebuilt (touch()); otherwise save without a rerender.
    if (needsRerender) touch(); else touch(false);
  }

  function setActive(i) {
    active = i;
    rows.forEach((r, k) => { r.classList.toggle('active', k === active); r.setAttribute('aria-selected', String(k === active)); });
    if (rows[active]) {
      rows[active].scrollIntoView({ block: 'nearest' });
      search.setAttribute('aria-activedescendant', rows[active].id);
    }
  }
  function activateByValue() {                          // reopen with the selection highlighted
    const i = rows.findIndex((r) => r.classList.contains('selected'));
    setActive(i >= 0 ? i : -1);
  }

  search.addEventListener('focus', () => { clearTimeout(hideTimer); list.classList.remove('hidden'); renderList(false); activateByValue(); });
  search.addEventListener('input', () => { clearTimeout(hideTimer); list.classList.remove('hidden'); renderList(true); setActive(rows.length === 1 ? 0 : -1); });
  search.addEventListener('blur', () => {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      list.classList.add('hidden');
      search.value = o.text(o.entry(item.value));        // a typed query is never the value
    }, 180);
  });
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (list.classList.contains('hidden')) { clearTimeout(hideTimer); list.classList.remove('hidden'); renderList(false); activateByValue(); }
      if (!rows.length) return;
      const dir = ev.key === 'ArrowDown' ? 1 : -1;
      setActive((active + dir + rows.length) % rows.length);
    } else if (ev.key === 'Enter') {
      // Enter commits the highlighted row, or the sole match of a filter —
      // it never accepts free text.
      const hit = active >= 0 ? rows[active] : (rows.length === 1 ? rows[0] : null);
      if (hit) { ev.preventDefault(); hit.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })); }
    } else if (ev.key === 'Escape') {
      if (!list.classList.contains('hidden')) {
        ev.stopPropagation();                            // close the dropdown, not the editor
        list.classList.add('hidden');
        search.value = o.text(o.entry(item.value));
      }
    }
  });
  ddBtn.addEventListener('mousedown', (ev) => {
    ev.preventDefault();
    if (list.classList.contains('hidden')) { list.classList.remove('hidden'); renderList(false); activateByValue(); }
    else list.classList.add('hidden');
    search.focus();
  });
}

function sysComboText(c) {
  return c ? `${c.label}  ·  ${c.group}` : '';
}

function sysActionCombo(item, cTarget, listId, syncRowText) {
  // The `dir` field serves two namespaces: explorer's folder and the audio
  // actions' endpoint id. Both are owned by the chosen action alone — a swap
  // between (or out of) them must wipe the field, never carry junk across.
  const ownsDir = (id) => { const c = sysEntry(id) || {}; return !!(c.hasDir || c.hasDevice); };
  catalogCombo(item, cTarget, listId, syncRowText, {
    entries: () => sysCatalogCache || [],
    text: sysComboText,
    entry: (id) => sysEntry(id),
    placeholder: 'Search actions…  (▾ opens the full list)',
    aria: 'Windows actions',
    title: 'Show all actions',
    noun: 'action',
    iconDefault: '\uE713',
    onPick: (c, it) => {
      const prev = sysEntry(it.value) || {};
      it.value = c.id;
      const next = sysEntry(c.id) || {};
      const was = !!(prev.hasDir || prev.hasDevice);
      const is = !!(next.hasDir || next.hasDevice);
      if (!is) it.dir = '';                                   // the slot belongs to no one
      else if (was && (prev.hasDevice !== next.hasDevice || prev.hasDir !== next.hasDir)) it.dir = '';
      return is !== was;                                      // side field appeared/vanished
    }
  });
}

function settingActionCombo(item, cTarget, listId, syncRowText) {
  catalogCombo(item, cTarget, listId, syncRowText, {
    entries: () => appSettingsCatalogCache || [],
    text: sysComboText,
    entry: (id) => settingEntry(id),
    placeholder: 'Search app settings…  (▾ opens the full list)',
    aria: 'App settings',
    title: 'Show all settings',
    noun: 'setting',
    iconDefault: '\uE713',
    onPick: (c, it) => { it.value = c.id; return false; }
  });
}

function valueHint(type) {
  return {
    app: 'notepad.exe  or  C:\\Path\\to\\app.exe',
    args: '--flag  "C:\\path with space"',
    url: 'https://…', file: 'C:\\Path\\to\\file.pdf',
    command: 'taskkill /f /im foo.exe   or   C:\\Scripts\\cleanup.bat',
    macro: 'ctrl+c, wait=0.2, ctrl+v   ·   click, scroll=3   ·   hold=f15=1.5   ·   repeat=3:ctrl+v'
  }[type] || '';
}

/* ------------------------------- icon modal ------------------------------- */
const iconModal = $('#icon-modal');
let iconModalOpener = null;

/* Writes from the modal must land on the CURRENT cfg graph, not the object
   captured when the modal was opened — an external-change renderAll can swap
   cfg while the modal is up, and a write through the stale ref would vanish. */
function modalTarget() {
  if (!iconModalTarget) return null;
  for (const it of allItems())
    if (it.id === iconModalTarget.id) return it;
  return iconModalTarget;
}

/* Dialog hygiene: the scrim must seal the page behind it. #toasts stays
   reachable (error toasts during a modal must still be visible), everything
   else outside the dialog becomes inert — no stray Tab into the Settings
   page, and screen readers don't read through the scrim. */
const MODAL_BG = ['#sidebar', '#content', '#preview-pane'];
function setModalInert(on) {
  for (const sel of MODAL_BG) {
    const n = $(sel);
    if (!n) continue;
    if (on) n.setAttribute('inert', ''); else n.removeAttribute('inert');
  }
}

/* Shared status line for the modal's three sources (logo search / own image /
   glyph wall) — the cancel paths repaint it instead of leaving a stale result. */
function iconModalHint(item) {
  const term = ((item && item.label) || '').trim();
  return term
    ? `Press Enter or “Search” to look for a “${term}” logo, or pick a glyph below.`
    : 'Type a term and press Enter to search for a logo, or pick a glyph below.';
}

/* Every status write goes through here so a failure can wear the danger voice
   and the next neutral message can take it back off. */
function diStatus(msg, isErr = false) {
  const s = $('#di-status');
  if (!s) return;
  s.textContent = msg;
  s.classList.toggle('is-error', !!isErr);
}

function openIconModal(item, opener) {
  iconModalTarget = item;
  iconModalOpener = opener || null;
  const q = $('#di-query');
  // Pre-fill the fetch term from the label — always editable, always re-runnable.
  q.value = (item.label || '').trim();
  $('#di-clear-img').classList.toggle('hidden', !item.iconImage);
  const staleGrid = $('#di-grid');
  staleGrid.innerHTML = ''; staleGrid.classList.add('hidden');   // never reopen onto last time's results
  iconModal.classList.remove('hidden');
  setModalInert(true);
  q.focus();
  q.select();
  // The offline, zero-latency glyph picker is the front door — the network
  // search waits for an explicit Enter/Search (fast brand promise; the
  // first frame is never a spinner, and never a failure line).
  diStatus(iconModalHint(item));
}
function closeIconModal() {
  iconModal.classList.add('hidden');
  setModalInert(false);
  if (iconModalOpener && document.contains(iconModalOpener)) iconModalOpener.focus();
  iconModalOpener = null;
}

/* The glyph wall is 57 cells deep — nobody scans that. A curated dozen is the
   default decision surface; the full grid is one explicit click away. */
const CURATED_GLYPHS = new Set(['\uE713', '\uE774', '\uE756', '\uE8C4', '\uE706', '\uE793',
  '\uE734', '\uE9AC', '\uE9A1', '\uE77B', '\uE950', '\uE721', '\uE80F', '\uE754']);

(function buildIconGrid() {
  const grid = $('#icon-grid');
  for (const g of ICON_CATALOG) {
    const cell = el('button', 'icon-cell' + (CURATED_GLYPHS.has(g.code) ? '' : ' off'), { 'aria-label': g.name }, grid);
    el('span', 'g', { text: g.code }, cell);
    el('span', 'n', { text: g.name }, cell);
    cell.onclick = () => {
      const t = modalTarget();
      if (t) { t.icon = g.code; }
      closeIconModal();
      touch();
    };
  }
  const all = $('#glyph-all');
  if (all) {
    const rest = ICON_CATALOG.length - CURATED_GLYPHS.size;
    all.textContent = `Show all ${ICON_CATALOG.length} glyphs`;
    all.onclick = () => {
      const open = grid.classList.toggle('show-all');
      all.textContent = open ? 'Show fewer' : `Show all ${ICON_CATALOG.length} glyphs`;
    };
  }
  $('#icon-none').onclick = () => { const t = modalTarget(); if (t) t.icon = ''; closeIconModal(); touch(); };
  $('#icon-close').onclick = closeIconModal;
  iconModal.addEventListener('click', (e) => { if (e.target === iconModal) closeIconModal(); });
  // Dialog behavior: Esc dismisses, Tab stays inside the modal.
  iconModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeIconModal(); }
    else if (e.key === 'Tab') {
      // focusables, not just buttons — excluding #di-query let focus leave the dialog
      const foci = [...iconModal.querySelectorAll('button, input, [href], select, textarea')].filter((n) => !n.disabled && n.offsetParent !== null);
      if (!foci.length) return;
      const first = foci[0], last = foci[foci.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();

/* ---------- Dashboard Icons search (manual term → fetched logo) ---------- */
let diSeq = 0;

async function runDiSearch() {
  const q = $('#di-query').value.trim();
  const grid = $('#di-grid');
  const my = ++diSeq;
  grid.innerHTML = '';
  if (!q) {
    diStatus('Type a search term (usually the app name) and press Enter.');
    grid.classList.add('hidden');
    return;
  }
  diStatus('Searching dashboardicons.com…');
  grid.classList.remove('hidden');
  let r = null;
  try { r = await api.searchIcons(q); } catch { /* surfaced below */ }
  if (my !== diSeq) return;                     // a newer search won the race
  if (!r || !r.ok) { diStatus('Search failed — check the connection and retry.', true); return; }
  const results = r.results || [];
  if (!results.length) { diStatus(`No icons match “${q}” — try a different term.`); return; }
  diStatus(`${results.length} match${results.length > 1 ? 'es' : ''}${r.offline ? ' (cached catalog)' : ''} — click one to use it.`);
  for (const res of results) {
    const cell = el('button', 'icon-cell di-cell', { 'aria-label': `Use the ${res.slug} logo` }, grid);
    const im = el('img', 'di-thumb', { src: res.url, alt: '', loading: 'lazy' }, cell);
    im.addEventListener('error', () => cell.remove());   // dead CDN link — drop that candidate
    el('span', 'n', { text: res.slug }, cell);
    cell.onclick = () => pickDashboardIcon(res);
  }
}

let pickSeq = 0;
async function pickDashboardIcon(res) {
  if (!iconModalTarget) return;
  const my = ++pickSeq;
  diStatus(`Downloading “${res.slug}”…`);
  const r = await safe(() => api.fetchIcon(res.slug));
  if (my !== pickSeq) return;                     // a newer click won the race — don't resurrect this pick
  if (!r.ok) { diStatus(r.error || 'Download failed — try again.', true); return; }
  imgCache.set(res.slug, r.dataUrl);
  const t = modalTarget();
  if (t) t.iconImage = res.slug;
  closeIconModal();
  touch();
}

$('#di-go').onclick = () => runDiSearch();
$('#di-query').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runDiSearch(); }
});
$('#di-clear-img').onclick = () => {
  if (!iconModalTarget) return;
  const t = modalTarget();
  if (t) t.iconImage = '';
  closeIconModal();
  touch();
  toast('Image removed — the glyph shows instead');
};

/* ------------------- custom artwork (picked file · pasted URL) -------------------
   Both flows answer with the installed {key, kind, dataUrl}: seeding imgCache
   from that data URL paints the segment row and the preview on the spot, so a
   pick is never followed by a spinner or a glyph-only interim frame. */
function applyCustomIcon(r) {
  if (!r || !r.ok) { diStatus((r && r.error) || 'Could not use that image — try another.', true); return; }
  const t = modalTarget();
  if (!t) return;
  imgCache.set(r.key, r.dataUrl);
  failedAt.delete(r.key);                    // a stale resolve failure must not suppress the new art
  t.iconImage = r.key;
  closeIconModal();
  touch();
  toast(`Custom image set — ${String(r.kind || '').toUpperCase() || 'artwork'}`);
}

/* The native dialog and the download each outlive a single click: the trigger
   disables while in flight, and a result arriving after the modal closed is
   dropped rather than resurrecting a write to a stale target. */
$('#ci-pick').onclick = async () => {
  const btn = $('#ci-pick');
  if (btn.disabled) return;
  btn.disabled = true;
  const r = await safe(() => api.pickIconImage());
  btn.disabled = false;
  if (!iconModalTarget) return;
  if (r.canceled) { diStatus(iconModalHint(modalTarget())); return; }
  applyCustomIcon(r);
};

async function runCustomUrl() {
  const btn = $('#ci-url-go'), input = $('#ci-url');
  if (btn.disabled) return;
  const url = input.value.trim();
  if (!url) { diStatus('Paste an image URL first, or use Browse image…'); input.focus(); return; }
  btn.disabled = true;
  diStatus('Downloading that image…');
  const r = await safe(() => api.addIconFromUrl(url));
  btn.disabled = false;
  if (!iconModalTarget) return;
  applyCustomIcon(r);
}
$('#ci-url-go').onclick = runCustomUrl;
$('#ci-url').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); runCustomUrl(); }   // Enter submits the box, never the modal
});

/* ------------------------------- appearance ------------------------------- */
const SLIDERS = [
  ['innerRadius', 'Hub size', 24, 140, 1],
  ['outerRadius', 'Wheel size', 120, 360, 1],
  ['ringSplit', 'Ring split', 0.2, 0.8, 0.05],
  ['startAngle', 'Rotation °', 0, 359, 1],
  ['gapDeg', 'Gap °', 0, 10, 0.5],
  ['fontSize', 'Label size', 8, 20, 1],
  ['animationMs', 'Pop duration ms', 0, 400, 10]
];
/* Keep in sync with config.js validate (MIN_BAND): the ring band needs
   outer ≥ inner + MIN_BAND or hit-testing matches nothing at all. */
const MIN_BAND = 24;

/* The radius pair is cross-constrained (MIN_BAND): dragging one clamps the
   other. The clamp repaints the SIBLING row in place — never via
   renderAppearance(). Chromium fires `change` on every arrow-key press of a
   range input, so a full rebuild would destroy the focused slider after each
   single step (keyboard users lost focus every keypress). */
const sliderCtl = new Map();   // key -> { input, out, fill }
function syncSlider(key) {
  const c = sliderCtl.get(key);
  if (!c) return;
  const v = String(cfg.appearance[key]);
  c.input.value = v; c.out.textContent = v; c.fill();
}

function renderAppearance() {
  const host = $('#appearance-controls');
  host.innerHTML = '';
  sliderCtl.clear();
  for (const [key, label, min, max, step] of SLIDERS) {
    const row = el('div', 'slider-row', {}, host);
    const id = 'slider-' + key;
    const lab = el('label', null, { for: id }, row);
    el('span', null, { text: label }, lab);
    const out = el('output', null, { text: String(cfg.appearance[key]) }, lab);
    out.setAttribute('for', id);
    const r = el('input', null, { type: 'range', min, max, step, value: cfg.appearance[key], id }, row);
    // Apple-style filled track: Chromium ranges have no fill pseudo, so pin a --fill stop.
    const fill = () => r.style.setProperty('--fill', ((+r.value - min) / (max - min) * 100) + '%');
    fill();
    sliderCtl.set(key, { input: r, out, fill });
    // Only the preview needs the new value — never rerender the segment rows per drag frame.
    r.addEventListener('input', () => {
      let v = parseFloat(r.value);
      // Live mirror of config.js's cross-constraint: dragging Hub past
      // Wheel−24 (or Wheel under Hub+24) clamps the value back, so the dial
      // can never enter the no-band state that kills hit-testing.
      if (key === 'innerRadius') v = Math.min(v, cfg.appearance.outerRadius - MIN_BAND);
      if (key === 'outerRadius') v = Math.max(v, cfg.appearance.innerRadius + MIN_BAND);
      v = Math.min(max, Math.max(min, v));
      cfg.appearance[key] = v;
      r.value = String(v); out.textContent = String(v); fill(); renderPreview();
    });
    r.addEventListener('change', () => {
      // Sibling radius row shows the other slider's clamp (see syncSlider note).
      if (key === 'innerRadius') syncSlider('outerRadius');
      else if (key === 'outerRadius') syncSlider('innerRadius');
      syncSlider(key);
      touch(false);
    });
  }

  const cg = $('#color-grid');
  cg.innerHTML = '';
  const LABELS = { bg: 'Background', ring1: 'Inner ring', ring2: 'Outer ring', hover: 'Hover', accent: 'Accent', text: 'Text', center: 'Hub' };
  for (const [k, lab] of Object.entries(LABELS)) {
    const item = el('label', 'color-item', {}, cg);
    const inp = el('input', null, { type: 'color', value: cfg.appearance.colors[k] }, item);
    el('span', null, { text: lab }, item);
    inp.addEventListener('input', () => { cfg.appearance.colors[k] = inp.value; applyChrome(); renderPreview(); });
    inp.addEventListener('change', () => { touch(false); renderThemes(); });
  }
}

/* --------------------------------- themes ---------------------------------- */
/* The gallery renders every candidate theme through the SHARED wheel renderer
   (a chip is literally a small wheel), then re-skins the Settings chrome from
   the active palette. Curated catalog lives in src/main/themes.mjs. */

function activeTheme() {
  const id = cfg.theme && cfg.theme.id;
  if (id) {
    const user = (cfg.userThemes || []).find((t) => t.id === id);
    if (user) return { id: user.id, name: user.name, colors: user.colors, user: true };
    const cat = themeById(id);
    if (cat) return { id: cat.id, name: cat.name, colors: cat.colors, user: false };
  }
  const bySig = themeBySignature(signature(cfg.appearance.colors));
  return bySig
    ? { id: bySig.id, name: bySig.name, colors: bySig.colors, user: false }
    : { id: null, name: 'Custom', colors: cfg.appearance.colors, user: false };
}

function isCustomized() {
  const a = activeTheme();
  if (!a.id) return false;
  return signature(cfg.appearance.colors) !== signature(a.colors);
}

function applyChrome() {
  // persona fields (mode/stroke/edge/shadow/sheen) live on the theme palette;
  // editable swatches never carry them, so merge the active theme's in.
  const a = activeTheme();
  const pal = a.id ? Object.assign({}, a.colors, cfg.appearance.colors,
    { mode: cfg.appearance.colors.mode || a.colors.mode }) : cfg.appearance.colors;
  const chrome = computeChrome(pal);
  const root = document.documentElement;
  root.dataset.mode = paletteMode(pal);
  root.style.colorScheme = root.dataset.mode;
  for (const [k, v] of Object.entries(chromeVarMap(chrome))) root.style.setProperty(k, v);
}

function applyThemeColors(colors, themeId) {
  cfg.appearance.colors = { ...colors };
  cfg.theme = { id: themeId, customized: false, colors: { ...colors } };
  applyChrome();
  renderAppearance();
  renderThemes();
  renderPreview();
  touch(false);
}

/* A chip wheel at true pixel size: fixed geometry sized so the SVG lands
   exactly in the .mini slot (outer*2 + pad*2 = 40), labels off, per-item
   colors stripped — the theme's plates must show, not segment overrides.
   The 26px shadow pad and 14px blur are tuned for the full wheel; a 40px
   chip carries its own miniature pair. */
const CHIP_SIZE = 40, CHIP_PAD = 5;
function miniWheel(host, colors) {
  const ring = (arr, max) => (arr || []).slice(0, max)
    .map((it) => ({ ...it, color: null, icon: '', iconImage: null }));   // plates only — a fluent glyph at chip scale reads as spikes
  const outer = CHIP_SIZE / 2 - CHIP_PAD;
  const mini = {
    appearance: Object.assign({}, cfg.appearance, {
      colors, showLabels: false, centerLabel: '', animationMs: 0,
      innerRadius: Math.round(outer * 0.42), outerRadius: outer,
      startAngle: cfg.appearance.startAngle,
    }),
    rings: Object.fromEntries(
      (() => { const RM = ringsModel(); return ringKeys().map((k, i) => [k, ring(RM && RM[k], i === 0 ? 6 : 10)]); })()
    ),
  };
  buildWheel(host, mini, { preview: true, scale: 1, pad: CHIP_PAD, shadowBlur: 3, shadowDy: 1 });
}

function renderThemes() {
  const host = $('#presets');
  if (!host) return;
  host.innerHTML = '';
  const a = activeTheme(), custom = isCustomized();

  const entries = THEMES.map((t) => ({ key: t.id, name: t.name, colors: t.colors, user: false }))
    .concat((cfg.userThemes || []).map((t) => ({ key: t.id, name: t.name, colors: t.colors, user: true })));

  for (const t of entries) {
    const b = el('button', 'preset theme' + (t.user ? ' user' : ''), { type: 'button' }, host);
    b.setAttribute('aria-pressed', String(!custom && a.id === t.key));
    const mini = el('span', 'mini', {}, b);
    miniWheel(mini, t.colors);
    const lab = el('span', 'theme-name', { text: t.name }, b);
    if (custom && a.id === t.key) {
      b.classList.add('active', 'modified');
      b.setAttribute('aria-pressed', 'true');
      lab.title = 'Edited — click to restore ' + t.name;
    } else if (!custom && a.id === t.key) {
      b.classList.add('active');
    }
    b.onclick = () => applyThemeColors(t.colors, t.key);
  }

  if (!entries.length) return;
  const ops = el('span', 'theme-ops', {}, host);

  const save = el('button', 'btn small', { type: 'button', text: 'Save as theme…' }, ops);
  save.onclick = () => {
    const near = themeBySignature(signature(cfg.appearance.colors));
    const input = el('input', 'theme-name-input', {
      type: 'text', maxlength: '24', placeholder: near ? near.name + ' copy' : 'My theme',
      'aria-label': 'New theme name',
    }, ops);
    input.value = '';
    ops.replaceChild(input, save);
    input.focus();
    const commit = () => {
      const raw = input.value.trim() || input.placeholder;
      const taken = new Set(
        THEMES.map((t) => t.name.toLowerCase())
          .concat((cfg.userThemes || []).map((t) => t.name.toLowerCase())));
      let name = raw.slice(0, 24), n = 2;
      // Mirror of config.js cleanUserTheme: build the suffix from a base the
      // 24-char cap cannot swallow — the old `(raw + ' (n)').slice(0, 24)`
      // form looped forever (freezing this renderer) when a ≥24-char name hit
      // an existing 24-char prefix.
      while (taken.has(name.toLowerCase()) && n <= 9999) name = (raw.slice(0, 18) + ' (' + (n++) + ')').slice(0, 24);
      if (taken.has(name.toLowerCase())) name = ('Theme ' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5)).slice(0, 24);
      cfg.userThemes = (cfg.userThemes || []).concat([{
        id: 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
        name, colors: { ...cfg.appearance.colors },
      }]);
      cfg.theme = { id: cfg.userThemes[cfg.userThemes.length - 1].id, customized: false, colors: { ...cfg.appearance.colors } };
      renderThemes();
      renderPreview();
      touch(false);
      toast('Theme saved: ' + name, false, () => {
        cfg.userThemes = cfg.userThemes.filter((x) => x.id !== cfg.theme.id);
        cfg.theme = { id: 'midnight', customized: false, colors: { ...THEMES[0].colors } };
        cfg.appearance.colors = { ...THEMES[0].colors };
        applyChrome(); renderAppearance(); renderThemes(); renderPreview(); touch(false);
      });
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      else if (e.key === 'Escape') { e.preventDefault(); renderThemes(); }
    });
    // A stray click elsewhere must NOT mint a theme named after the
    // placeholder — blur commits only real text; empty blur reverts (like Esc).
    input.addEventListener('blur', () => {
      if (!input.isConnected) return;
      if (input.value.trim()) commit(); else renderThemes();
    });
  };

  if (custom && a.id && !a.user) {
    const reset = el('button', 'btn small', { type: 'button', text: 'Reset colors' }, ops);
    reset.onclick = () => applyThemeColors(a.colors, a.id);
  }
  if (a.id && a.user && activeTheme().user) {
    const del = el('button', 'btn small danger', { type: 'button', text: 'Delete theme' }, ops);
    let armed = false;
    del.onclick = () => {
      if (!armed) { armed = true; del.textContent = 'Sure?'; del.classList.add('armed'); setTimeout(() => { if (del.isConnected) { armed = false; del.textContent = 'Delete theme'; del.classList.remove('armed'); } }, 2600); return; }
      const snapshot = clone(cfg);   // capture the pre-delete graph — the undo restores it wholesale
      cfg.userThemes = (cfg.userThemes || []).filter((x) => x.id !== a.id);
      applyThemeColors(THEMES[0].colors, THEMES[0].id);   // removing the live theme lands on Midnight
      // Same mercy as every other destructive act in this window: name it, undo it.
      toast(`Deleted theme “${a.name}”`, false, () => { restoreConfig(snapshot); });
    };
  }
}

/* -------------------------------- behavior -------------------------------- */
/* Mouse-button triggers. MouseEvent.button -> spec token; left (0) and right (2)
   are deliberately not recordable (see hotkeys.js MOUSE_KEYS). */
const HK_MOUSE = { 1: 'mmiddle', 3: 'mback', 4: 'mfwd' };
const MOUSE_LABELS = { mmiddle: 'Middle click', mback: 'Back button', mfwd: 'Forward button' };

function fmtHotkey(spec) {
  const nice = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', space: 'Space', esc: 'Esc', enter: 'Enter', pgup: 'PgUp', pgdn: 'PgDn' };
  return String(spec || '').toLowerCase().split('+').filter(Boolean)
    .map((t) => MOUSE_LABELS[t] || nice[t] || (t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1)))
    .join(' + ');
}
/** The mouse token of a spec, or null when its main key is a keyboard key. */
function hotkeyMouseToken(spec) {
  const toks = String(spec || '').toLowerCase().split('+').filter(Boolean);
  const last = toks[toks.length - 1];
  return MOUSE_LABELS[last] ? last : null;
}
function updateHotkeyChip() {
  $('#hk-display').textContent = fmtHotkey(cfg.hotkey);
  updateMouseControls();
}
/* The click-through checkbox only means something while a mouse button is the
   trigger — dim it otherwise (same affordance as the gaming-mode app list). */
function updateMouseControls() {
  const c = $('#bh-mouse-through');
  if (!c) return;
  const live = hotkeyMouseToken(cfg.hotkey) !== null;
  c.disabled = !live;
  const lbl = c.closest('label');
  if (lbl) lbl.classList.toggle('dim', !live);
}
function showHkError(msg) {
  const e = $('#hk-error');
  if (msg) { e.textContent = msg; e.classList.remove('hidden'); }
  else e.classList.add('hidden');
}

let recording = false;
$('#recorder-btn').addEventListener('click', () => {
  recording = !recording;
  $('#recorder-btn').textContent = recording ? 'Press your shortcut… (Esc cancels)' : 'Change…';
  $('#recorder-btn').setAttribute('aria-pressed', String(recording));
  $('#hk-display').classList.toggle('recording', recording);
});

function modsOf(e) {
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('win');
  return mods;
}

/* Register + persist through main (which restores the old trigger if the
 * registration fails), then refresh the chip. Capture is stopped BEFORE the
 * await: if the invoke rejects, the window-wide preventDefault/stopPropagation
 * listeners must already be off — otherwise Settings stays input-dead until the
 * recorder button is clicked again (the behaviour welcome.js has always had). */
async function commitSpec(spec, note) {
  stopRecording();
  let r = null;
  try { r = await api.setHotkey(spec); } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
  if (r.ok) {
    cfg.hotkey = spec; updateHotkeyChip(); showHkError(null);
    toast(`Hotkey set to ${fmtHotkey(spec)}` + (note ? ' — ' + note : ''), !!note, null, note ? 6000 : 2000);
  } else { showHkError(r.error); toast(r.error, true, null, 5000); }
}

/* Mouse-button capture: press Middle / Back / Forward (optionally with
   modifiers) while recording. The button under the cursor must NOT act as the
   trigger, so the recorder's own control is ignored — clicking "Change…" still
   cancels. Left/right presses are ignored outright (not recordable). */
window.addEventListener('mousedown', (e) => {
  if (!recording) return;
  const t = e.target;
  if (t && t.closest && t.closest('#recorder-btn')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.button === 0 || e.button === 2) return;                 // cancel / no-op, stays silent
  const token = HK_MOUSE[e.button];
  if (!token) { toast('Use the Middle, Back or Forward button', true); return; }
  const mods = modsOf(e);
  const spec = [...mods, token].join('+');
  // A bare button trigger also hides the swallow default, so say what happened.
  const note = (!mods.length && cfg.behavior && cfg.behavior.mouseClickThrough === false)
    ? `${MOUSE_LABELS[token]} no longer reaches the app underneath — tick “Let the mouse button through” to get it back.`
    : '';
  commitSpec(spec, note);
}, true);

/* Right-click during capture must not pop the window menu. */
window.addEventListener('contextmenu', (e) => {
  if (!recording) return;
  e.preventDefault(); e.stopPropagation();
}, true);

const HK_KEYS = {
  ' ': 'space', Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
};
/* Punctuation keys the hotkey grammar accepts (mirrors welcome-core.mjs NAMED). */
const REC_PUNCT = {
  '-': 'minus', '=': 'equal', ',': 'comma', '.': 'period', '/': 'slash',
  '\\': 'backslash', ';': 'semicolon', "'": 'quote', '`': 'backquote'
};

window.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { stopRecording(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // wait for the main key
  let key = HK_KEYS[e.key];
  if (!key && /^F([1-9]|1[0-9]|2[0-4])$/i.test(e.key)) key = e.key.toLowerCase();
  // Same punctuation set as welcome-core.mjs NAMED / hotkeys.js KEYS — combos
  // recordable in the FTU must be obtainable from Settings too.
  if (!key && e.key.length === 1) key = REC_PUNCT[e.key] || (/[a-z0-9]/i.test(e.key) ? e.key.toLowerCase() : undefined);
  if (!key) { toast('Unsupported key: ' + e.key, true); return; }
  const mods = modsOf(e);
  if (!mods.length) { toast('Add a modifier (Ctrl/Alt/Shift/Win) — or press Middle / Back / Forward on the mouse', true); return; }
  commitSpec([...mods, key].join('+'));
}, true);

function stopRecording() {
  recording = false;
  $('#recorder-btn').textContent = 'Change…';
  $('#recorder-btn').setAttribute('aria-pressed', 'false');
  $('#hk-display').classList.remove('recording');
}

/* Mirror of gamemode.cleanAppName: comma/newline-separated input -> unique
   lowercase exe basenames (junk dropped, capped at 64). */
function parseAppList(text) {
  const seen = new Set();
  const out = [];
  for (let s of String(text || '').split(/[,\n]/)) {
    s = s.trim().toLowerCase();
    const slash = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
    if (slash >= 0) s = s.slice(slash + 1).trim();
    s = s.replace(/["']/g, '').trim();
    if (!s || !/^[\w .\-\u0080-\uffef]{1,64}$/.test(s) || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= 64) break;
  }
  return out;
}

let autostartAllowed = true;

function wireBehaviorCheckboxes() {
  const map = {
    'autostart-chk': ['behavior', 'autostart'],
    'bh-esc': ['behavior', 'dismissOnEscape'],
    'bh-right': ['behavior', 'dismissOnRightClick'],
    'bh-retrigger': ['behavior', 'reTriggerToggles'],
    // Only meaningful while the trigger's main key is a mouse button (dimmed then).
    'bh-mouse-through': ['behavior', 'mouseClickThrough'],
    // Marking + type-to-filter default ON; both are opt-out (validate mirrors this).
    'bh-marking': ['behavior', 'markingSelect'],
    'bh-filter': ['behavior', 'typeToFilter'],
    // Opt-in (defaults off): config validate fail-closes anything but true.
    'bh-sound': ['behavior', 'wheelSound'],
    // Opt-in, same fail-closed discipline: focus a running app's window instead of a new instance.
    'bh-focus': ['behavior', 'focusExistingApp'],
    // Update poll is opt-OUT (default on, mirroring validate); the manual
    // "Check for updates" button below ignores the flag.
    'bh-update-checks': ['behavior', 'updateChecks'],
    // Master switch for the Segments tab's profile chips.
    'bh-profiles': ['behavior', 'profilesEnabled']
  };  for (const [id, [sec, key]] of Object.entries(map)) {
    const c = $('#' + id);
    c.checked = cfg[sec][key];
    c.onchange = async () => {
      cfg[sec][key] = c.checked;
      if (sec === 'behavior' && key === 'profilesEnabled') renderProfileBar();   // OFF-hint follows the switch
      if (sec === 'behavior' && key === 'autostart') {
        let r = null;
        try { r = await api.setAutostart(c.checked); } catch (err) { r = { ok: false, error: String((err && err.message) || err) }; }
        if (!r || !r.ok) {
          toast('Autostart failed: ' + ((r && r.error) || 'unknown'), true);
          c.checked = !c.checked;
          cfg[sec][key] = c.checked;   // revert the MODEL with the checkbox — the old code left cfg flipped
          return;
        }
        toast(r.skipped ? 'Saved' : (r.verified ? 'Startup registration confirmed' : 'Saved (could not verify login item)'));
      }
      touch(false);
    };
  }
  const auto = $('#autostart-chk');
  const autoLbl = $('#autostart-lbl');
  const autoHint = $('#autostart-hint');
  if (auto) auto.disabled = !autostartAllowed;
  if (autoLbl) autoLbl.classList.toggle('dim', !autostartAllowed);
  if (autoHint) autoHint.classList.toggle('hidden', autostartAllowed);
  /* Where a program opened FROM THE WHEEL places its fresh window: the app
     itself (default), under the cursor, or centered on the cursor's display
     (src/main/winplace.js). The wheel overlay always follows the cursor.
     Read live by main at every segment fire — nothing to restart. */
  const posSel = $('#bh-app-open');
  if (posSel) {
    const v = cfg.behavior && cfg.behavior.appOpenPosition;
    posSel.value = (v === 'cursor' || v === 'center') ? v : 'default';
    posSel.onchange = () => {
      cfg.behavior.appOpenPosition =
        (posSel.value === 'cursor' || posSel.value === 'center') ? posSel.value : 'default';
      touch(false);
    };
  }
  /* Sub-menu dwell: how long a folder must be hovered before it branches. */
  const fly = $('#bh-flyout'), flyOut = $('#bh-flyout-out');
  if (fly) {
    const fill = () => fly.style.setProperty('--fill', (Math.min(600, Math.max(0, Number(fly.value))) / 600 * 100) + '%');
    const cur = Number(cfg.behavior && cfg.behavior.flyoutDwellMs);
    fly.value = String(Number.isFinite(cur) ? Math.min(600, Math.max(0, cur)) : 180);
    if (flyOut) flyOut.textContent = fly.value + ' ms';
    fill();
    fly.addEventListener('input', () => { if (flyOut) flyOut.textContent = fly.value + ' ms'; fill(); });
    fly.addEventListener('change', () => { cfg.behavior.flyoutDwellMs = Number(fly.value) || 0; touch(false); });
  }
  /* Recents fan size: how many most-recently-used segments a `recent` shows. */
  const rc = $('#bh-recents'), rcOut = $('#bh-recents-out');
  if (rc) {
    const fillRc = () => rc.style.setProperty('--fill', (Math.min(12, Math.max(3, Number(rc.value)) - 3) / 9 * 100) + '%');
    const curRc = Number(cfg.behavior && cfg.behavior.recentsCount);
    rc.value = String(Number.isFinite(curRc) ? Math.min(12, Math.max(3, Math.round(curRc))) : 8);
    if (rcOut) rcOut.textContent = rc.value;
    fillRc();
    rc.addEventListener('input', () => { if (rcOut) rcOut.textContent = rc.value; fillRc(); });
    rc.addEventListener('change', () => { cfg.behavior.recentsCount = Number(rc.value) || 8; touch(false); });
  }
  /* Gaming mode: master toggle + comma-separated always-off app list. */
  if (!cfg.behavior.gameMode) cfg.behavior.gameMode = { enabled: false, apps: [] };
  const gmOn = $('#bh-gamemode');
  const gmApps = $('#gm-apps');
  gmOn.checked = cfg.behavior.gameMode.enabled === true;
  gmApps.value = (cfg.behavior.gameMode.apps || []).join(', ');
  gmApps.disabled = !gmOn.checked;
  gmOn.onchange = () => {
    cfg.behavior.gameMode.enabled = gmOn.checked;
    gmApps.disabled = !gmOn.checked;
    touch(false);
  };
  gmApps.onchange = () => {
    cfg.behavior.gameMode.apps = parseAppList(gmApps.value);
    gmApps.value = cfg.behavior.gameMode.apps.join(', ');   // reflect normalization
    touch(false);
  };
  updateMouseControls();   // dim/enable the click-through toggle for the current trigger
  $('#ap-showlabels').checked = cfg.appearance.showLabels;
  $('#ap-showlabels').onchange = (e) => { cfg.appearance.showLabels = e.target.checked; renderPreview(); touch(false); };
  const cl = $('#ap-centerlabel');
  cl.value = cfg.appearance.centerLabel;
  cl.oninput = () => { cfg.appearance.centerLabel = cl.value; touch(false); };   // preview live AND persist (touch(false) rerenders the preview without the row-list rebuild)
  $('#btn-test').onclick = async () => {                                             // onclick, not addEventListener: never stacks across rerenders
    const r = await safe(() => api.testWheel());
    if (r && r.ok === false) toast(r.error || 'Could not pop the wheel', true);
  };
}

/* -------------------------------- advanced --------------------------------- */
/* Every bridge invoke is treated as possibly REJECTING (window reload mid-call,
   an unexpected main-side throw): rejections are folded into the {ok:false,
   error} shape every UI branch in this file already speaks. */
async function safe(call) {
  try { return (await call()) || { ok: false, error: 'empty response' }; }
  catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
}

async function restoreConfig(snapshot) {
  const u = await safe(() => api.setConfig(snapshot));
  if (u.ok) {
    cfg = clone(u.config); dirty = false;
    renderAll();
    showHkError(u.hotkeyError || null);
    toast('Previous config restored');
  } else {
    toast('Could not undo: ' + (u.error || 'unknown'), true);
  }
}

/* Update chip + manual check (sidebar under the version). The chip is a
   status light, not a log: it appears only when there is something to act on
   (an available update, or a failed check worth retrying); "up to date" and
   "never checked" leave it hidden so the sidebar stays quiet. All data is
   main-supplied and already sanitized (update.js); this page never sees a URL
   it could steer anywhere — openRelease re-validates against main's copy. */
async function wireUpdateChip() {
  const chip = $('#update-chip');
  const btn = $('#btn-update-check');
  if (!chip || !btn) return;
  let busy = false;
  let releaseUrl = '';
  const paint = (s) => {
    const st = (s && s.status) || 'none';
    const avail = st === 'available' && s.info;
    releaseUrl = avail ? s.info.url : '';
    chip.classList.toggle('available', !!avail);
    if (avail) {
      chip.textContent = (s.kind === 'build' ? 'New build available — ' : 'Update available — ')
        + (s.info.version || '') + ' \u00b7 get it';
      chip.title = 'Open the release page in your browser';
      chip.classList.remove('hidden');
    } else if (st === 'checking') {
      chip.textContent = 'Checking for updates\u2026';
      chip.classList.remove('hidden');
    } else if (st === 'error') {
      chip.textContent = 'Update check failed \u00b7 retry';
      chip.title = s.error || 'Could not reach GitHub';
      chip.classList.remove('hidden');
    } else {
      chip.classList.add('hidden');
    }
    btn.disabled = busy;
    btn.textContent = busy ? 'Checking\u2026' : 'Check for updates';
  };
  chip.onclick = async () => {
    if (chip.classList.contains('available')) {
      const r = await safe(() => api.openRelease(releaseUrl));
      if (!r.ok) toast('Could not open the browser: ' + (r.error || 'unknown'), true);
    } else {
      await runCheck();
    }
  };
  async function runCheck() {
    if (busy) return;
    busy = true;
    paint({ status: 'checking' });
    const s = await safe(() => api.checkUpdate());
    busy = false;
    paint(s);
    if (s.status === 'available' && s.info) toast((s.kind === 'build' ? 'New build ' : 'Version ') + s.info.version + ' is available');
  }
  btn.onclick = runCheck;
  const s0 = await safe(() => api.updateState());
  paint(s0);
}

async function wireAdvanced() {
  $('#ver').textContent = 'v' + (await api.appVersion());
  wireUpdateChip();
  $('#btn-export').onclick = async () => {
    const r = await safe(() => api.exportConfig());
    if (r.ok) toast('Exported to ' + r.path);
    else if (!r.canceled) toast('Export failed: ' + r.error, true);
  };
  /* Import and Restore-a-backup land in the same place: adopt the graph main
     returned, repaint, and hand over ONE catchable Undo. The toast is the fast
     path; the outgoing config also survives on disk under \backups (see
     config.js), which is what makes a restore safe to attempt at all. */
  async function afterReplace(r, snapshot, msg) {
    if (!r.ok) { if (!r.canceled) toast(r.error || 'Could not load that file', true); return false; }
    cfg = clone(r.config); dirty = false;
    activeProfileId = null;                       // an imported graph is a different world — start on the default wheel
    if (typeof r.rev === 'number') storeRev = r.rev;
    /* A package just installed fresh icon bytes in main — drop the local
       resolution caches so the rows/preview re-resolve them (a previously
       failed key must retry, not sit in its cooldown). */
    if (r.icons) { imgCache.clear(); failedAt.clear(); }
    renderAll();
    showHkError(r.hotkeyError || null);           // never let the chip claim a combo that failed to register
    toast(msg, false, async () => { await restoreConfig(snapshot); });
    return true;
  }

  $('#btn-import').onclick = async () => {
    const snapshot = clone(cfg);
    const r = await safe(() => api.importConfig());
    const msg = r.icons
      ? `Package imported — ${r.icons.installed} icon${r.icons.installed === 1 ? '' : 's'} carried over${r.icons.skipped ? `, ${r.icons.skipped} skipped (glyph fallback)` : ''}`
      : 'Config imported';
    await afterReplace(r, snapshot, msg);
  };

  $('#btn-restore-backup').onclick = async () => {
    const snapshot = clone(cfg);
    const r = await safe(() => api.restoreBackup());
    const done = await afterReplace(r, snapshot, 'Backup restored — the config it replaced is in the backups folder too');
    if (done) loadUsage();                        // the graph changed under the counts: re-join them
  };

  $('#btn-reset').onclick = async () => {
    const snapshot = clone(cfg);
    const r = await safe(() => api.resetConfig());
    const done = await afterReplace(r, snapshot, 'Settings reset to defaults');
    if (done) loadUsage();
  };
  $('#btn-openfolder').onclick = () => api.openConfigFolder();
  $('#btn-export-pkg').onclick = async () => {
    const r = await safe(() => api.exportBundle());
    if (r.ok) {
      const miss = r.skipped ? ` — ${r.skipped} icon${r.skipped === 1 ? '' : 's'} missing from the cache (those segments travel as glyphs)` : '';
      toast(`Package exported with ${r.icons} icon${r.icons === 1 ? '' : 's'}${miss}`);
    } else if (!r.canceled) toast('Export failed: ' + r.error, true);
  };

  /* ---- Usage: what the `recent` fan is actually built from -----------------
     Main joins the sidecar counts to the LIVE config, so a segment the user
     deleted disappears from the list instead of haunting it; the orphan count
     is the honest "these fires belong to nothing any more" line. Labels are
     user text → textContent only, never innerHTML. */
  function agoText(t, ageMs) {
    if (!t) return 'never';
    const ms = Number.isFinite(ageMs) ? ageMs : (Date.now() - t);
    const min = Math.floor(ms / 60000);
    if (min < 1) return 'just now';
    if (min < 60) return `${min} min ago`;
    const h = Math.floor(min / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.floor(h / 24);
    if (d < 7) return `${d} day${d > 1 ? 's' : ''} ago`;
    try { return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }); }
    catch { return '—'; }
  }

  const usageRows = $('#usage-rows'), usageSum = $('#usage-summary');
  let usageLoading = false;
  async function loadUsage() {
    if (usageLoading || !usageRows) return;
    usageLoading = true;
    if (usageSum) usageSum.textContent = 'Reading counts…';
    const r = await safe(() => api.usageStats());
    usageLoading = false;
    if (!r || r.ok === false) {
      usageRows.innerHTML = '';
      if (usageSum) usageSum.textContent = (r && r.error) || 'Could not read the usage counts.';
      return;
    }
    usageRows.innerHTML = '';
    const seg = (n) => (n === 1 ? 'segment' : 'segments');
    if (!r.rows.length) {
      if (usageSum) usageSum.textContent = 'Nothing fired from the real wheel yet — fire a few segments and refresh.';
      el('div', 'usage-empty', { text: 'Recent segments stay empty until the wheel gets some use. (Settings’ “Try” buttons deliberately do not count.)' }, usageRows);
      return;
    }
    if (usageSum) {
      usageSum.textContent = `${r.segments} ${seg(r.segments)} used · ${r.totalFires} fire${r.totalFires === 1 ? '' : 's'} counted`
        + (r.orphans ? ` · ${r.orphans} orphan count${r.orphans === 1 ? '' : 's'} from deleted segments` : '');
    }
    r.rows.forEach((row, i) => {
      const tr = el('div', 'usage-row', { role: 'listitem' }, usageRows);
      el('span', 'u-rank', { text: String(i + 1), 'aria-hidden': 'true' }, tr);
      const nameCell = el('span', 'u-label', {}, tr);
      el('span', null, { text: row.label }, nameCell);
      const where = row.profile ? `${row.profile} profile` : (row.path ? row.path : (row.ring ? `ring ${row.ring}` : ''));
      el('span', 'u-where', { text: `${row.type}${where ? ' · ' + where : ''}` }, nameCell);
      el('span', 'u-n', { text: `${row.n}×`, title: 'Times fired from the wheel' }, tr);
      el('span', 'u-when', { text: agoText(row.t, row.ageMs) }, tr);
    });
  }
  if (usageRows) usageRows.setAttribute('role', 'list');
  onAdvancedTab = loadUsage;             // opening Advanced re-reads the counts
  const refresh = $('#btn-usage-refresh');
  if (refresh) refresh.onclick = () => { loadUsage(); };

  $('#btn-clear-usage').onclick = async () => {
    const r = await safe(() => api.clearUsage());
    if (r.ok) { toast('Recent-items data cleared — recent segments will refill as you use the wheel'); loadUsage(); }
    else toast(r.error || 'Could not clear recent-items data', true);
  };
  $('#btn-openlogs').onclick = async () => {
    const r = await safe(() => api.openLogsFolder());
    if (r && r.ok === false) toast(r.error || 'Could not open the logs folder', true);
  };
  /* Support the developer: the PayPal.me URL is fixed in main (src/main/donate.js),
     so both entry points — the Advanced card and the sidebar link — share one
     unprivileged-by-argument call. A refusal (no default browser handler) only
     toasts; nothing else in the window is involved. */
  const donateClick = async () => {
    const r = await safe(() => api.openDonate());
    if (r && r.ok === false) toast(r.error || 'Could not open the donation page', true);
  };
  const donateBtn = $('#btn-donate');
  if (donateBtn) donateBtn.onclick = donateClick;
  const donateSide = $('#btn-donate-side');
  if (donateSide) donateSide.onclick = donateClick;
  /* Quit is the highest-stakes click in this window — answer it in-brand,
     with the same armed second-click the theme delete and guarded Try use.
     A native confirm() is Windows chrome wearing none of this system's voice. */
  const quit = $('#btn-quit');
  let quitArmed = false, quitTimer = null;
  quit.onclick = () => {
    if (!quitArmed) {
      quitArmed = true;
      quit.textContent = 'Click again to quit';
      quit.classList.add('armed');
      clearTimeout(quitTimer);
      quitTimer = setTimeout(() => {
        if (quit.isConnected) { quitArmed = false; quit.textContent = 'Exit Nucleus'; quit.classList.remove('armed'); }
      }, 3000);
      return;
    }
    api.requestQuit();
  };
}

/* ---------------------------------- audio -----------------------------------
   The Audio tab: default output/input pickers, master volume/mute for each,
   and the per-app mixer. All state is READ BACK from Windows (main owns Core
   Audio), so the screen shows the truth even when another app changes volume
   behind our back; the poll runs only while the tab is visible, and a row the
   user is actively dragging is never overwritten mid-gesture (busy flag). */
let audioPollTimer = null;
const AUDIO_POLL_MS = 2000;

function stopAudioPoll() {
  if (audioPollTimer) { clearInterval(audioPollTimer); audioPollTimer = null; }
}
function startAudioPoll() {
  stopAudioPoll();
  audioPollTimer = setInterval(() => {
    const btn = $('#tabbtn-audio');
    if (document.hidden || !btn || !btn.classList.contains('active')) { stopAudioPoll(); return; }
    audioRefreshLevels();
    audioRefreshSessions();
  }, AUDIO_POLL_MS);
}
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudioPoll(); });

let audioRefreshLevels = () => Promise.resolve();   // wired by wireAudio()
let audioRefreshSessions = () => Promise.resolve();

async function wireAudio() {
  const info = await safe(() => api.audioAvailable());
  // One line in the log file (preload forwards page console) — the audio
  // equivalent of the "why is nothing happening" breadcrumb that makes the
  // mixer features debuggable from %APPDATA%\Nucleus\logs alone.
  console.log('[audio] available:', !!(info && info.ok !== false), (info && (info.reason || info.error)) || '');
  const notice = $('#au-unavailable');
  const live = !!info && info.ok !== false;
  // Main remembers a completely dead policy ladder for the life of the process.
  // When it does, the pickers say so up front instead of letting the user click
  // into a list that cannot commit — reading devices still works, only the
  // switch is impossible for any app on such an image.
  const canSwitch = live && (!info || info.canSetDefault !== false);
  if (!live) {
    document.querySelectorAll('#tab-audio .audio-live').forEach((n) => n.classList.add('hidden'));
    if (notice) {
      notice.textContent = 'Audio control is unavailable — ' +
        ((info && (info.reason || info.error)) || 'this feature needs Windows');
      notice.classList.remove('hidden');
    }
  }
  const ss = $('#au-sound-settings');
  if (ss) ss.onclick = () => api.previewAction({ type: 'sys', value: 'sound' });
  if (!live) return;

  /* One direction of the mixer: device select + master slider + mute. */
  function wireDevice(spec) {
    const sel = $(spec.sel), rg = $(spec.refresh), vol = $(spec.vol), out = $(spec.out), mute = $(spec.mute);
    let loading = false;
    let volBusy = false, volIdle = null;

    // A dead ladder is process-wide knowledge, so the row admits it before the
    // first doomed click: the list stays readable, the switch is explained, and
    // the escape hatch is named by its label rather than by a direction.
    if (!canSwitch) {
      const line = sel.closest('.row-line') || sel.parentNode;
      if (line && line.parentNode) {
        const hint = el('div', 'hint muted', {
          text: 'Apps cannot change the default here on this Windows install \u2014 the Open Windows sound settings button at the bottom of this page is the escape hatch.'
        }, line.parentNode);
        line.parentNode.insertBefore(hint, line.nextSibling);
      }
    }

    const fillDevices = (devices) => {
      sel.innerHTML = '';
      devices.forEach((d) => {
        el('option', null, { text: d.name + (d.isDefault ? '  ·  default' : ''), value: d.id }, sel);
      });
      const def = devices.find((d) => d.isDefault);
      if (def) sel.value = def.id;
      if (!devices.length) el('option', null, { text: '(no devices found)', value: '' }, sel);
    };
    async function loadDevices(force) {
      if (loading) return;
      loading = true;
      const devices = await loadAudioDevices(spec.flow, force);
      loading = false;
      fillDevices(devices);
    }

    /* ---- hidden devices (behavior.audioHidden) ----
       Hiding here removes an endpoint from EVERY picker (this list, the
       wheel's mixer card, the segment editor) — main filters the shared
       audio:devices channel, so all surfaces agree. The manager itself
       fetches the full list (loadAllAudioDevices) and keeps hidden names in
       the store, so an unplugged device still reads as its name. The current
       default is exempt app-wide: hiding can never make a picker misreport
       what Windows actually plays through. */
    const mg = $(spec.manage), panel = $(spec.panel);
    let allCache = null;                        // the full live list, while the panel is open
    const hiddenList = () => {
      const b = ((cfg.behavior || {}).audioHidden || {})[spec.flow];
      return Array.isArray(b) ? b : [];
    };
    const setHidden = (list) => {
      cfg.behavior = cfg.behavior || {};
      cfg.behavior.audioHidden = cfg.behavior.audioHidden || { render: [], capture: [] };
      cfg.behavior.audioHidden[spec.flow] = list;
      touch(false);                             // the same debounced save every other edit uses
    };
    function hRow(parent, name, note, btnText, btnTitle, onClick, disabled) {
      const row = el('div', 'au-hrow', {}, parent);
      el('span', 'au-hname', { text: name }, row);
      if (note) el('span', 'au-hnote muted', { text: note }, row);
      const b = el('button', 'btn small', { type: 'button', text: btnText, title: btnTitle }, row);
      b.disabled = !!disabled;
      b.addEventListener('click', onClick);
      return row;
    }
    async function toggleHidden(id, name, hide) {
      const cur = hiddenList();
      setHidden(hide
        ? cur.concat([{ id, name: String(name || '').slice(0, 512) }])
        : cur.filter((h) => h.id !== id));
      allCache = await loadAllAudioDevices(spec.flow);
      if (panel.isConnected) buildHiddenPanel();
      await loadDevices(true);                  // the dropdown re-reads main's filtered list
    }
    function buildHiddenPanel() {
      panel.innerHTML = '';
      const hidden = hiddenList();
      const hiddenIds = new Set(hidden.map((h) => h.id));
      const live = allCache || [];
      el('div', 'hint muted', {
        text: 'Hidden devices disappear from every picker — here, the wheel\u2019s mixer card, and the segment editor. The current default is always shown, so this list can never hide what you are actually listening through.'
      }, panel);
      live.forEach((d) => {
        const isDef = d.isDefault === true;
        const isHid = hiddenIds.has(d.id) && !isDef;   // default shows whatever the list says
        hRow(panel, d.name || d.id,
          isDef ? '\u00b7 current default' : (isHid ? '\u00b7 hidden' : ''),
          isHid ? 'Restore' : 'Hide',
          isDef ? 'The current default device is always shown'
            : (isHid ? 'Show this device in the pickers again' : 'Remove this device from the pickers'),
          () => { void toggleHidden(d.id, d.name || d.id, !isHid); },
          isDef);
      });
      const orphans = hidden.filter((h) => !live.some((d) => d.id === h.id));
      if (orphans.length) {
        el('div', 'au-hsec muted', { text: 'Hidden while unplugged' }, panel);
        for (const h of orphans) {
          hRow(panel, h.name || audioDeviceLabel(h.id), '\u00b7 unplugged',
            'Restore', 'Show this device again if it comes back',
            () => { void toggleHidden(h.id, h.name, false); });
        }
      }
      if (!live.length && !orphans.length) {
        el('div', 'hint muted', { text: '(no devices found)' }, panel);
      }
    }
    if (mg && panel) {
      mg.addEventListener('click', async () => {
        const open = !panel.classList.toggle('hidden');
        mg.setAttribute('aria-expanded', String(open));
        if (!open) return;
        allCache = await loadAllAudioDevices(spec.flow);
        if (mg.isConnected) buildHiddenPanel();
      });
    }

    async function readLevels() {
      const r = await safe(() => api.audioLevels(spec.flow));
      if (!r || r.ok === false) return;
      if (!volBusy) { vol.value = String(r.volume); out.textContent = r.volume + '%'; mute.checked = !!r.muted; }
    }
    const writeVolume = () => {
      const v = +vol.value;
      clearTimeout(volIdle);
      volIdle = setTimeout(async () => {
        const r = await safe(() => api.audioSetVolume(spec.flow, { volume: v }));
        volBusy = false;
        if (!r.ok) { toast('Volume change failed: ' + (r.error || 'unknown'), true); readLevels(); }
      }, 160);
    };
    vol.addEventListener('input', () => {
      volBusy = true;                       // claim the row until the write lands
      clearTimeout(volIdle);
      out.textContent = vol.value + '%';
      volIdle = setTimeout(() => { volBusy = false; }, 1500);   // a gesture that never commits releases the claim
    });
    vol.addEventListener('change', writeVolume);
    mute.addEventListener('change', async () => {
      const want = mute.checked;
      const r = await safe(() => api.audioSetVolume(spec.flow, { muted: want }));
      if (!r.ok) { toast('Mute change failed: ' + (r.error || 'unknown'), true); mute.checked = !want; }
    });
    sel.addEventListener('change', async () => {
      const id = sel.value;
      if (!id) return;
      const r = await safe(() => api.audioSetDefault(spec.flow, id));
      if (!r.ok) {
        // Main's own line already says what happened; only the OS-wide refusal
        // needs a second door, and that door is named — never "(below)".
        const advice = r.code === 'policy_unavailable'
          ? ' \u2014 the Open Windows sound settings button at the bottom of this page can still try it'
          : '';
        toast('Could not switch the ' + spec.noun + ': ' + (r.error || 'unknown') + advice, true);
        console.log('[audio] set-default refused:', spec.flow, r.code || 'failed', r.detail || r.error || '');
        loadDevices(true);
        return;
      }
      toast('Default ' + spec.noun + ' switched');
      await Promise.all([loadDevices(true), readLevels()]);
    });
    rg.onclick = async () => {
      await Promise.all([loadDevices(true), readLevels()]);
      // The panel keeps its own (unfiltered) view — refresh it in step too.
      if (mg && panel && !panel.classList.contains('hidden')) {
        allCache = await loadAllAudioDevices(spec.flow);
        if (mg.isConnected) buildHiddenPanel();
      }
    };

    return { reload: async () => { await loadDevices(false); await readLevels(); }, readLevels };
  }
  const outCtl = wireDevice({ sel: '#au-out-select', refresh: '#au-out-refresh', manage: '#au-out-manage', panel: '#au-out-hidden', vol: '#au-out-vol', out: '#au-out-vol-out', mute: '#au-out-mute', flow: 'render', noun: 'output device' });
  const inCtl = wireDevice({ sel: '#au-in-select', refresh: '#au-in-refresh', manage: '#au-in-manage', panel: '#au-in-hidden', vol: '#au-in-vol', out: '#au-in-vol-out', mute: '#au-in-mute', flow: 'capture', noun: 'input device' });
  audioRefreshLevels = () => Promise.all([outCtl.readLevels(), inCtl.readLevels()]).then(() => {});

  /* ---- per-app mixer ---- rows keyed by pid (system-sounds keeps its own),
     diffed in place so a poll never yanks a slider out from under a drag.
     Labels are app-supplied text → textContent only, never innerHTML. */
  const sessHost = $('#au-sessions'), sessNote = $('#au-sessions-note');
  const rows = new Map();                 // rowKey -> row state
  let sessLoading = false;

  const rowKey = (s) => (s.isSystem ? 'sys:' + s.pid : 'app:' + s.pid);

  function makeRow(s) {
    const row = el('div', 'au-row' + (s.isSystem ? ' au-system' : ''), {}, sessHost);
    const name = el('span', 'au-name', {}, row);
    const slider = el('input', null, { type: 'range', min: '0', max: '100', step: '1', 'aria-label': 'App volume' }, row);
    const pct = el('span', 'au-pct', { text: '—' }, row);
    const muteBtn = el('button', 'btn small glyph au-mute', {
      type: 'button', title: 'Mute this app', 'aria-label': 'Mute this app', 'aria-pressed': 'false'
    }, row);
    el('span', 'g', { text: '\uE74E' }, muteBtn);           // in-brand speaker-off glyph
    const st = { el: row, name, slider, pct, muteBtn, busy: false, idle: null };

    slider.addEventListener('input', () => {
      st.busy = true;
      clearTimeout(st.idle);
      st.pct.textContent = slider.value + '%';
      st.idle = setTimeout(() => { st.busy = false; }, 1500);
    });
    slider.addEventListener('change', () => {
      const v = +slider.value;
      clearTimeout(st.idle);
      st.idle = setTimeout(async () => {
        const r = await safe(() => api.audioSetSession(s.pid, { volume: v }));
        st.busy = false;
        if (!r.ok) toast(r.error || 'App volume change failed', true);   // a vanished app's row drops on the next poll
      }, 160);
    });
    muteBtn.addEventListener('click', async () => {
      const want = muteBtn.getAttribute('aria-pressed') !== 'true';
      const r = await safe(() => api.audioSetSession(s.pid, { muted: want }));
      if (!r.ok) toast(r.error || 'App mute change failed', true);
    });
    return st;
  }

  function updateRow(st, s) {
    st.name.textContent = s.label;
    if (!s.isSystem && s.sessions > 1) el('span', 'au-count', { text: '×' + s.sessions }, st.name);
    st.slider.setAttribute('aria-label', 'Volume for ' + s.label);
    st.muteBtn.title = (s.isSystem ? 'System sounds' : s.label) + (s.muted ? ' — click to unmute' : ' — click to mute');
    if (!st.busy) {
      st.slider.value = String(s.volume);
      st.pct.textContent = s.volume + '%';
    }
    st.muteBtn.setAttribute('aria-pressed', String(!!s.muted));
  }

  audioRefreshSessions = async function refreshSessions() {
    if (sessLoading || !sessHost) return;
    sessLoading = true;
    const r = await safe(() => api.audioSessions());
    sessLoading = false;
    if (!r || r.ok === false) {
      if (sessNote) sessNote.textContent = (r && r.error) || 'Could not read the app volume list.';
      return;
    }
    if (sessNote) sessNote.textContent = r.sessions.length
      ? '' : 'Nothing is playing audio right now — a row appears the moment an app starts.';
    const seen = new Set();
    for (const s of r.sessions) {
      const key = rowKey(s);
      seen.add(key);
      let st = rows.get(key);
      if (!st) st = makeRow(s);
      updateRow(st, s);
      rows.set(key, st);
    }
    for (const [key, st] of rows) {
      if (!seen.has(key)) { st.el.remove(); clearTimeout(st.idle); rows.delete(key); }
    }
  };

  const refreshBtn = $('#au-refresh');
  if (refreshBtn) refreshBtn.onclick = async () => {
    await Promise.all([outCtl.reload(), inCtl.reload(), audioRefreshSessions()]);
  };

  onAudioTab = async () => {
    await Promise.all([outCtl.reload(), inCtl.reload(), audioRefreshSessions()]);
    startAudioPoll();
  };
  audioTabLeaveHook = stopAudioPoll;
}

/* --------------------------------- preview ---------------------------------
   "Configure live, not blind" means the preview must show the product's
   signature states — hover nudge, sibling dim, hub report. The overlay's
   interaction CSS lives in wheel.css (which the settings page never loads),
   so mirrored scoped rules for #wheel-preview carry them (see settings.css);
   hover is routed through the SAME hitTest the real wheel uses. buildWheel's
   `preview` flag suppresses the pop; click-firing is safe because no
   segment-click handler exists on this page. */
let previewBuilt = null;
let previewNav = null;
let previewHoverBound = false;

function bindPreviewHover() {
  if (previewHoverBound) return;
  previewHoverBound = true;
  const host = $('#wheel-preview');
  host.addEventListener('mousemove', (e) => {
    if (!previewBuilt) return;
    const svg = host.querySelector('svg');
    if (!svg) return;
    const rct = svg.getBoundingClientRect();
    const hit = previewBuilt.hitTest(e.clientX - rct.left, e.clientY - rct.top);
    const seg = hit && hit.seg ? hit.seg : null;
    previewBuilt.setHover(seg);
    const rootG = svg.querySelector('.wheel-root');
    if (rootG) rootG.classList.toggle('any-hover', !!seg);
    // same dwell state machine the overlay uses — folder fans demo live
    if (previewNav) previewNav.feed(seg, !!hit);
  });
  host.addEventListener('mouseleave', () => {
    if (!previewBuilt) return;
    previewBuilt.setHover(null);
    const rootG = $('#wheel-preview .wheel-root');
    if (rootG) rootG.classList.remove('any-hover');
    if (previewNav) previewNav.feed(null, false);
  });
  // Clicking a folder plate in the preview opens/collapses its branch — the
  // preview fires no actions (no segment-click handler on this page), so the
  // fan is demoable without side effects.
  host.addEventListener('click', (e) => {
    if (!previewBuilt || !previewNav) return;
    const svg = host.querySelector('svg');
    if (!svg) return;
    const rct = svg.getBoundingClientRect();
    const hit = previewBuilt.hitTest(e.clientX - rct.left, e.clientY - rct.top);
    if (hit && hit.seg) previewNav.toggle(hit.seg);
  });
}

function renderPreview() {
  const host = $('#wheel-preview');
  const avail = Math.min(host.clientWidth, host.clientHeight) - 20;
  const need = cfg.appearance.outerRadius * 2 + 52;
  const scale = Math.min(1, Math.max(0.3, avail / need));
  previewBuilt = buildWheel(host, { ...cfg, rings: ringsModel() }, { preview: true, scale, iconImages: imgCache });
  previewNav = createFlyoutNavigator(previewBuilt, {
    dwellMs: cfg.behavior && cfg.behavior.flyoutDwellMs,
    // The preview box may need to breathe past the wheel rim when a fan
    // branches; CSS overflow handles it, no window involved.
    onGrow: () => { host.classList.add('fan-out'); }
  });
  bindPreviewHover();
}

/* ---------------------------------- boot ----------------------------------- */
function renderAll() {
  ensureAllIcons();
  renderProfileBar();
  renderSegments();
  renderAppearance();
  applyChrome();
  renderThemes();
  wireBehaviorCheckboxes();
  updateHotkeyChip();
  renderPreview();
}

/* --------------------- external-change reconciliation ----------------------
   "Edits are watched live" must be true in both directions. An external
   config.json edit (or tray reload) that arrives mid-typing used to be
   swallowed by `if (dirty) return` and then silently clobbered at persist.
   Now: apply it when clean; queue it when dirty and, once our own save
   settles, hand the choice to the user instead of picking a winner. */
let storeRev = null;          // the store revision our cfg copy is based on
let pendingExternal = null;   // queued { config, rev } from a reload while dirty

function showConflict() {
  const w = $('#cfg-conflict');
  if (!w) { pendingExternal = null; return; }
  w.classList.remove('hidden');
}

async function resolveConflict(keepMine) {
  const theirs = pendingExternal;
  pendingExternal = null;
  const w = $('#cfg-conflict');
  if (w) w.classList.add('hidden');
  if (!theirs) return;
  if (keepMine) {
    // Our version wins: force-write our state over the disk copy.
    dirty = true;
    await persist();
  } else {
    // The disk wins: adopt it — with the usual mercy, one catchable undo.
    const mine = clone(cfg);
    cfg = theirs.config;
    storeRev = theirs.rev;
    dirty = false;
    renderAll();
    toast('Loaded the on-disk config', false, async () => {
      cfg = mine; dirty = true;
      renderAll();
      await persist();
    });
  }
}

function wireConflict() {
  const mine = $('#cfg-conflict-mine');
  const disk = $('#cfg-conflict-theirs');
  if (mine) mine.onclick = () => { resolveConflict(true); };
  if (disk) disk.onclick = () => { resolveConflict(false); };
}

async function boot() {
  api.env?.().then((e) => { if (e && e.vibrant) document.documentElement.dataset.vibrant = '1'; });
  const r = await api.getConfig();
  try {
    const a = await api.getAutostart();
    if (a && a.allowed === false) autostartAllowed = false;
  } catch { /* leave the checkbox usable; set() reports a real failure */ }
  cfg = r.config;
  storeRev = typeof r.rev === 'number' ? r.rev : null;
  sysCatalogCache = await api.sysCatalog();
  appSettingsCatalogCache = await api.appSettingsCatalog();
  renderAll();
  setSaveState('Saved');
  wireAdvanced();
  wireAudio();
  wireConflict();
  wireConfigWarn(r);
  if (r.hotkeyError) showHkError(r.hotkeyError);
  if (r.importedFrom) toast('Settings imported from your previous (legacy) config', false, null, 5000);
  api.onConfigChanged((payload) => {
    // main broadcasts only genuine reloads (file watch / tray), as { config, rev }
    const newCfg = payload && payload.config !== undefined ? payload.config : payload;
    const rev = payload && typeof payload.rev === 'number' ? payload.rev : null;
    if (rev !== null && storeRev !== null && rev === storeRev) return;      // echo of our own save
    if (dirty) {                                                             // mid-edit — queue, reconcile after save
      pendingExternal = { config: newCfg, rev };
      return;
    }
    if (JSON.stringify(cfg) === JSON.stringify(newCfg)) {                    // content already matches — just adopt the revision
      if (rev !== null) storeRev = rev;
      return;
    }
    if (rev !== null) storeRev = rev;
    pendingExternal = null;
    cfg = newCfg;
    renderAll();                                                             // genuine external change
  });
  // Flush the 450 ms autosave when this page goes away for good (app quit
  // destroys the window before the debounce fires — those last keystrokes
  // would be lost). A synchronous send() still lands in main at this point;
  // an invoke could not.
  const flushOnExit = () => { if (dirty && cfg) { dirty = false; api.flushConfig(clone(cfg)); } };
  window.addEventListener('pagehide', flushOnExit);
  window.addEventListener('beforeunload', flushOnExit);
  window.addEventListener('resize', () => renderPreview());
}

function wireConfigWarn(r) {
  const w = $('#cfg-warn');
  if (!w) return;
  if (!r.broken) { w.classList.add('hidden'); return; }
  $('#cfg-warn-folder').onclick = () => api.openConfigFolder();
  $('#cfg-warn-x').onclick = () => w.classList.add('hidden');
  w.classList.remove('hidden');
}
boot();
