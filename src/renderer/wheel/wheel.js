import { buildWheel, createFlyoutNavigator, decideMarking, rankMatches } from '../shared/wheel-core.js';

const api = window.wheelAPI;
const rootEl = document.getElementById('root');

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

function mountWheel(config, scale, preview) {
  built = buildWheel(rootEl, config, { scale, iconImages: iconCache, preview: !!preview });
  nav = createFlyoutNavigator(built, {
    dwellMs: (config.behavior && config.behavior.flyoutDwellMs) || 0,
    onGrow: requestRoom
  });
  selIdx = -1;
  grownTo = 0;
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
        if (restored) applyHover({ seg: restored });                  // don't pop hover/hub-report state
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

function applyHover(hit) {
  if (!built) return;
  const seg = hit && hit.seg ? hit.seg : null;
  built.setHover(seg);
  // keep the keyboard cursor glued to what the pointer shows — Enter fires
  // the hovered segment; moving off it clears the selection too.
  selIdx = seg ? built.segments.indexOf(seg) : -1;
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
  filterQuery = '';
  filterSegs = new Set();
  api.setFiltering(false);     // ...or a stale Esc-ownership flag
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

window.addEventListener('mousemove', (e) => applyHover(pointToHit(e.clientX, e.clientY)));

/* ── selection ──────────────────────────────────────────────────────────────
   behavior.markingSelect (default ON) turns selection into a marking gesture:
   arm on left-press, follow the sweep with the existing hover path, decide on
   RELEASE via the pure wheel-core.decideMarking table. A plain click still
   works — press and release land on the same plate, and that fires. With the
   setting off, the legacy press-fires paths below run untouched. */
window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !built) return;
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
    api.clickSegment(hit.seg.item); // main hides the overlay + executes
  }
});

window.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const press = markArmed;
  markArmed = null;
  if (!press || !built) return;                    // press-legacy mode, or no press ever armed
  const hit = pointToHit(e.clientX, e.clientY);
  const releaseSeg = hit && hit.seg ? hit.seg : null;
  const verdict = decideMarking({ pressSeg: press.seg || null, releaseSeg, onHub: !!(hit && hit.hub) });
  if (verdict === 'fire' && releaseSeg) {
    api.clickSegment(releaseSeg.item);             // main hides the overlay + executes
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
    api.clickSegment(seg.item);
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
