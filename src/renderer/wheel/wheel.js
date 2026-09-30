import { buildWheel } from '../shared/wheel-core.js';

const api = window.wheelAPI;
const rootEl = document.getElementById('root');

let built = null;

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

api.onShow(({ config, scale, cursorLocal }) => {
  built = buildWheel(rootEl, config, { scale });
  document.body.style.visibility = 'visible';
  requestAnimationFrame(() => {
    applyHover(pointToHit(cursorLocal.x, cursorLocal.y));
  });
});

window.addEventListener('mousemove', (e) => applyHover(pointToHit(e.clientX, e.clientY)));

window.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !built) return;
  const hit = pointToHit(e.clientX, e.clientY);
  if (hit && hit.hub) { api.dismiss(); return; }
  if (hit && hit.seg) api.clickSegment(hit.seg.item); // main hides the overlay + executes
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  api.dismiss();
});

// never show a stale frame between pops
document.body.style.visibility = 'hidden';
