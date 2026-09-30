import { buildWheel } from '../shared/wheel-core.js';
import { ICON_CATALOG } from '../shared/icon-catalog.js';

const api = window.wheelAPI;
const $ = (s, r = document) => r.querySelector(s);
const clone = (o) => JSON.parse(JSON.stringify(o));

let cfg = null;
let dirty = false;
let saveTimer = null;
let openEditorKey = null;          // "ring-index" of the expanded row
let iconModalTarget = null;        // item currently picking an icon

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
  if (undoFn) {
    const u = el('button', 'undo', { text: 'Undo', type: 'button' }, t);
    u.onclick = () => { undoFn(); t.remove(); };
    ttl = 6000;
  }
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 250); }, ttl);
}

/* ------------------------------- persistence ------------------------------ */
function setSaveState(text, state = '') {
  const s = $('#save-state');
  if (s) { s.textContent = text; s.className = 'save-state' + (state ? ' ' + state : ''); }
}

function touch(rerender = true) {
  dirty = true;
  setSaveState('Saving…');
  if (rerender) { renderSegments(); renderPreview(); }
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 450);
}

async function persist() {
  dirty = false;
  const r = await api.setConfig(cfg);
  if (r.ok) {
    cfg = r.config;
    updateHotkeyChip();
    setSaveState('Saved');
    const warn = $('#cfg-warn');
    if (warn) warn.classList.add('hidden');   // a good save means config.json is fine now
    if (r.hotkeyError) showHkError(r.hotkeyError);
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

/* ------------------------------- segments --------------------------------- */
const TYPE_OPTIONS = [
  ['app', 'app — launch program'], ['url', 'url — open link'], ['file', 'file — open file'],
  ['command', 'command — shell'], ['macro', 'macro — keystrokes'], ['sys', 'sys — Windows action']
];

function renderSegments() {
  const host = $('#ring-lists');
  host.innerHTML = '';
  for (const ring of ['1', '2']) {
    const sec = el('div', 'ring-sec', {}, host);
    const head = el('div', 'ring-head', {}, sec);
    el('h3', null, { text: ring === '1' ? 'Inner ring' : 'Outer ring' }, head);
    el('span', 'muted', { text: `${cfg.rings[ring].length} segment(s)` }, head);
    const add = el('button', 'btn small', { text: '+ Add' }, head);
    add.onclick = () => {
      const item = { id: crypto.randomUUID(), label: 'New item', icon: '', type: 'app', value: '', color: null };
      cfg.rings[ring].push(item);
      openEditorKey = `${ring}-${cfg.rings[ring].length - 1}`;
      touch();
    };
    if (!cfg.rings[ring].length) {
      el('div', 'empty-hint muted', { text: ring === '1' ? 'Empty — the wheel will use the outer ring only.' : 'Empty — no outer ring.' }, sec);
      continue;
    }
    cfg.rings[ring].forEach((item, i) => sec.appendChild(segRow(ring, item, i)));
  }
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
  icoSpan.textContent = item.icon || (item.type === 'sys' ? '\uE713' : '\uE76C');
  el('span', 'seg-name', { text: item.label || '(no name)' }, main);
  el('span', 'seg-type', { text: item.type }, main);
  el('span', 'seg-val', { text: item.type === 'sys' ? sysLabel(item.value) : item.value }, main);

  const acts = el('div', 'seg-actions', {}, main);
  const mini = (glyph, title, fn) => {
    const b = el('button', 'btn mini', { title, 'aria-label': title }, acts);
    el('span', 'g', { text: glyph }, b);
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  mini('\uE74A', 'Move earlier', () => { if (i > 0) { const a = cfg.rings[ring]; [a[i - 1], a[i]] = [a[i], a[i - 1]]; touch(); } });
  mini('\uE74B', 'Move later', () => { const a = cfg.rings[ring]; if (i < a.length - 1) { [a[i], a[i + 1]] = [a[i + 1], a[i]]; touch(); } });
  mini('\uE8AB', 'Move to other ring', () => {
    const other = ring === '1' ? '2' : '1';
    cfg.rings[ring].splice(i, 1);
    cfg.rings[other].push(item);
    touch();
  });
  // ▶ (E768 Play) can fire arbitrary shell commands, injected keystrokes, or
  // lock/sleep — those require a deliberate second click, not a 2px slip from ✕.
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
  });
  function disarm() {
    armed = false;
    clearTimeout(armTimer);
    runBtn.querySelector('.g').textContent = '\uE9A1';
    runBtn.classList.remove('armed');
    runBtn.title = 'Try this action now';
  }
  mini('\uE75D', 'Delete', () => {   // Trash (E894 stays reserved for clear/close)
    if (cfg.rings['1'].length + cfg.rings['2'].length <= 1) {
      toast('The wheel needs at least one segment', true);
      return;
    }
    const snapshot = clone(cfg);
    cfg.rings[ring].splice(i, 1);
    touch();
    toast(`Removed “${item.label}”`, false, () => { cfg = snapshot; touch(); });
  });

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
  const c = (sysCatalogCache || []).find((x) => x.id === id);
  return c ? c.label : id;
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
    if (val) val.textContent = item.type === 'sys' ? sysLabel(item.value) : item.value;
  };

  el('label', null, { text: 'Label', for: uid + '-label' }, f);
  const inLabel = bind(el('input', null, { type: 'text', maxlength: '40', value: item.label, id: uid + '-label' }, f), (e) => item.label = e.value);
  f.appendChild(inLabel);

  el('label', null, { text: 'Type', for: uid + '-type' }, f);
  const selType = el('select', null, { id: uid + '-type' }, f);
  for (const [v, t] of TYPE_OPTIONS) el('option', null, { value: v, text: t }, selType);
  selType.value = item.type;
  selType.addEventListener('change', () => {
    item.type = selType.value;
    touch();                                     // rebuilds the editor for the new type
    const ed = document.querySelector('.seg-edit');
    ed?.querySelector('select')?.focus();        // keep the keyboard in the editor
  });

  const labTarget = el('label', null, { text: item.type === 'macro' ? 'Keys' : 'Target' }, f);
  if (item.type === 'sys') {
    const sel = el('select', null, { id: uid + '-target' }, f);
    labTarget.setAttribute('for', uid + '-target');
    for (const c of (sysCatalogCache || [])) el('option', null, { value: c.id, text: `${c.group} — ${c.label}` }, sel);
    sel.value = item.value;
    sel.addEventListener('change', () => { item.value = sel.value; syncRowText(); touch(false); });
  } else {
    const rowv = el('div', null, { style: 'display:flex;gap:6px;grid-column:span 2' }, f);
    const inV = bind(el('input', null, { type: 'text', value: item.value, placeholder: valueHint(item.type), id: uid + '-target' }), (e) => item.value = e.value);
    labTarget.setAttribute('for', uid + '-target');
    rowv.appendChild(inV);
    if (item.type === 'app' || item.type === 'file') {
      const b = el('button', 'btn small', { text: 'Browse…' }, rowv);
      b.onclick = async (ev) => {
        ev.stopPropagation();
        const p = await api.pickFile(item.type === 'app' ? { extensions: ['exe', 'lnk', 'bat', 'cmd', 'msc'] } : {});
        if (p) { item.value = p; touch(); }
      };
    }
    if (item.type === 'app') appCombo(item, inV, f);
  }

  el('label', null, { text: 'Icon' }, f);
  const iconBox = el('div', null, { style: 'display:flex;align-items:center;gap:8px' }, f);
  const iconPrev = el('span', 'seg-ico', {}, iconBox);
  iconPrev.textContent = item.icon || '—';
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
  const colIn = el('input', null, { type: 'color', value: item.color || cfg.appearance.colors[ring === '1' ? 'ring1' : 'ring2'] }, colorBox);
  chkAuto.addEventListener('change', () => { item.color = chkAuto.checked ? null : colIn.value; touch(false); });
  colIn.addEventListener('input', () => { if (!chkAuto.checked) { item.color = colIn.value; touch(false); } });

  el('label', null, { text: 'Ring' }, f);
  const ringBox = el('div', null, { style: 'display:flex;gap:12px' }, f);
  for (const r of ['1', '2']) {
    const lb = el('label', 'chk', {}, ringBox);
    const rb = el('input', null, { type: 'radio', name: 'ringpick-' + item.id }, lb);
    rb.checked = String(ring) === r;
    rb.addEventListener('change', () => {
      if (rb.checked && String(ring) !== r) {
        const other = r;
        cfg.rings[ring].splice(cfg.rings[ring].indexOf(item), 1);
        cfg.rings[other].push(item);
        openEditorKey = null;
        touch();
      }
    });
    lb.appendChild(document.createTextNode(r === '1' ? 'inner' : 'outer'));
  }
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
    app: 'notepad.exe  or  C:\\Path\\to\\app.exe "arg"',
    url: 'https://…', file: 'C:\\Path\\to\\file.pdf',
    command: 'taskkill /f /im foo.exe', macro: 'ctrl+c, wait=0.2, ctrl+v'
  }[type] || '';
}

/* ------------------------------- icon modal ------------------------------- */
const iconModal = $('#icon-modal');
let iconModalOpener = null;

function openIconModal(item, opener) {
  iconModalTarget = item;
  iconModalOpener = opener || null;
  iconModal.classList.remove('hidden');
  $('#icon-close').focus();
}
function closeIconModal() {
  iconModal.classList.add('hidden');
  if (iconModalOpener && document.contains(iconModalOpener)) iconModalOpener.focus();
  iconModalOpener = null;
}

(function buildIconGrid() {
  const grid = $('#icon-grid');
  for (const g of ICON_CATALOG) {
    const cell = el('button', 'icon-cell', { 'aria-label': g.name }, grid);
    el('span', 'g', { text: g.code }, cell);
    el('span', 'n', { text: g.name }, cell);
    cell.onclick = () => {
      if (iconModalTarget) { iconModalTarget.icon = g.code; }
      closeIconModal();
      touch();
    };
  }
  $('#icon-none').onclick = () => { if (iconModalTarget) iconModalTarget.icon = ''; closeIconModal(); touch(); };
  $('#icon-close').onclick = closeIconModal;
  iconModal.addEventListener('click', (e) => { if (e.target === iconModal) closeIconModal(); });
  // Dialog behavior: Esc dismisses, Tab stays inside the modal.
  iconModal.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeIconModal(); }
    else if (e.key === 'Tab') {
      const btns = [...iconModal.querySelectorAll('button')];
      if (!btns.length) return;
      const first = btns[0], last = btns[btns.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
})();

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
    // Only the preview needs the new value — never rerender the segment rows per drag frame.
    r.addEventListener('input', () => { cfg.appearance[key] = parseFloat(r.value); out.textContent = r.value; renderPreview(); });
    r.addEventListener('change', () => touch(false));
  }

  const cg = $('#color-grid');
  cg.innerHTML = '';
  const LABELS = { bg: 'Background', ring1: 'Inner ring', ring2: 'Outer ring', hover: 'Hover', accent: 'Accent', text: 'Text', center: 'Hub' };
  for (const [k, lab] of Object.entries(LABELS)) {
    const item = el('label', 'color-item', {}, cg);
    const inp = el('input', null, { type: 'color', value: cfg.appearance.colors[k] }, item);
    el('span', null, { text: lab }, item);
    inp.addEventListener('input', () => { cfg.appearance.colors[k] = inp.value; renderPreview(); });
    inp.addEventListener('change', () => touch(false));
  }
}

const PRESETS = {
  Midnight: { bg: '#0f1419', ring1: '#1b2733', ring2: '#16202b', hover: '#2e7dd1', accent: '#4c9ff0', text: '#e8eef4', center: '#0a0e12' },
  Ocean: { bg: '#08131c', ring1: '#123047', ring2: '#0d2333', hover: '#1899c4', accent: '#33c6e8', text: '#e6f6fb', center: '#061018' },
  Grape: { bg: '#120b1c', ring1: '#2c1b45', ring2: '#221436', hover: '#7b3fd1', accent: '#a86bff', text: '#f0e8fb', center: '#0b0714' },
  Graphite: { bg: '#171717', ring1: '#2b2b2b', ring2: '#222222', hover: '#e8e8e8', accent: '#d0d0d0', text: '#111111', center: '#0d0d0d' },
  Ember: { bg: '#160d0a', ring1: '#3a1e12', ring2: '#2b160d', hover: '#d1652e', accent: '#ff944c', text: '#fbefe8', center: '#0f0805' }
};

function renderPresets() {
  const host = $('#presets');
  host.innerHTML = '';
  for (const [name, colors] of Object.entries(PRESETS)) {
    const b = el('button', 'preset', {}, host);
    const sw = el('span', 'sw', {}, b);
    for (const k of ['ring1', 'hover', 'accent']) {
      const i = el('i', null, {}, sw); i.style.background = colors[k];
    }
    el('span', null, { text: name }, b);
    b.onclick = () => { cfg.appearance.colors = { ...colors }; renderAppearance(); renderPreview(); touch(false); };
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
  $('#ap-showlabels').checked = cfg.appearance.showLabels;
  $('#ap-showlabels').onchange = (e) => { cfg.appearance.showLabels = e.target.checked; renderPreview(); touch(false); };
  const cl = $('#ap-centerlabel');
  cl.value = cfg.appearance.centerLabel;
  cl.oninput = () => { cfg.appearance.centerLabel = cl.value; renderPreview(); touch(false); };   // preview live AND persist (no row-list rerender while typing)
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
  $('#btn-quit').onclick = () => { if (confirm('Exit Radial Wheel? The hotkey will stop working until you launch it again.')) api.requestQuit(); };
}

/* --------------------------------- preview --------------------------------- */
function renderPreview() {
  const host = $('#wheel-preview');
  const avail = Math.min(host.clientWidth, host.clientHeight) - 20;
  const need = cfg.appearance.outerRadius * 2 + 52;
  const scale = Math.min(1, Math.max(0.3, avail / need));
  buildWheel(host, cfg, { preview: true, scale });
}

/* ---------------------------------- boot ----------------------------------- */
function renderAll() {
  renderSegments();
  renderAppearance();
  renderPresets();
  wireBehaviorCheckboxes();
  updateHotkeyChip();
  renderPreview();
}

async function boot() {
  const r = await api.getConfig();
  cfg = r.config;
  sysCatalogCache = await api.sysCatalog();
  renderAll();
  setSaveState('Saved');
  wireAdvanced();
  wireConfigWarn(r);
  if (r.hotkeyError) showHkError(r.hotkeyError);
  if (r.importedFrom) toast('Settings imported from your previous (legacy) config', false, null, 5000);
  api.onConfigChanged((newCfg) => { if (!dirty) { cfg = newCfg; renderAll(); } });
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
