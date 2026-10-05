/* Pure geometry + keying for the `mixer` segment's in-wheel volume panel.
   Same discipline as wheel-core's decideMarking/rankMatches: no DOM, no API
   calls — the overlay (wheel.js) owns the card's DOM and the audio round
   trips; everything decidable-about-the-card-in-advance lives here so the
   node tests cover it (tests/unit/wheel-mixer.test.js).

    - computePanelLayout: where the card sits, anchored outward along the
      triggering segment's center ray, and how far the transparent overlay
      window must grow (reachPx) to keep the whole card on-screen.
    - mixerRowKey: the stable identity of one mixer row across polls
      ('app:'+pid, 'sys:'+pid — same keying as the Settings Audio tab so the
      two never disagree about what a row is). */

/* The card is a fixed-width widget; height is measured after mount and fed
   back in. Widths outside this band are treated as junk (the caller gets the
   default), so a broken measurement can never produce an absurd window. */
const PANEL_W_LO = 120, PANEL_W_HI = 420, PANEL_W_DEF = 264;
const PANEL_H_LO = 60, PANEL_H_HI = 460, PANEL_H_DEF = 320;

const num = (v, d) => (typeof v === 'number' && isFinite(v)) ? v : d;

/**
 * Axis-aligned card anchored outward from the wheel center along the
 * segment's center ray (angle convention shared with wheel-core: degrees,
 * 0 = 12 o'clock, clockwise). The card's NEAR edge starts `gap` px past the
 * wheel's outer radius; it then extends along the ray. With halfSize > 0 the
 * box is clamped inside the square [cx±halfSize, cy±halfSize] — pass the
 * CURRENT window half when repositioning after a grow, or 0 for the ideal
 * (unclamped) placement whose reachPx drives the grow request. If the square
 * is smaller than the card, the card centers on the window instead (nothing
 * to anchor into — a tiny window beats an unreachable slider).
 *
 * Returns { x, y, w, h, reachPx } in window-space px: (x, y) is the card's
 * top-left, reachPx the farthest card corner's distance from (cx, cy) —
 * exactly what Overlay.grow needs (via the host's requestRoom path).
 */
export function computePanelLayout({
  centerDeg = 0, outerRadius = 0,
  panelW = PANEL_W_DEF, panelH = PANEL_H_DEF,
  cx = 0, cy = 0, gap = 10, halfSize = 0
} = {}) {
  centerDeg = num(centerDeg, 0);
  outerRadius = Math.max(0, num(outerRadius, 0));
  panelW = Math.min(PANEL_W_HI, Math.max(PANEL_W_LO, num(panelW, PANEL_W_DEF)));
  panelH = Math.min(PANEL_H_HI, Math.max(PANEL_H_LO, num(panelH, PANEL_H_DEF)));
  cx = num(cx, 0); cy = num(cy, 0);
  gap = Math.min(48, Math.max(0, num(gap, 10)));
  halfSize = Math.max(0, num(halfSize, 0));

  const a = (centerDeg - 90) * Math.PI / 180;
  // Far-enough: the card center sits one half-extent beyond rim+gap along
  // the ray, so even the box's widest orientation clears the plates.
  const dist = outerRadius + gap + Math.max(panelW, panelH) / 2;
  let bx = cx + Math.cos(a) * dist;
  let by = cy + Math.sin(a) * dist;

  if (halfSize > 0) {
    const lo = cx - halfSize, hi = cx + halfSize;
    const clampAxis = (b, extent, fallback) =>
      (hi - lo >= extent) ? Math.min(Math.max(b, lo + extent / 2), hi - extent / 2) : fallback;
    const mid = (lo + hi) / 2;
    bx = clampAxis(bx, panelW, mid);
    by = clampAxis(by, panelH, mid);
  }

  const x = bx - panelW / 2, y = by - panelH / 2;
  const dx = Math.max(Math.abs(x - cx), Math.abs(x + panelW - cx));
  const dy = Math.max(Math.abs(y - cy), Math.abs(y + panelH - cy));
  return { x, y, w: panelW, h: panelH, reachPx: Math.hypot(dx, dy) };
}

/** Stable row identity across polls — system sounds keeps its own row
 *  (mixer semantics), every app row is its process id. Junk → ''. */
export function mixerRowKey(s) {
  if (!s || typeof s !== 'object' || !Number.isFinite(s.pid)) return '';
  return (s.isSystem ? 'sys:' : 'app:') + s.pid;
}

/** The one predicate the overlay handlers share: is this item a mixer
 *  trigger? (Junk items answer false, so gestures fall through unchanged.) */
export function isMixerItem(item) {
  return !!item && typeof item === 'object' && item.type === 'mixer';
}
