import { buildWheel, createFlyoutNavigator } from '../shared/wheel-core.js';

const api = window.wheelAPI;
const rootEl = document.getElementById('root');

let built = null;
let lastPayload = null;
let nav = null;          // folder flyout dwell state machine (wheel-core)
let grownTo = 0;         // px the overlay window was last asked to cover

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
}

api.onShow((payload) => {
  lastPayload = payload;
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

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !built) return;
  const hit = pointToHit(e.clientX, e.clientY);
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

window.addEventListener('keydown', (e) => {
  if (!built || !document.hasFocus()) return;
  const segs = built.segments;
  if (!segs.length) return;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
    e.preventDefault();
    selectSeg(selIdx < 0 ? 0 : selIdx + 1);
  } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
    e.preventDefault();
    selectSeg(selIdx < 0 ? segs.length - 1 : selIdx - 1);
  } else if ((e.key === 'Enter' || e.key === ' ') && selIdx >= 0) {
    e.preventDefault();
    const seg = segs[selIdx];
    if (!seg) return;
    // Enter on a folder branches it (or collapses the latch); on a leaf it
    // fires through the same ipc path the pointer uses.
    if (built.flyout.isFolder(seg) && nav && nav.toggle(seg)) { selectSeg(selIdx); return; }
    api.clickSegment(seg.item);
  } else if (e.key === 'Backspace') {
    // peel the deepest open sub-menu (no-op when nothing is branched)
    if (nav && nav.back()) { e.preventDefault(); selIdx = -1; }
  }
});

// never show a stale frame between pops
document.body.style.visibility = 'hidden';
