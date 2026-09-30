import { buildWheel } from '../shared/wheel-core.js';

const api = window.wheelAPI;
const rootEl = document.getElementById('root');

let built = null;
let lastPayload = null;

/* Dashboard Icons logos, memoized across show cycles: slug -> dataUrl (null
   once resolved as failed so we don't hammer the CDN while offline). */
const iconCache = new Map();
const iconPending = new Set();

function itemSlugs(config) {
  const slugs = new Set();
  for (const arr of (config && config.rings ? Object.values(config.rings) : [])) {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (it && it.iconImage) slugs.add(it.iconImage);
    }
  }
  return [...slugs];
}

function ensureIcons(config) {
  for (const slug of itemSlugs(config)) {
    if (iconCache.has(slug) || iconPending.has(slug)) continue;
    iconPending.add(slug);
    api.iconDataUrl(slug).then((r) => {
      iconPending.delete(slug);
      const url = r && r.ok ? r.dataUrl : null;
      if (iconCache.has(slug)) return;                       // newer info won
      iconCache.set(slug, url);
      // Quietly rebuild the overlay once so the freshly-downloaded logo pops in.
      // preview:true suppresses the re-pop animation — this is a silent refresh.
      if (built && lastPayload && lastPayload.config === config) {
        built = buildWheel(rootEl, config, { scale: lastPayload.scale, iconImages: iconCache, preview: true });
      }
    }).catch(() => {
      iconPending.delete(slug);
      if (!iconCache.has(slug)) iconCache.set(slug, null);
    });
  }
}

function pointToHit(x, y) {
  if (!built) return null;
  return built.hitTest(x, y);
}

function applyHover(hit) {
  if (!built) return;
  const seg = hit && hit.seg ? hit.seg : null;
  built.setHover(seg);
  const rootG = document.querySelector('.wheel-root');
  if (rootG) rootG.classList.toggle('any-hover', !!seg);
  rootEl.classList.toggle('has-hover', !!seg || (hit && hit.hub));
}

api.onShow((payload) => {
  lastPayload = payload;
  built = buildWheel(rootEl, payload.config, { scale: payload.scale, iconImages: iconCache });
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
  if (hit && hit.hub) { api.dismiss(); return; }
  if (hit && hit.seg) api.clickSegment(hit.seg.item); // main hides the overlay + executes
});

// Right-click dismiss is a setting, not a law: honor behavior.dismissOnRightClick.
// The payload is the full validated config, shipped fresh on every summon.
window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const bh = lastPayload && lastPayload.config && lastPayload.config.behavior;
  if (!bh || bh.dismissOnRightClick !== false) api.dismiss();
});

// never show a stale frame between pops
document.body.style.visibility = 'hidden';
