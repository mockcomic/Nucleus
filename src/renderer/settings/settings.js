import { buildWheel } from '../shared/wheel-core.js';
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

function ringKeys(c = cfg) {
  const ns = Object.keys((c && c.rings) || {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  return (ns.length ? ns : [1, 2]).map(String);
}
function ringItems(c = cfg) {
  return ringKeys(c).flatMap((k) => (c.rings && Array.isArray(c.rings[k]) ? c.rings[k] : []));
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
  const r = await api.setConfig(cfg);
  if (r.ok) {
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
    toast('Could not save: ' + (r.error || 'unknown'), true);
  }
}

/* -------------------------------- tabs ------------------------------------ */
const tabBtns = [...document.querySelectorAll('.tab-btn')];
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
   caches the bytes on disk). null = resolved-and-failed, so we don't retry
   every keystroke while offline. */
const imgCache = new Map();
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
  if (item.iconImage && !imgCache.has(item.iconImage)) requestIconImage(item.iconImage);
}

function requestIconImage(slug) {
  if (imgCache.has(slug)) return Promise.resolve(imgCache.get(slug));
  if (iconPending.has(slug)) return Promise.resolve(null);
  iconPending.add(slug);
  return api.iconDataUrl(slug).then((r) => {
    iconPending.delete(slug);
    const url = r && r.ok ? r.dataUrl : null;
    imgCache.set(slug, url);
    refreshIconSpans();
    renderPreview();
    return url;
  }, () => {
    iconPending.delete(slug);
    if (!imgCache.has(slug)) imgCache.set(slug, null);
    return null;
  });
}

function refreshIconSpans() {
  for (const { span, item, fallback } of liveIconSpans) if (span.isConnected) fillIconSpan(span, item, fallback);
}

function ensureAllIcons() {
  if (!cfg) return;
  for (const it of ringItems()) if (it.iconImage) requestIconImage(it.iconImage);
}

/* ------------------------------- segments --------------------------------- */
const TYPE_OPTIONS = [
  ['app', 'app — launch program'], ['url', 'url — open link'], ['file', 'file — open file'],
  ['command', 'command — shell command / script'], ['macro', 'macro — keystrokes'], ['sys', 'sys — Windows action']
];

/* What goes in the value box, per type — a single "Target" label asked the user
   to guess; each type now names its own parameter. */
const TARGET_LABELS = { app: 'Program', url: 'Link', file: 'File', command: 'Command', macro: 'Keys', sys: 'Action' };

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
  const keys = ringKeys();
  const N = keys.length;
  for (const ring of keys) {
    if (!cfg.rings[ring]) cfg.rings[ring] = [];
    const sec = el('div', 'ring-sec', {}, host);
    const head = el('div', 'ring-head', {}, sec);
    el('h3', null, { text: ringTitle(ring, N) }, head);
    el('span', 'muted', { text: `${cfg.rings[ring].length} segment(s)` }, head);
    const add = el('button', 'btn small', { text: '+ Add' }, head);
    add.onclick = () => {
      const item = { id: crypto.randomUUID(), label: 'New item', icon: '', iconImage: '', type: 'app', value: '', color: null };
      cfg.rings[ring].push(item);
      openEditorKey = `${ring}-${cfg.rings[ring].length - 1}`;
      touch();
      // touch() rerendered synchronously — land the caret in the new row's Label box
      // so the user can type the name right away (and pre-select "New item" to replace it).
      const lbl = document.querySelector('.seg-edit input');
      if (lbl) { lbl.focus(); lbl.select(); }
    };
    if (ring === keys[N - 1] && N >= 3) {
      const rm = el('button', 'btn small glyph', { text: '\uE75D', title: 'Remove this ring', 'aria-label': 'Remove ' + ringTitle(ring, N) }, head);
      rm.onclick = () => removeRing(ring);
    }
    if (!cfg.rings[ring].length) {
      el('div', 'empty-hint muted', { text: 'Empty — this ring won\u2019t render.' }, sec);
      continue;
    }
    const list = el('div', 'seg-list', {}, sec);
    cfg.rings[ring].forEach((item, i) => list.appendChild(segRow(ring, item, i)));
  }
  if (N < MAX_RINGS) {
    const addRing = el('button', 'btn', { text: '+ Add ring', title: `Add ring ${N + 1} (outermost)` }, host);
    addRing.style.marginTop = '4px';
    addRing.onclick = () => {
      cfg.rings[String(N + 1)] = [];
      touch();
      toast(`Ring ${N + 1} added — its segments sit outside the current outer ring`, false, () => {
        if ((cfg.rings[String(N + 1)] || []).length) return;   // in use — keep it
        delete cfg.rings[String(N + 1)];
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
  const items = cfg.rings[ring] || [];
  const inner = cfg.rings[String(Number(ring) - 1)];
  if (items.length && inner.length + items.length > 24) {
    toast(`Can\u2019t fold ${items.length} segments into the ring below (max 24) — move or delete some first`, true);
    return;
  }
  delete cfg.rings[ring];
  inner.push(...items);
  if (openEditorKey && openEditorKey.startsWith(ring + '-')) openEditorKey = null;
  touch();
  const moved = items.slice();
  toast(`Removed ${ringTitle(ring, ringKeys().length + 1)}`, false, () => {
    for (const it of moved) {
      const k = inner.indexOf(it);
      if (k >= 0) inner.splice(k, 1);        // pull the migrated items back
    }
    cfg.rings[ring] = moved;                  // and re-raise the ring
    touch();
  });
}

const GUARDED_TYPES = new Set(['command', 'macro', 'sys']);

function segRow(ring, item, i) {
  const row = el('div', 'seg-row');
  row.dataset.segKey = `${ring}-${i}`;
  const main = el('div', 'seg-main', {}, row);
  const key = `${ring}-${i}`;

  // Proper disclosure button (mouse click on the row also opens the editor below).
  const disc = el('button', 'btn mini seg-disc', {
    title: openEditorKey === key ? 'Close editor' : 'Edit segment',
    'aria-label': `Edit segment ${item.label || '(no name)'}`,
    'aria-expanded': String(openEditorKey === key)
  }, main);
  el('span', 'g', { text: '\uE70D' }, disc);   // ChevronDown

  const icoSpan = el('span', 'seg-ico', {}, main);
  registerIconSpan(icoSpan, item, item.icon || (item.type === 'sys' ? '\uE713' : '\uE76C'));
  el('span', 'seg-name', { text: item.label || '(no name)' }, main);
  el('span', 'seg-type', { text: item.type }, main);
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
    const a = cfg.rings[ring];
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
    });
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('blur', stop);
    // the row rerenders mid-hold (touch() rebuilds it), so listen on window —
    // the button that started the hold may already be gone when the mouse lets go
    window.addEventListener('pointerup', () => stop(), { once: true });
  };
  holdRepeat(mini('\uE74A', 'Move earlier', () => stepMove(-1), '', 'Move earlier — hold to keep moving'), -1);
  holdRepeat(mini('\uE74B', 'Move later', () => stepMove(1), '', 'Move later — hold to keep moving'), 1);
  // One hairline separates the transport pair from the live-action pair —
  // the slip-guard margins were conceding the mis-click; this resolves it.
  el('span', 'act-sep', { 'aria-hidden': 'true' }, acts);
  // Play can fire arbitrary shell commands, injected keystrokes, or lock/sleep
  // — those require a deliberate second click, not a slip from Delete.
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
  mini('\uE75D', 'Delete segment', () => {   // Trash (E894 stays reserved for clear/close)
    if (ringItems().length <= 1) {
      toast('The wheel needs at least one segment', true);
      return;
    }
    // Inverse-op undo: the item goes back exactly where it was, and every
    // edit made AFTER the delete survives. (Graph-swap undos silently ate
    // unrelated later work — the critique's P1.)
    const from = cfg.rings[ring];
    const idx = from.indexOf(item);
    from.splice(idx, 1);
    touch();
    toast(`Removed “${item.label}”`, false, () => {
      const cur = cfg.rings[ring];
      if (cur.some((x) => x.id === item.id)) return;   // already restored meanwhile
      cur.splice(Math.min(idx, cur.length), 0, item);
      touch();
    });
  }, 'act-del');

  const toggleEditor = () => {
    openEditorKey = openEditorKey === key ? null : key;
    renderSegments();
    const f = document.querySelector('.seg-edit');
    if (f) f.querySelector('input')?.focus();
    else document.querySelector(`[data-seg-key="${key}"] .seg-disc`)?.focus();
  };
  disc.onclick = (e) => { e.stopPropagation(); toggleEditor(); };
  main.addEventListener('click', toggleEditor);

  if (openEditorKey === key) row.appendChild(segEditor(ring, item));
  return row;
}

function sysLabel(id) {
  const c = sysEntry(id);
  return c ? c.label : id;
}

function sysEntry(id) {
  return (sysCatalogCache || []).find((x) => x.id === id) || null;
}

/* Row caption: the File Explorer action additionally shows the picked folder's
   leaf name, so a wheel with several Explorer segments stays readable. */
function sysDisplayText(item) {
  const label = sysLabel(item.value);
  if (item.value === 'explorer' && item.dir) {
    const leaf = String(item.dir).replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (leaf) return `${label} — ${leaf}`;
  }
  return label;
}

/* Collapsed-row caption for every type: the sys display text, or the target
   plus (for app items) the launch parameters, so a set Arguments box is
   visible without opening the editor. */
function rowValueText(item) {
  if (item.type === 'sys') return sysDisplayText(item);
  if (item.type === 'app' && String(item.args || '').trim()) return item.value + '  ' + String(item.args).trim();
  return item.value;
}

let sysCatalogCache = null;

function segEditor(ring, item) {
  const f = el('div', 'seg-edit');
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

  el('label', null, { text: 'Label', for: uid + '-label' }, f);
  const labelBox = el('div', null, { style: 'display:flex;align-items:center;gap:12px;min-width:0' }, f);
  const inLabel = bind(el('input', null, { type: 'text', maxlength: '40', value: item.label, id: uid + '-label' }), (e) => item.label = e.value);
  inLabel.style.flex = '1';
  inLabel.style.minWidth = '0';
  labelBox.appendChild(inLabel);
  const hideLb = el('label', 'chk', { title: 'Show this segment as icon only — hides its label on the wheel' }, labelBox);
  const chkHide = el('input', null, { type: 'checkbox', 'aria-label': 'Hide label on wheel' }, hideLb);
  el('span', null, { text: 'Hide label' }, hideLb);
  chkHide.checked = !!item.hideLabel;
  chkHide.addEventListener('change', () => { item.hideLabel = chkHide.checked; touch(false); });

  el('label', null, { text: 'Type', for: uid + '-type' }, f);
  const selType = el('select', null, { id: uid + '-type' }, f);
  for (const [v, t] of TYPE_OPTIONS) el('option', null, { value: v, text: t }, selType);
  selType.value = item.type;
  selType.addEventListener('change', () => {
    const oldType = item.type;
    item.type = selType.value;
    // Each type owns a disjoint value namespace — carrying an old one over
    // left the parameter box showing a sys catalog id as "Keys" (and an
    // unknown id parked in the Action select at selectedIndex -1).
    if (item.type === 'sys') {
      if (!(sysCatalogCache || []).some((c) => c.id === item.value)) {
        item.value = (sysCatalogCache && sysCatalogCache[0] && sysCatalogCache[0].id) || '';
      }
    } else if (oldType === 'sys') {
      item.value = '';
      item.dir = '';                                 // the folder slot is sys-only
    } else if (oldType === 'app') {
      item.args = '';                                // the arguments slot is app-only
    }
    touch();                                     // rebuilds the editor for the new type
    const ed = document.querySelector('.seg-edit');
    ed?.querySelector('select')?.focus();        // keep the keyboard in the editor
  });

  const labTarget = el('label', null, { text: TARGET_LABELS[item.type] || 'Target' }, f);
  if (item.type === 'sys') {
    const sel = el('select', null, { id: uid + '-target' }, f);
    labTarget.setAttribute('for', uid + '-target');
    for (const c of (sysCatalogCache || [])) el('option', null, { value: c.id, text: `${c.group} — ${c.label}` }, sel);
    sel.value = item.value;
    sel.addEventListener('change', () => {
      const wasDir = !!(sysEntry(item.value) || {}).hasDir;
      item.value = sel.value;
      const isDir = !!(sysEntry(item.value) || {}).hasDir;
      if (!isDir) item.dir = '';                     // folder slot belongs to explorer only
      syncRowText();
      // The Folder field appears/vanishes with the action — rebuild the editor
      // (touch()) so it stays in sync; otherwise save without a rerender.
      if (isDir !== wasDir) touch(); else touch(false);
    });
    if ((sysEntry(item.value) || {}).hasDir) {
      el('label', null, { text: 'Folder', for: uid + '-dir' }, f);
      const rowd = el('div', null, { style: 'display:flex;gap:6px;grid-column:span 2' }, f);
      const inD = bind(el('input', null, {
        type: 'text', value: item.dir || '', id: uid + '-dir',
        placeholder: 'Leave empty for the default (Quick access)'
      }), (e) => item.dir = e.value);
      inD.style.flex = '1';
      inD.style.minWidth = '0';
      rowd.appendChild(inD);
      const bd = el('button', 'btn small', { text: 'Browse…' }, rowd);
      bd.onclick = async (ev) => {
        ev.stopPropagation();
        const p = await api.pickFile({ title: 'Choose a folder', directory: true });
        if (p) { item.dir = p; syncRowText(); touch(); }
      };
      const hint = el('div', 'hint', {
        text: 'The folder File Explorer opens in. Empty opens the default view.'
      }, f);
      hint.style.gridColumn = '1 / -1';
      hint.style.marginTop = '-2px';
    }
  } else {
    const rowv = el('div', null, { style: 'display:flex;gap:6px;grid-column:span 2' }, f);
    const inV = bind(el('input', null, { type: 'text', value: item.value, placeholder: valueHint(item.type), id: uid + '-target' }), (e) => item.value = e.value);
    labTarget.setAttribute('for', uid + '-target');
    rowv.appendChild(inV);
    const browseOpts = BROWSE_OPTS[item.type];
    if (browseOpts) {
      const b = el('button', 'btn small', { text: 'Browse…' }, rowv);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const p = await api.pickFile(browseOpts);
        if (p) { item.value = p; touch(); }
      };
    }
    if (item.type === 'app') {
      el('label', null, { text: 'Arguments', for: uid + '-args' }, f);
      const rowa = el('div', null, { style: 'display:flex;gap:6px;grid-column:span 2' }, f);
      const inA = bind(el('input', null, {
        type: 'text', value: item.args || '', maxlength: '2048',
        placeholder: valueHint('args'), id: uid + '-args',
        'aria-label': 'Launch parameters passed to the program'
      }), (e) => item.args = e.value);
      inA.style.flex = '1';
      inA.style.minWidth = '0';
      rowa.appendChild(inA);
      const hintA = el('div', 'hint', {
        text: 'Passed to the program when it starts — quote parameters that contain spaces.'
      }, f);
      hintA.style.gridColumn = '1 / -1';
      hintA.style.marginTop = '-2px';
    }
    if (item.type === 'command') {
      // Say what the box takes — cmd.exe syntax vs. a picked script file.
      const hint = el('div', 'hint', {
        html: 'Type it exactly as in <b>Command Prompt</b>, or use Browse… to pick a <code>.bat</code> / <code>.cmd</code> / <code>.ps1</code> file — the chosen path runs like a double-click.'
      }, f);
      hint.style.gridColumn = '1 / -1';
      hint.style.marginTop = '-2px';
    }
    if (item.type === 'app') appCombo(item, inV, f);
  }

  el('label', null, { text: 'Icon' }, f);
  const iconBox = el('div', null, { style: 'display:flex;align-items:center;gap:8px' }, f);
  const iconPrev = el('span', 'seg-ico', {}, iconBox);
  registerIconSpan(iconPrev, item, item.icon || '—');
  iconPrev.style.color = item.icon ? 'var(--accent)' : 'var(--dim)';
  const pick = el('button', 'btn small', { text: 'Choose…' }, iconBox);
  pick.onclick = () => openIconModal(item, pick);
  const clr = el('button', 'btn small glyph', { text: '\uE894', title: 'Clear icon', 'aria-label': 'Clear icon' }, iconBox);
  clr.onclick = () => { item.icon = ''; renderSegments(); touch(); };

  el('label', null, { text: 'Color' }, f);
  const colorBox = el('div', null, { style: 'display:flex;align-items:center;gap:8px' }, f);
  const chkAuto = el('input', null, { type: 'checkbox' }, colorBox);
  chkAuto.checked = !item.color;
  el('span', 'muted', { text: 'auto' }, colorBox).style.fontSize = '12px';
  const colIn = el('input', null, { type: 'color', value: item.color || cfg.appearance.colors[Number(ring) % 2 === 1 ? 'ring1' : 'ring2'] }, colorBox);
  chkAuto.addEventListener('change', () => { item.color = chkAuto.checked ? null : colIn.value; touch(false); });
  colIn.addEventListener('input', () => { if (!chkAuto.checked) { item.color = colIn.value; touch(false); } });

  el('label', null, { text: 'Ring' }, f);
  const ringBox = el('div', null, { style: 'display:flex;gap:12px;align-items:center;flex-wrap:wrap' }, f);
  const allKeys = ringKeys();
  for (const r of allKeys) {
    const lb = el('label', 'chk', {}, ringBox);
    const rb = el('input', null, { type: 'radio', name: 'ringpick-' + item.id }, lb);
    rb.checked = String(ring) === r;
    rb.addEventListener('change', () => {
      if (rb.checked && String(ring) !== r) {
        if (cfg.rings[r].length >= 24) {   // config.js cleanRing cap
          const cur = ringBox.querySelector(`input[value="${ring}"]`);
          if (cur) cur.checked = true;
          toast(`Ring ${r} holds at most 24 segments`, true);
          return;
        }
        const from = cfg.rings[ring];
        const idx = from.indexOf(item);
        from.splice(idx, 1);
        cfg.rings[r].push(item);
        openEditorKey = null;
        touch();
        // Inverse-op undo — returns the item to its old ring and position;
        // later edits made after the move survive.
        const t = ringRadioLabel(r, allKeys);
        const dest = (t === 'inner' || t === 'outer') ? `the ${t} ring` : t;
        toast(`Moved “${item.label || '(no name)'}” to ${dest}`, false, () => {
          const cur = cfg.rings[r];
          const k = cur.indexOf(item);
          if (k < 0) return;                        // moved on — inverse op is a no-op
          cur.splice(k, 1);
          const back = cfg.rings[ring] || (cfg.rings[ring] = []);
          back.splice(Math.min(idx, back.length), 0, item);
          touch();
        });
      }
    });
    rb.value = r;
    lb.appendChild(document.createTextNode(ringRadioLabel(r, allKeys)));
  }
  const dup = el('button', 'btn small', { type: 'button', text: 'Duplicate', title: 'Copy this segment into the next position' }, ringBox);
  dup.onclick = (e) => {
    e.stopPropagation();
    const a = cfg.rings[ring];
    if (a.length >= 24) { toast('A ring holds at most 24 segments', true); return; }   // config.js cleanRing cap
    const copy = { ...clone(item), id: crypto.randomUUID() };
    a.splice(a.indexOf(item) + 1, 0, copy);
    openEditorKey = null;
    touch();
    toast(`Duplicated “${item.label || '(no name)'}”`, false, () => {
      const cur = cfg.rings[ring];
      const k = cur.findIndex((x) => x.id === copy.id);
      if (k >= 0) { cur.splice(k, 1); touch(); }
    });
  };
  return f;
}

/* ---------------- installed-programs dropdown (type: app) ----------------- */
let appsCache = null;   // { loading, items }

function appCombo(item, inV, f) {
  const host = el('div', null, { style: 'grid-column:1 / -1;position:relative' }, f);
  const row = el('div', 'row-line', { style: 'margin-top:2px' }, host);
  el('span', 'muted', { text: 'Installed programs' }, row).style.fontSize = '12px';
  const search = el('input', null, { type: 'text', placeholder: 'Start typing to search…  (▾ opens the full list)', 'aria-label': 'Search installed programs', role: 'combobox', 'aria-autocomplete': 'list', 'aria-controls': `list-${item.id}` }, row);
  search.style.flex = '1';
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
    if (appsCache && appsCache.loading) { el('div', 'combo-empty muted', { text: 'Scanning installed programs…', role: 'presentation' }, list); return; }
    const all = (appsCache && appsCache.items) || [];
    const shown = (q ? all.filter((a) => a.name.toLowerCase().includes(q) || a.path.toLowerCase().includes(q)) : all).slice(0, 120);
    if (!shown.length) { el('div', 'combo-empty muted', { text: q ? 'No installed program matches “' + q + '” — keep typing, or Browse… for an exact path.' : 'No installed programs found.' }, list); return; }
    shown.forEach((a, idx) => {
      const r = el('div', 'combo-row', { role: 'option', 'aria-selected': 'false', id: `opt-${item.id}-${idx}` }, list);
      el('span', 'cr-name', { text: a.name }, r);
      el('span', 'cr-cat', { text: a.category }, r);
      el('span', 'cr-path', { text: a.path }, r);
      r.addEventListener('mousedown', (ev) => { ev.preventDefault(); pick(a); });
      rows.push(r);
    });
    el('div', 'combo-foot muted', { text: `${shown.length} of ${all.length} — click to fill “Target”` }, list);
  }

  function pick(a) {
    item.value = a.path; inV.value = a.path;
    list.classList.add('hidden');
    touch(false);
    toast(`Target set to ${a.name}`);
  }
  function showList() { ensureLoaded(); renderList(); }
  async function ensureLoaded(force) {
    if (appsCache && !force) return;
    appsCache = { loading: true, items: [] };
    renderList();
    const items = await api.installedApps(!!force);
    appsCache = { loading: false, items };
    renderList();
  }

  search.addEventListener('focus', () => { ensureLoaded(); list.classList.remove('hidden'); renderList(); });
  search.addEventListener('input', () => { list.classList.remove('hidden'); renderList(); });
  search.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 180));
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

function valueHint(type) {
  return {
    app: 'notepad.exe  or  C:\\Path\\to\\app.exe',
    args: '--flag  "C:\\path with space"',
    url: 'https://…', file: 'C:\\Path\\to\\file.pdf',
    command: 'taskkill /f /im foo.exe   or   C:\\Scripts\\cleanup.bat', macro: 'ctrl+c, wait=0.2, ctrl+v'
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
  for (const it of ringItems())
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
  $('#di-status').textContent = (item.label || '').trim()
    ? `Press Enter or “Search” to look for a “${(item.label || '').trim()}” logo, or pick a glyph below.`
    : 'Type a term and press Enter to search for a logo, or pick a glyph below.';
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
  const status = $('#di-status');
  const my = ++diSeq;
  grid.innerHTML = '';
  if (!q) {
    status.textContent = 'Type a search term (usually the app name) and press Enter.';
    grid.classList.add('hidden');
    return;
  }
  status.textContent = 'Searching dashboardicons.com…';
  grid.classList.remove('hidden');
  let r = null;
  try { r = await api.searchIcons(q); } catch { /* surfaced below */ }
  if (my !== diSeq) return;                     // a newer search won the race
  if (!r || !r.ok) { status.textContent = 'Search failed — check the connection and retry.'; return; }
  const results = r.results || [];
  if (!results.length) { status.textContent = `No icons match “${q}” — try a different term.`; return; }
  status.textContent = `${results.length} match${results.length > 1 ? 'es' : ''}${r.offline ? ' (cached catalog)' : ''} — click one to use it.`;
  for (const res of results) {
    const cell = el('button', 'icon-cell di-cell', { 'aria-label': `Use the ${res.slug} logo` }, grid);
    const im = el('img', 'di-thumb', { src: res.url, alt: '', loading: 'lazy' }, cell);
    im.addEventListener('error', () => cell.remove());   // dead CDN link — drop that candidate
    el('span', 'n', { text: res.slug }, cell);
    cell.onclick = () => pickDashboardIcon(res);
  }
}

async function pickDashboardIcon(res) {
  if (!iconModalTarget) return;
  $('#di-status').textContent = `Downloading “${res.slug}”…`;
  const r = await api.fetchIcon(res.slug);
  if (!r || !r.ok) { $('#di-status').textContent = (r && r.error) || 'Download failed — try again.'; return; }
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
  toast('Logo removed — the glyph shows instead');
};

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

function renderAppearance() {
  const host = $('#appearance-controls');
  host.innerHTML = '';
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
    // Only the preview needs the new value — never rerender the segment rows per drag frame.
    r.addEventListener('input', () => { cfg.appearance[key] = parseFloat(r.value); out.textContent = r.value; fill(); renderPreview(); });
    r.addEventListener('change', () => touch(false));
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
      ringKeys().map((k, i) => [k, ring(cfg.rings && cfg.rings[k], i === 0 ? 6 : 10)])
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
      while (taken.has(name.toLowerCase())) name = (raw + ' (' + n++).slice(0, 24);
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
function fmtHotkey(spec) {
  const nice = { ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', win: 'Win', space: 'Space', esc: 'Esc', enter: 'Enter', pgup: 'PgUp', pgdn: 'PgDn' };
  return String(spec || '').split('+').map((t) => nice[t] || (t.length === 1 ? t.toUpperCase() : t[0].toUpperCase() + t.slice(1))).join(' + ');
}
function updateHotkeyChip() { $('#hk-display').textContent = fmtHotkey(cfg.hotkey); }
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

const HK_KEYS = {
  ' ': 'space', Enter: 'enter', Tab: 'tab', Escape: 'esc', Backspace: 'backspace',
  Delete: 'delete', Insert: 'insert', Home: 'home', End: 'end', PageUp: 'pgup', PageDown: 'pgdn',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down'
};

window.addEventListener('keydown', async (e) => {
  if (!recording) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { stopRecording(); return; }
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return;   // wait for the main key
  let key = HK_KEYS[e.key];
  if (!key && /^F([1-9]|1[0-9]|2[0-4])$/i.test(e.key)) key = e.key.toLowerCase();
  if (!key && e.key.length === 1 && /[a-z0-9]/i.test(e.key)) key = e.key.toLowerCase();
  if (!key) { toast('Unsupported key: ' + e.key, true); return; }
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('win');
  if (!mods.length) { toast('Add at least one modifier (Ctrl/Alt/Shift/Win)', true); return; }
  const spec = [...mods, key].join('+');
  const r = await api.setHotkey(spec);
  if (r.ok) { cfg.hotkey = spec; updateHotkeyChip(); showHkError(null); toast(`Hotkey set to ${fmtHotkey(spec)}`); }
  else { showHkError(r.error); toast(r.error, true, null, 5000); }
  stopRecording();
}, true);

function stopRecording() {
  recording = false;
  $('#recorder-btn').textContent = 'Change…';
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

function wireBehaviorCheckboxes() {
  const map = {
    'autostart-chk': ['behavior', 'autostart'],
    'bh-esc': ['behavior', 'dismissOnEscape'],
    'bh-right': ['behavior', 'dismissOnRightClick'],
    'bh-retrigger': ['behavior', 'reTriggerToggles']
  };
  for (const [id, [sec, key]] of Object.entries(map)) {
    const c = $('#' + id);
    c.checked = cfg[sec][key];
    c.onchange = async () => {
      cfg[sec][key] = c.checked;
      if (sec === 'behavior' && key === 'autostart') {
        const r = await api.setAutostart(c.checked);
        if (!r.ok) { toast('Autostart failed: ' + r.error, true); c.checked = !c.checked; return; }
        toast(r.verified ? 'Startup registration confirmed' : 'Saved (could not verify login item)');
      }
      touch(false);
    };
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
  $('#ap-showlabels').checked = cfg.appearance.showLabels;
  $('#ap-showlabels').onchange = (e) => { cfg.appearance.showLabels = e.target.checked; renderPreview(); touch(false); };
  const cl = $('#ap-centerlabel');
  cl.value = cfg.appearance.centerLabel;
  cl.oninput = () => { cfg.appearance.centerLabel = cl.value; touch(false); };   // preview live AND persist (touch(false) rerenders the preview without the row-list rebuild)
  $('#btn-test').onclick = async () => { await api.testWheel(); };                   // onclick, not addEventListener: never stacks across rerenders
}

/* -------------------------------- advanced --------------------------------- */
async function restoreConfig(snapshot) {
  const u = await api.setConfig(snapshot);
  if (u.ok) {
    cfg = clone(u.config); dirty = false;
    renderAll();
    showHkError(u.hotkeyError || null);
    toast('Previous config restored');
  } else {
    toast('Could not undo: ' + (u.error || 'unknown'), true);
  }
}

async function wireAdvanced() {
  $('#ver').textContent = 'v' + (await api.appVersion());
  $('#btn-export').onclick = async () => { const r = await api.exportConfig(); if (r.ok) toast('Exported to ' + r.path); };
  $('#btn-import').onclick = async () => {
    const snapshot = clone(cfg);
    const r = await api.importConfig();
    if (r.ok) {
      cfg = clone(r.config); dirty = false;
      renderAll();
      showHkError(r.hotkeyError || null);          // never let the chip claim a combo that failed to register
      toast('Config imported', false, async () => { await restoreConfig(snapshot); });
    } else if (!r.canceled) toast(r.error, true);
  };
  $('#btn-reset').onclick = async () => {
    const snapshot = clone(cfg);
    const r = await api.resetConfig();
    if (r.ok) {
      cfg = clone(r.config); dirty = false;
      renderAll();
      showHkError(r.hotkeyError || null);
      toast('Settings reset to defaults', false, async () => { await restoreConfig(snapshot); });
    }
  };
  $('#btn-openfolder').onclick = () => api.openConfigFolder();
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
        if (quit.isConnected) { quitArmed = false; quit.textContent = 'Exit Radial Wheel'; quit.classList.remove('armed'); }
      }, 3000);
      return;
    }
    api.requestQuit();
  };
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
  });
  host.addEventListener('mouseleave', () => {
    if (!previewBuilt) return;
    previewBuilt.setHover(null);
    const rootG = $('#wheel-preview .wheel-root');
    if (rootG) rootG.classList.remove('any-hover');
  });
}

function renderPreview() {
  const host = $('#wheel-preview');
  const avail = Math.min(host.clientWidth, host.clientHeight) - 20;
  const need = cfg.appearance.outerRadius * 2 + 52;
  const scale = Math.min(1, Math.max(0.3, avail / need));
  previewBuilt = buildWheel(host, cfg, { preview: true, scale, iconImages: imgCache });
  bindPreviewHover();
}

/* ---------------------------------- boot ----------------------------------- */
function renderAll() {
  ensureAllIcons();
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
  cfg = r.config;
  storeRev = typeof r.rev === 'number' ? r.rev : null;
  sysCatalogCache = await api.sysCatalog();
  renderAll();
  setSaveState('Saved');
  wireAdvanced();
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
