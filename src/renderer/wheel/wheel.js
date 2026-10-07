import { buildWheel, createFlyoutNavigator, decideMarking, rankMatches } from '../shared/wheel-core.js';
import {
  computePanelLayout, mixerRowKey, isMixerItem,
  pickDefaultDevice, deviceSignature, capDeviceList
} from '../shared/wheel-mixer.js';
import { createWheelSound } from '../shared/wheel-sound.js';

const api = window.wheelAPI;
const rootEl = document.getElementById('root');

/* Soft hover/select ticks (behavior.wheelSound, opt-in). The factory is lazy:
   no AudioContext exists until the setting is on AND something plays. */
const sound = createWheelSound();

let built = null;
let lastPayload = null;
let nav = null;          // folder flyout dwell state machine (wheel-core)
let grownTo = 0;         // px the overlay window was last asked to cover

/* Marking (press → drag → release) and type-to-filter gesture state. Both are
   read out of the summon payload's behavior flags, and both reset per pop. */
let markArmed = null;      // live marking press: { seg } | { hub: true } | { off: true }
let filterQuery = '';      // current type-to-filter text ('' = off)
let filterSegs = new Set();// built segment records the query matches

const behaviorOf = () => (lastPayload && lastPayload.config && lastPayload.config.behavior) || {};
const markingOn = () => behaviorOf().markingSelect !== false;
const filterOn = () => behaviorOf().typeToFilter !== false;

/* Every item in the summon payload — rings + profile rings, folder children.
   Mirror of main's config.walkItems (the renderer cannot require it). */
function collectItems(config) {
  const out = [];
  const down = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      out.push(it);
      if (Array.isArray(it.children) && it.children.length) down(it.children);
    }
  };
  const groups = [];
  if (config && config.rings) groups.push(config.rings);
  if (config && Array.isArray(config.profiles)) {
    for (const p of config.profiles) if (p && p.rings) groups.push(p.rings);
  }
  for (const rings of groups) for (const k of Object.keys(rings)) down(rings[k]);
  return out;
}

/* Branch the fan chain down to a closed folder's child, then report that
   child's (now live) segment record — or null if it could not be reached. */
function openChainTo(target) {
  if (!built) return null;
  let direct = built.segments.find((s) => s.item === target);
  if (direct) return direct;
  const chain = [];
  let cur = target;
  for (let guard = 0; guard < 4 && chain.length < 4; guard++) {
    const parent = built.segments.find((s) => s.item && Array.isArray(s.item.children) && s.item.children.indexOf(cur) >= 0);
    if (!parent) break;
    chain.unshift(parent);
    cur = parent.item;
  }
  let opened = false;
  for (const ps of chain) if (!built.flyout.isOpen(ps) && built.flyout.open(ps)) opened = true;
  if (opened) requestRoom(built.flyout.reach());
  return built.segments.find((s) => s.item === target) || null;
}

/* Re-derive the dim set + hub query readout from filterQuery against the
   CURRENT built (safe after any rebuild: fan open/close, icon refresh). */
function recomputeFilter(glueCursor) {
  if (!built) return;
  if (!filterQuery) {
    filterSegs = new Set();
    built.applyFilter(null);
    return;
  }
  const matched = rankMatches(collectItems(lastPayload && lastPayload.config), filterQuery);
  const segs = new Set();
  for (const m of matched) {
    const seg = openChainTo(m);
    if (seg) segs.add(seg);
  }
  filterSegs = segs;
  built.applyFilter({ query: filterQuery, segs });
  if (glueCursor && segs.size) {
    const first = built.segments.find((s) => segs.has(s));
    if (first) selectSeg(built.segments.indexOf(first));
  }
}

function setFilterQuery(q) {
  filterQuery = String(q || '');
  api.setFiltering(!!filterQuery);   // main lets Esc reach the page while this is on
  recomputeFilter(true);
}

/* A flyout reaching past the wheel rim (a folder on the outermost ring) asks
   main to grow the transparent window around itself. Geometry only, throttled
   to strictly-increasing requests; reset on every summon. */
function requestRoom(reachPx) {
  const need = Math.ceil(reachPx) + 6;
  if (!built || need <= built.outerRadius || need <= grownTo) return;
  grownTo = need;
  api.growCanvas(need);
}

/* ── volume-mixer flyout card (the `mixer` segment) ─────────────────────────
   A click on a mixer segment executes nothing: the wheel FREEZES and this
   card pops out just beyond the plate — a default-output picker + master
   volume row, a default-input picker + microphone row, then one slider + mute
   per app owning an audio session (Windows-volume-flyout shape). The pickers
   list the real endpoints main enumerates and switch the system default on
   click, like the Settings Audio tab's dropdowns do. All state is read back
   from Windows through the frame-gated audio
   channels (clamped in main before any of it reaches Core Audio), poll-refreshed
   every MX_POLL_MS like the Settings tab, and never overwritten mid-drag
   (per-row busy claim). Geometry is the pure computePanelLayout helper
   (shared/wheel-mixer.js); the window grows over the same wheel:grow path the
   folder fans use, and Esc ownership rides the existing type-to-filter flag:
   the first Esc closes an open device list, then the card; the next one
    dismisses the wheel. */
const mixer = {
  el: null, sessionsEl: null, noteEl: null,
  ownerSeg: null, rows: new Map(), poll: null,
  masterOut: null, masterIn: null,
  devOut: null, devIn: null,   // the two default-device pickers (mxDevice)
  probe: null,                 // availability: null = not probed, false+why = dead
  tick: 0                      // poll counter — drives the slow endpoint re-read
};
const MX_POLL_MS = 2000;
const MX_MAX_ROWS = 12;
/* Endpoint lists change only when something is plugged in or another app flips
   the default, so they are not on the 2 s level poll (the Settings tab keeps
   the same split): they load at open, on expand, on Refresh, after a switch,
   and every MX_DEV_EVERY_TICKS-th tick (~6 s) so a hot-plug still shows up. */
const MX_DEV_EVERY_TICKS = 3;
let mxSeq = 0;                 // newest-load-wins guard on the async refreshes
let mxNoteTimer = null;

function h(tag, cls, props, parent) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (props) for (const k of Object.keys(props)) {
    if (k === 'text') n.textContent = props[k];
    else n.setAttribute(k, props[k]);
  }
  if (parent) parent.appendChild(n);
  return n;
}
const apiCall = (fn) => Promise.resolve().then(fn).catch(() => null);

const mixerOpen = () => !!mixer.el;
const mixerHit = (e) => !!(mixer.el && e && mixer.el.contains(e.target));

/* Esc budget inside the card: an open endpoint list goes away first, the card
   second — the same "deepest thing first" rhythm the folder fans use.
   Returns true when a list was collapsed, so the key is spent. */
function mxCloseOpenPickers() {
  let closed = false;
  for (const w of [mixer.devOut, mixer.devIn]) {
    if (w && w.open) { w.close(); closed = true; }
  }
  return closed;
}

function mxNote(text, isError) {
  const n = mixer.noteEl;
  if (!n) return;
  clearTimeout(mxNoteTimer);
  n.textContent = String(text || '');
  n.title = n.textContent;                       // the visible note clamps to 3 lines; the full reason stays reachable
  n.classList.toggle('mx-err', !!isError);
}

/* An error caused by a user gesture — a refused device switch — has to
   outlive the next poll: the poll's successful session read calls mxNote('')
   and would otherwise erase the reason within two seconds. A sticky line
   clears on the next gesture, on a good switch, or when the hold expires. */
const MX_NOTE_HOLD_MS = 9000;
let mxNoteHoldUntil = 0;
function mxNoteSticky(text) {
  mxNote(text, true);
  mxNoteHoldUntil = Date.now() + MX_NOTE_HOLD_MS;
}

function mxSetDisabled(on) {
  if (!mixer.el) return;
  mixer.el.querySelectorAll('input, button').forEach((n) => { n.disabled = !!on; });
  mixer.el.classList.toggle('mx-off', !!on);
}

/* One slider row: glyph, name, range 0–100, % readout, mute toggle. `st.set`
   is the poll path (never yanks a dragged slider); `st.update` is the session
   row refresh. The commit rhythm mirrors the Settings Audio tab exactly:
   input claims the row (1.5 s idle release), change commits after 160 ms. */
function mxRow(host, { icon, label, aria, onVolume, onMute }) {
  const row = h('div', 'mx-row', null, host);
  h('span', 'mx-ico g', { text: icon, 'aria-hidden': 'true' }, row);
  const name = h('span', 'mx-name', {}, row);
  name.textContent = label;
  const slider = h('input', 'mx-slider', { type: 'range', min: '0', max: '100', step: '1', 'aria-label': aria }, row);
  const pct = h('span', 'mx-pct', { text: '—' }, row);
  const mute = h('button', 'mx-mute', { type: 'button', 'aria-pressed': 'false', title: label + ' — click to mute', 'aria-label': 'Mute ' + label }, row);
  h('span', 'g', { text: '\uE74E' }, mute);           // speaker-off glyph
  const st = { row, name, slider, pct, mute, busy: false, idle: null, lastLabel: label };

  slider.addEventListener('input', () => {
    st.busy = true;
    clearTimeout(st.idle);
    pct.textContent = slider.value + '%';
    slider.style.setProperty('--fill', slider.value + '%');   // accent fill under the thumb
    st.idle = setTimeout(() => { st.busy = false; }, 1500);   // a gesture that never commits releases the claim
  });
  slider.addEventListener('change', () => {
    const v = +slider.value;
    clearTimeout(st.idle);
    st.idle = setTimeout(async () => {
      const r = await apiCall(() => onVolume(v));
      st.busy = false;
      if (r && r.ok === false) mxNote(r.error || 'Volume change failed', true);   // row resyncs on the next poll
    }, 160);
  });
  mute.addEventListener('click', async () => {
    const want = mute.getAttribute('aria-pressed') !== 'true';
    const r = await apiCall(() => onMute(want));
    if (r && r.ok === false) mxNote(r.error || 'Mute change failed', true);
    else mute.setAttribute('aria-pressed', String(want));
  });

  st.set = (volume, muted) => {
    if (!st.busy) {
      slider.value = String(volume);
      pct.textContent = volume + '%';
      slider.style.setProperty('--fill', volume + '%');
    }
    mute.setAttribute('aria-pressed', String(!!muted));
    mute.title = label + (muted ? ' — click to unmute' : ' — click to mute');
  };
  st.update = (text, muted, count) => {
    // Unconditional assignment — it resets the badge host, so the ×N span
    // below never accumulates across polls (the Settings tab does the same).
    const t = text || st.lastLabel || label;
    name.textContent = t;
    st.lastLabel = t;
    if (count > 1) h('span', 'mx-count', { text: '\u00d7' + count }, name);
    slider.setAttribute('aria-label', 'Volume for ' + t);
    mute.setAttribute('aria-label', 'Mute ' + t);
    mute.title = t + (muted ? ' — click to unmute' : ' — click to mute');
    st.set(+slider.value || 0, muted);
    if (!st.busy) pct.textContent = slider.value + '%';
  };
  st.destroy = () => { clearTimeout(st.idle); row.remove(); };
  return st;
}

/* One default-device picker: a button naming the endpoint Windows currently
   uses for this direction, opening an in-card list of every active endpoint —
   clicking an entry makes it the system default, like the Settings Audio tab's
   dropdown does.

   Deliberately NOT a <select>: the overlay window hides itself on blur
   (main/windows.js), and a native dropdown is an OS widget that takes
   activation — the wheel would dismiss itself mid-selection, and the popup
   would be clipped by the transparent square regardless. So the list is the
   card's own DOM, capped by capDeviceList and scrolled like the app rows; the
   two pickers are an accordion (opening one closes the other) to keep the
   card inside its height budget (shared/wheel-mixer.js, TALLEST_CARD_PX).

   The widget never fetches: mxRefresh owns the round trips and hands results
   to st.setList / st.fail / st.setUnavailable, so one seq guard covers
   levels, sessions, and endpoints alike. */
function mxDevice(host, { icon, kind, noun, onPick, onToggle }) {
  const lid = 'mx-dev-list-' + String(noun).replace(/[^a-z]+/gi, '-');   // one id for aria-controls
  const row = h('div', 'mx-row mx-dev', null, host);
  h('span', 'mx-ico g', { text: icon, 'aria-hidden': 'true' }, row);
  const btn = h('button', 'mx-dev-btn', {
    type: 'button', 'aria-haspopup': 'listbox', 'aria-expanded': 'false',
    'aria-controls': lid,
    'aria-label': 'Change the default ' + noun
  }, row);
  h('span', 'mx-dev-kind', { text: kind }, btn);
  const cur = h('span', 'mx-dev-cur', { text: '—' }, btn);
  h('span', 'mx-dev-caret', { 'aria-hidden': 'true' }, btn);      // CSS-drawn triangle
  const list = h('div', 'mx-dev-list', { id: lid, role: 'listbox', 'aria-label': 'Default ' + noun }, row);
  btn.addEventListener('click', () => setOpen(!st.open));        // the accordion handle

  const st = {
    row, btn, cur, list,
    devices: [], sig: null, loaded: false,
    open: false, busy: false
  };

  const locked = () => !!(mixer.el && mixer.el.classList.contains('mx-off'));

  function paintButton() {
    const d = pickDefaultDevice(st.devices);
    const text = !st.loaded ? '…' : (d ? (d.name || d.id) : '(none — pick one)');
    cur.textContent = text;
    btn.title = kind + ': ' + text;
    btn.setAttribute('aria-label', 'Change the default ' + noun + ' — currently ' + text);
  }

  function paintList() {
    const sig = deviceSignature(st.devices);
    if (sig === st.sig && st.loaded) return;   // a poll that changed nothing leaves the list alone
    st.sig = sig;
    list.innerHTML = '';
    const capped = capDeviceList(st.devices);
    if (!capped.items.length) h('div', 'mx-dev-empty', { text: '(no devices found)' }, list);
    for (const d of capped.items) {
      const name = d.name || d.id;
      const opt = h('button', 'mx-dev-opt', {
        type: 'button', role: 'option', title: name,
        'aria-selected': d.isDefault ? 'true' : 'false'
      }, list);
      h('span', 'mx-dev-check', { 'aria-hidden': 'true' }, opt);  // CSS-drawn tick on the current default
      h('span', 'mx-dev-text', { text: name }, opt);
      if (locked()) opt.disabled = true;         // an unavailable stack locks late nodes too
      opt.addEventListener('click', () => pick(d, opt));
    }
    if (capped.extra > 0) h('div', 'mx-dev-more', { text: '\u2026and ' + capped.extra + ' more' }, list);
    if (st.open) positionMixer();                // the card just changed height
  }

  function repaint() { st.sig = null; paintList(); paintButton(); }

  async function pick(d, opt) {
    if (st.busy || !d || !d.id) return;
    mxNoteHoldUntil = 0;                         // a new gesture retires the previous error line
    st.busy = true;
    list.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    if (opt) opt.classList.add('mx-dev-waiting');
    const r = await apiCall(() => onPick(d.id));
    st.busy = false;
    if (!mixer.el) return;                       // the card closed mid-write: nothing to update
    if (!r || r.ok === false) {
      // Windows said no (device busy or gone, or an OS image missing its private
      // audio-policy registration): say why and keep saying why — the next poll
      // reads the truth back, so only a sticky note survives it.
      mxNoteSticky(kind + ': ' + ((r && r.error) || 'unknown'));
      ensureLive().textContent = 'Could not switch the ' + noun + '. ' + ((r && r.error) || 'unknown');
      repaint();                                 // re-enable the rows and show the truth
      mxRefresh({ devices: true });              // re-read what Windows actually has
      return;
    }
    // Optimistic: mark the new default locally, then confirm against Windows.
    st.devices = st.devices.map((x) => Object.assign({}, x, { isDefault: x.id === d.id }));
    st.loaded = true;
    setOpen(false);
    repaint();
    mxNote('');
    ensureLive().textContent = 'Default ' + noun + ' set to ' + (d.name || 'device');
    mxRefresh({ devices: true });                // levels + sessions track the NEW endpoint
  }

  function setOpen(on) {
    if (st.open === on) return;
    st.open = on;
    row.classList.toggle('mx-dev-open', on);
    btn.setAttribute('aria-expanded', String(on));
    if (on) {
      paintList();
      if (!st.loaded || !st.devices.length) mxRefresh({ devices: true });
    }
    onToggle(st, on);
  }

  st.setList = (devices) => {
    const next = Array.isArray(devices) ? devices.filter((d) => d && typeof d.id === 'string' && d.id) : [];
    const same = st.loaded && deviceSignature(next) === deviceSignature(st.devices);
    st.devices = next;
    st.loaded = true;
    // Identical re-read: touch the button text only. Rebuilding the list would
    // drop the focused option (and the user's place in it) for nothing.
    if (same) paintButton();
    else repaint();
  };
  st.fail = (err) => {
    if (st.loaded) return;                       // keep the last good list; never fight the note line
    st.loaded = false;
    cur.textContent = '(not readable)';
    mxNoteSticky('Could not read the ' + noun + ' list: ' + (err || 'unknown'));
  };
  /* The whole audio stack is dead (probe failed): the row says so instead of
     sitting on '…' forever. mxSetDisabled has already locked every control. */
  st.setUnavailable = () => {
    st.loaded = false;
    st.devices = [];
    st.sig = '\u0000locked';
    list.innerHTML = '';
    cur.textContent = '(unavailable)';
    btn.setAttribute('aria-label', 'Change the default ' + noun + ' — audio control unavailable');
  };
  st.toggle = () => setOpen(!st.open);
  st.close = () => setOpen(false);
  st.destroy = () => row.remove();
  return st;
}

/* Diff the live session list into the rows Map (keyed by pid / system-sounds,
   same identity as the Settings tab) — a vanished app's row drops on the next
   poll, an app the user is dragging is left alone. */
function mxDiffSessions(sessions) {
  const host = mixer.sessionsEl;
  if (!host) return;
  const seen = new Set();
  let created = 0, extra = 0;
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const key = mixerRowKey(s);
    if (!key) continue;
    seen.add(key);
    let st = mixer.rows.get(key);
    if (!st) {
      if (created >= MX_MAX_ROWS) { extra++; continue; }
      const pid = s.pid;
      st = mxRow(host, {
        icon: '\uE767', label: s.label || 'audio session ' + pid,
        aria: 'Volume for ' + (s.label || 'audio session ' + pid),
        onVolume: (v) => api.audioSetSession(pid, { volume: v }),
        onMute: (m) => api.audioSetSession(pid, { muted: m })
      });
      st.row.classList.toggle('mx-system', !!s.isSystem);
      mixer.rows.set(key, st);
      created++;
    }
    st.update(s.label || 'audio session ' + pid, s.muted, s.sessions);
  }
  for (const [key, st] of [...mixer.rows]) {
    if (!seen.has(key)) { st.destroy(); mixer.rows.delete(key); }
  }
  if (!mixer.rows.size) mxNote('Nothing is playing audio right now.');
  else if (extra > 0) mxNote('\u2026and ' + extra + ' more');
}

/* One round trip for the whole card: sessions + both master levels, and the
   two endpoint lists only when `wantDevices` says so (see MX_DEV_EVERY_TICKS).
   A device read that fails keeps the picker's last good list — and only
   complains on the note line when the picker never loaded anything, so a
   flaky enumeration cannot erase the app-list messaging. */
async function mxRefresh(opts) {
  if (!mixer.el) return;
  const seq = ++mxSeq;
  const wantDevices = !!(opts && opts.devices) || (mixer.tick % MX_DEV_EVERY_TICKS) === 0;
  if (mixer.probe === null) {
    const av = await apiCall(() => api.audioAvailable());
    mixer.probe = !!(av && av.ok !== false) ? true : ((av && (av.reason || av.error)) || 'Audio control is unavailable');
    if (mixer.probe !== true) {
      mxNote(String(mixer.probe), true);
      mxSetDisabled(true);
      if (mixer.devOut) mixer.devOut.setUnavailable();
      if (mixer.devIn) mixer.devIn.setUnavailable();
      return;
    }
  }
  if (mixer.probe !== true) return;
  const [rs, ro, ri, dOut, dIn] = await Promise.all([
    apiCall(() => api.audioSessions()),
    apiCall(() => api.audioLevels('render')),
    apiCall(() => api.audioLevels('capture')),
    wantDevices ? apiCall(() => api.audioDevices('render')) : null,
    wantDevices ? apiCall(() => api.audioDevices('capture')) : null
  ]);
  if (seq !== mxSeq || !mixer.el) return;             // a newer load (or a close) won
  if (ro && ro.ok !== false && mixer.masterOut) mixer.masterOut.set(ro.volume, ro.muted);
  if (ri && ri.ok !== false && mixer.masterIn) mixer.masterIn.set(ri.volume, ri.muted);
  if (mixer.devOut) {
    if (dOut && dOut.ok !== false) mixer.devOut.setList(dOut.devices);
    else if (dOut) mixer.devOut.fail(dOut.error);
  }
  if (mixer.devIn) {
    if (dIn && dIn.ok !== false) mixer.devIn.setList(dIn.devices);
    else if (dIn) mixer.devIn.fail(dIn.error);
  }
  if (!rs || rs.ok === false) { mxNote((rs && rs.error) || 'Could not read the app volume list.', true); return; }
  if (Date.now() >= mxNoteHoldUntil) mxNote('');  // a good read clears a stale line — but not a sticky one
  mxDiffSessions(rs.sessions);
}

function mxPollTick() {
  if (!mixer.el || document.hidden) return;            // main hid the window: the page idles, not polls
  mixer.tick += 1;
  mxRefresh();
}

function buildMixerCard(seg) {
  const ap = (lastPayload && lastPayload.config && lastPayload.config.appearance) || {};
  const colors = ap.colors || {};
  const card = h('div', 'mixer-panel');
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Volume mixer');
  card.style.setProperty('--mx-bg', colors.center || '#0a0e12');
  card.style.setProperty('--mx-text', colors.text || '#e8eef4');
  card.style.setProperty('--mx-accent', colors.accent || '#4c9ff0');
  card.style.setProperty('--mx-edge', colors.edge || 'rgba(255,255,255,0.08)');
  card.style.setProperty('--mx-hover', colors.hover || '#2e7dd1');

  const head = h('div', 'mx-head', null, card);
  h('span', 'mx-title', { text: (seg.item && seg.item.label) || 'Volume mixer' }, head);
  const refresh = h('button', 'mx-btn', { type: 'button', title: 'Refresh the volume and device lists', 'aria-label': 'Refresh the volume and device lists' }, head);
  h('span', 'g', { text: '\uE72C' }, refresh);          // Refresh glyph
  refresh.addEventListener('click', () => { mxRefresh({ devices: true }); });
  const close = h('button', 'mx-btn mx-close', { type: 'button', title: 'Close', 'aria-label': 'Close the volume mixer' }, head);
  h('span', 'g', { text: '\uE8BB' }, close);            // ChromeClose glyph
  close.addEventListener('click', () => closeMixer());

  const body = h('div', 'mx-body', null, card);
  /* The two pickers are an accordion: one open list at a time keeps the card
     inside its height budget, and every open/close re-anchors (the list can
     change the card's height, which drives the wheel:grow request). The CARD
     carries its own class — .mx-dev-open belongs to the open ROW only, so a
     card-level flag must never look like "every list is open". */
  const devToggle = (st, on) => {
    if (on) for (const other of [mixer.devOut, mixer.devIn]) if (other && other !== st) other.close();
    const anyOpen = !!(mixer.devOut && mixer.devOut.open) || !!(mixer.devIn && mixer.devIn.open);
    card.classList.toggle('mx-pickers-open', anyOpen);
    positionMixer();
  };
  mixer.devOut = mxDevice(body, {
    icon: '\uE767', kind: 'Output', noun: 'output device',
    onPick: (id) => api.audioSetDefault('render', id),
    onToggle: devToggle
  });
  mixer.masterOut = mxRow(body, {
    icon: '\uE767', label: 'System volume', aria: 'Master output volume',
    onVolume: (v) => api.audioSetVolume('render', { volume: v }),
    onMute: (m) => api.audioSetVolume('render', { muted: m })
  });
  mixer.devIn = mxDevice(body, {
    icon: '\uE720', kind: 'Input', noun: 'input device',
    onPick: (id) => api.audioSetDefault('capture', id),
    onToggle: devToggle
  });
  mixer.masterIn = mxRow(body, {
    icon: '\uE720', label: 'Microphone', aria: 'Microphone volume',
    onVolume: (v) => api.audioSetVolume('capture', { volume: v }),
    onMute: (m) => api.audioSetVolume('capture', { muted: m })
  });
  h('div', 'mx-rule', { 'aria-hidden': 'true' }, body);
  mixer.sessionsEl = h('div', 'mx-sessions', { 'aria-label': 'App volumes' }, body);
  mixer.noteEl = h('div', 'mx-note', null, card);
  return card;
}

/* Place the card along the owner plate's ray, ask main for the window the
   layout needs, then clamp against the CURRENT viewport (before the grow
   lands it centers itself; the resize event re-runs this with room to
   spare, so it settles into the anchored position). */
function positionMixer() {
  if (!mixer.el || !mixer.ownerSeg || !built) return;
  const w = window.innerWidth || 1, hh = window.innerHeight || 1;
  const args = {
    centerDeg: mixer.ownerSeg.center, outerRadius: built.outerRadius,
    panelW: mixer.el.offsetWidth, panelH: mixer.el.offsetHeight,
    cx: w / 2, cy: hh / 2
  };
  const ideal = computePanelLayout({ ...args, halfSize: 0 });
  requestRoom(ideal.reachPx);
  const lay = computePanelLayout({ ...args, halfSize: Math.min(w, hh) / 2 });
  mixer.el.style.left = Math.round(lay.x) + 'px';
  mixer.el.style.top = Math.round(lay.y) + 'px';
}

function openMixer(seg) {
  if (mixer.ownerSeg === seg) { closeMixer(); return; }    // second click on the plate closes it
  closeMixer();
  const card = buildMixerCard(seg);
  mixer.el = card;
  mixer.ownerSeg = seg;
  document.body.appendChild(card);
  if (nav) nav.reset();                                    // no fan competes with the card
  if (filterQuery) setFilterQuery('');                     // the card owns the page now
  api.setFiltering(true);                                  // Esc belongs to the page: first press closes the card
  applyHover(null, { silent: true });                      // drop the hover spring under the card
  positionMixer();
  mxSetDisabled(false);                                    // a previous unavailable-run may have locked it
  mixer.tick = 0;                                          // the first refresh always reads the endpoint lists
  mxRefresh({ devices: true });
  mixer.poll = setInterval(mxPollTick, MX_POLL_MS);
  const first = card.querySelector('input');
  if (first) first.focus();
  ensureLive().textContent = 'Volume mixer opened. Esc closes it.';
}

function closeMixer() {
  if (!mixer.el) return;
  if (mixer.poll) { clearInterval(mixer.poll); mixer.poll = null; }
  mxSeq++;                                                 // strand any in-flight refresh
  mixer.el.remove();
  mixer.el = null; mixer.sessionsEl = null; mixer.noteEl = null;
  mixer.ownerSeg = null; mixer.poll = null;
  mixer.rows.clear();
  mixer.masterOut = null; mixer.masterIn = null;
  mixer.devOut = null; mixer.devIn = null;   // pickers rebuild with the card
  mxNoteHoldUntil = 0;                       // a refused switch is not the next session's business
  api.setFiltering(!!filterQuery);                         // hand Esc back to main (unless a query outlives it)
}

/* The overlay window is resized by main (grow path) — re-anchor the card so
   it stops riding the temporary centered position. */
window.addEventListener('resize', () => { if (mixerOpen()) positionMixer(); });
/* Hide (blur/segment fire) parks the poll; a show re-arms it. onShow also
   hard-closes any half-lived card. */
document.addEventListener('visibilitychange', () => {
  if (!mixerOpen()) return;
  if (document.hidden) {
    if (mixer.poll) { clearInterval(mixer.poll); mixer.poll = null; }
  } else if (!mixer.poll) {
    mixer.poll = setInterval(mxPollTick, MX_POLL_MS);
    mxRefresh();
  }
});

function mountWheel(config, scale, preview) {
  built = buildWheel(rootEl, config, { scale, iconImages: iconCache, preview: !!preview });
  nav = createFlyoutNavigator(built, {
    dwellMs: (config.behavior && config.behavior.flyoutDwellMs) || 0,
    onGrow: requestRoom
  });
  selIdx = -1;
  grownTo = 0;
  sound.reset();   // fresh segment records — the old hover identity is gone
  if (filterQuery) recomputeFilter(false);   // survive a silent icon-refresh rebuild
  return built;
}

/* Dashboard Icons logos, memoized across show cycles: slug -> dataUrl.
   Failures are NOT cached forever — a 60 s cooldown (iconFailedAt) lets the
   wheel recover its logos when connectivity returns, without hammering the
   CDN while offline. */
const iconCache = new Map();
const iconFailedAt = new Map();
const ICON_FAIL_TTL = 60000;
const iconPending = new Set();

function itemSlugs(config) {
  const slugs = new Set();
  const down = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      if (it.iconImage) slugs.add(it.iconImage);
      if (Array.isArray(it.children) && it.children.length) down(it.children);   // folder children prefetch too
    }
  };
  for (const arr of (config && config.rings ? Object.values(config.rings) : [])) down(arr);
  return [...slugs];
}

function ensureIcons(config) {
  for (const slug of itemSlugs(config)) {
    if (iconCache.get(slug) || iconPending.has(slug)) continue;
    const at = iconFailedAt.get(slug) || 0;
    if (at && Date.now() - at < ICON_FAIL_TTL) continue;              // fresh failure — cooldown
    iconPending.add(slug);
    api.iconDataUrl(slug).then((r) => {
      iconPending.delete(slug);
      const url = r && r.ok ? r.dataUrl : null;
      if (url) iconCache.set(slug, url);
      else iconFailedAt.set(slug, Date.now());
      if (!url || iconCache.get(slug) !== url) return;                // newer info won
      // Quietly rebuild the overlay once so the freshly-downloaded logo pops in.
      // preview:true suppresses the re-pop animation — this is a silent refresh.
      if (built && lastPayload && lastPayload.config === config) {
        const hoveredSeg = selIdx >= 0 ? built.segments[selIdx] : null;
        const hoveredItem = hoveredSeg && hoveredSeg.item;
        mountWheel(config, lastPayload.scale, true);   // preview:true — silent refresh, no re-pop
        const restored = hoveredItem && built.segments.find((s) => s.item === hoveredItem || (s.item.id || '') === (hoveredItem.id || ''));
        if (restored) applyHover({ seg: restored }, { silent: true });   // don't pop hover/hub-report state — or re-tick
      }
    }).catch(() => {
      iconPending.delete(slug);
      iconFailedAt.set(slug, Date.now());
    });
  }
}

function pointToHit(x, y) {
  if (!built) return null;
  // Hit-test in the SVG's own box, not the window's: main sizes the window
  // from a SCALED pad while buildWheel pads with the unscaled constant, so on
  // scale<1 displays the centered SVG is offset by a few px (settings preview
  // has always done exactly this rect subtraction).
  const svg = rootEl.querySelector('svg');
  if (svg) {
    const rect = svg.getBoundingClientRect();
    x -= rect.left; y -= rect.top;
  }
  return built.hitTest(x, y);
}

/* Single funnel for every leaf firing (pointer click, marking release, Enter):
   the select tick rides the same path the ipc click does, so the sound can
   never drift out of sync with what actually executes. The mixer segment is
   the one plate that executes nothing — its click opens/closes the volume
   card in place, with no fire tick (nothing is fired). */
function fireSeg(seg) {
  if (isMixerItem(seg.item)) { openMixer(seg); return; }
  sound.fire();
  api.clickSegment(seg.item);   // main hides the overlay + executes
}

function applyHover(hit, opts) {
  if (!built) return;
  const seg = hit && hit.seg ? hit.seg : null;
  built.setHover(seg);
  // keep the keyboard cursor glued to what the pointer shows — Enter fires
  // the hovered segment; moving off it clears the selection too.
  selIdx = seg ? built.segments.indexOf(seg) : -1;
  if (!(opts && opts.silent)) sound.hoverSeg(seg);   // tick only on a change
  const rootG = document.querySelector('.wheel-root');
  if (rootG) rootG.classList.toggle('any-hover', !!seg);
  rootEl.classList.toggle('has-hover', !!seg || (hit && hit.hub));
  // folder dwell: branch open/close is timing-only logic, shared with the
  // settings preview through the same navigator.
  if (nav) nav.feed(seg, !!hit);
  // dwell-opened/closed fans change the plate set — re-dim for a running query
  if (filterQuery) recomputeFilter(false);
}

api.onShow((payload) => {
  lastPayload = payload;
  markArmed = null;            // a fresh summon never inherits a half-finished marking gesture
  closeMixer();                // ...nor a half-open volume card (and its poll)
  mixer.probe = null;          // re-probe audio availability for the new summon
  filterQuery = '';
  filterSegs = new Set();
  api.setFiltering(false);     // ...or a stale Esc-ownership flag
  sound.setEnabled(behaviorOf().wheelSound === true);   // opt-in per summon, from the validated payload
  mountWheel(payload.config, payload.scale);
  // Decorative to AT: the SVG (plates, glyph text) is aria-hidden; the visually
  // hidden live region below announces the keyboard selection instead.
  const svg = rootEl.querySelector('svg');
  if (svg) svg.setAttribute('aria-hidden', 'true');
  ensureIcons(payload.config);
  document.body.style.visibility = 'visible';
  requestAnimationFrame(() => {
    applyHover(pointToHit(payload.cursorLocal.x, payload.cursorLocal.y));
  });
});

window.addEventListener('mousemove', (e) => {
  if (mixerOpen()) return;                       // frozen while the volume card is up
  applyHover(pointToHit(e.clientX, e.clientY));
});

/* ── selection ──────────────────────────────────────────────────────────────
   behavior.markingSelect (default ON) turns selection into a marking gesture:
   arm on left-press, follow the sweep with the existing hover path, decide on
   RELEASE via the pure wheel-core.decideMarking table. A plain click still
   works — press and release land on the same plate, and that fires. With the
   setting off, the legacy press-fires paths below run untouched. */
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !built) return;
  if (mixerOpen()) {
    // The card owns the screen: a press outside it closes the card and dies
    // there (the wheel gets its next press back); a press inside it belongs
    // to the card's own sliders/buttons — never to the marking gesture.
    if (!mixerHit(e)) closeMixer();
    return;
  }
  const hit = pointToHit(e.clientX, e.clientY);
  if (markingOn()) {
    markArmed = hit && hit.hub ? { hub: true } : (hit && hit.seg ? { seg: hit.seg } : { off: true });
    return;   // the release decides — nothing fires on press
  }
  markArmed = null;
  if (hit && hit.hub) {
    // With a sub-menu open the hub is the back-out button; the second click
    // (nothing left open) dismisses the wheel as always.
    if (nav && nav.back()) return;
    api.dismiss();
    return;
  }
  if (hit && hit.seg) {
    // Folder plates branch (and collapse with a latch) instead of firing —
    // a folder executes nothing. Leaf children ride the same click path.
    if (built.flyout.isFolder(hit.seg) && nav && nav.toggle(hit.seg)) return;
    fireSeg(hit.seg);
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  if (mixerOpen()) return;                    // release inside the card — no marking was armed anyway
  const press = markArmed;
  markArmed = null;
  if (!press || !built) return;                    // press-legacy mode, or no press ever armed
  const hit = pointToHit(e.clientX, e.clientY);
  const releaseSeg = hit && hit.seg ? hit.seg : null;
  const verdict = decideMarking({ pressSeg: press.seg || null, releaseSeg, onHub: !!(hit && hit.hub) });
  if (verdict === 'fire' && releaseSeg) {
    fireSeg(releaseSeg);                         // main hides the overlay + executes
  } else if (verdict === 'toggle' && releaseSeg) {
    // Folder plates (and main-resolved recents, which arrive as folders)
    // branch/collapse instead of firing — a container executes nothing.
    if (built.flyout.isFolder(releaseSeg) && nav) nav.toggle(releaseSeg);
  } else if (verdict === 'dismiss') {
    if (!(nav && nav.back())) api.dismiss();       // hub release = back out of the deepest fan, then dismiss
  }
  // 'cancel' — released off the wheel: no action, the wheel stays open
});

// Right-click dismiss is a setting, not a law: honor behavior.dismissOnRightClick.
// The payload is the full validated config, shipped fresh on every summon.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (mixerOpen()) { closeMixer(); return; }   // first right-click puts the card away
  const bh = lastPayload && lastPayload.config && lastPayload.config.behavior;
  if (!bh || bh.dismissOnRightClick !== false) api.dismiss();
});

/* ── Keyboard control ───────────────────────────────────────────────────────
   The overlay already takes focus on summon (windows.js showAtCursor calls
   win.focus()), so a plain keydown listener suffices. The hasFocus() guard is
   the fail-soft: if an exclusive-fullscreen app refuses to yield focus,
   arrows stay inert and the pointer path works exactly as before.
   ←/↑ walk backwards through the shared renderer's segment order (ring by
   ring, index by index), →/↓ forwards; the selection IS the hover visual —
   setHover + any-hover reuse the spring, sibling dim, and hub report, so no
   new styling vocabulary enters the overlay. Enter/Space fires the selection
   through the same ipc click path (main hides the overlay + executes);
   Esc-dismiss stays main-side in before-input-event (windows.js), which is
   what honors behavior.dismissOnEscape. */
let selIdx = -1;
let liveEl = null;

function ensureLive() {
  if (!liveEl) {
    liveEl = document.createElement('span');
    liveEl.setAttribute('aria-live', 'polite');
    liveEl.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap';
    document.body.appendChild(liveEl);
  }
  return liveEl;
}

function selectSeg(i) {
  if (!built) return;
  const segs = built.segments;
  if (!segs.length) return;
  selIdx = ((i % segs.length) + segs.length) % segs.length;
  const seg = segs[selIdx];
  built.setHover(seg);
  sound.hoverSeg(seg);   // the keyboard cursor ticks like the pointer does
  const rootG = document.querySelector('.wheel-root');
  if (rootG) rootG.classList.add('any-hover');
  rootEl.classList.add('has-hover');
  const isFly = !!seg.flyout;
  let ann = seg.item.label || seg.item.type || 'Segment';
  if (seg.item.type === 'folder') {
    const n = Array.isArray(seg.item.children) ? seg.item.children.length : 0;
    ann += ` \u2014 folder, ${n} items${built.flyout.isOpen(seg) ? ' \u2014 open, Enter closes' : ' \u2014 Enter opens'}`;
  } else {
    ann += isFly ? ' \u2014 in sub-menu' : ' \u2014 ring ' + seg.ring;
  }
  ensureLive().textContent = ann;
  // the keyboard cursor drives the same dwell machine as the pointer
  if (nav) nav.feed(seg, true);
}

/* Cycle the keyboard cursor through the current filter matches only. */
function stepFilter(dir) {
  if (!built) return;
  const list = built.segments.filter((s) => filterSegs.has(s));
  if (!list.length) return;
  const cur = selIdx >= 0 ? built.segments[selIdx] : null;
  let i = cur ? list.indexOf(cur) : -1;
  i = (((i + dir) % list.length) + list.length) % list.length;
  selectSeg(built.segments.indexOf(list[i]));
}

window.addEventListener('keydown', (e) => {
  if (!built || !document.hasFocus()) return;
  if (mixerOpen()) {
    // The card is up: the wheel's whole keyboard vocabulary stands down (the
    // focused slider owns arrows; typing belongs to nobody). Esc puts the
    // deepest thing away first — an OPEN device list, then the card itself —
    // main stood down on the wheel:filter flag so the key lands here; the next
    // Esc, with the flag released, reaches main's dismiss.
    if (e.key === 'Escape') {
      e.preventDefault();
      if (mxCloseOpenPickers()) return;
      closeMixer();
    }
    return;
  }
  const segs = built.segments;
  if (!segs.length) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (filterQuery && filterSegs.size) stepFilter(1);
    else selectSeg(selIdx < 0 ? 0 : selIdx + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (filterQuery && filterSegs.size) stepFilter(-1);
    else selectSeg(selIdx < 0 ? segs.length - 1 : selIdx - 1);
  } else if ((e.key === 'Enter' || e.key === ' ') && selIdx >= 0) {
    e.preventDefault();
    const seg = segs[selIdx];
    if (!seg) return;
    // Enter on a folder branches it (or collapses the latch); on a leaf it
    // fires through the same ipc path the pointer uses. With a filter query
    // running, Enter fires the glued match (a folder match branches instead).
    if (built.flyout.isFolder(seg) && nav && nav.toggle(seg)) { selectSeg(selIdx); return; }
    fireSeg(seg);
  } else if (e.key === 'Escape') {
    // A live query owns Esc: the first press clears it (main stands down via
    // the wheel:filter flag); once empty, the key reaches main's dismiss path.
    if (filterQuery) { e.preventDefault(); setFilterQuery(''); }
  } else if (e.key === 'Backspace') {
    if (filterQuery) { e.preventDefault(); setFilterQuery(filterQuery.slice(0, -1)); }
    // otherwise peel the deepest open sub-menu (no-op when nothing is branched)
    else if (nav && nav.back()) { e.preventDefault(); selIdx = -1; }
  } else if (filterOn() && !e.ctrlKey && !e.altKey && !e.metaKey &&
             e.key.length === 1 && e.key > ' ' && filterQuery.length < 16) {
    // Type to narrow: printable characters (Space stays the select-fire key).
    e.preventDefault();
    setFilterQuery(filterQuery + e.key);
  }
});

// never show a stale frame between pops
document.body.style.visibility = 'hidden';
