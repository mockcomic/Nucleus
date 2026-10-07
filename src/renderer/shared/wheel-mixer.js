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
      two never disagree about what a row is).
    - the endpoint helpers (pickDefaultDevice / deviceSignature /
      capDeviceList): what the card's two default-device pickers display —
      which entry is the system default, whether a re-read changed anything,
      and how much of the list fits the card before it collapses to
      "…and N more".

  Height budget: the tallest legal card is head + both master rows + both
  device rows + ONE open endpoint list (the two pickers are an accordion) +
  the app list shrunk for the occasion + the note line. wheel.css holds the
  matching max-heights, TALLEST_CARD_PX states the number, and PANEL_H_HI
  stays above it — under-report the reach and the card gets clipped by the
  overlay window. */

/* The card is a fixed-width widget; height is measured after mount and fed
   back in. Widths outside this band are treated as junk (the caller gets the
   default), so a broken measurement can never produce an absurd window. */
const PANEL_W_LO = 120, PANEL_W_HI = 420, PANEL_W_DEF = 264;
const PANEL_H_LO = 60, PANEL_H_HI = 640, PANEL_H_DEF = 320;

/* Height budget of the tallest card we expect the CSS caps to allow — measured
 * against a live mixer card with one endpoint list open and a full-length
 * error line on the note (wheel.css: .mx-dev-list / .mx-pickers-open
 * .mx-sessions hold the line heights). PANEL_H_CLAMP is the junk guard that
 * feeds the window-grow request: if a card ever outgrows it, the placement is
 * clamped to the smaller box and the bottom of the card can spill past the
 * overlay window — so tests/unit/wheel-mixer.test.js keeps the two in step. */
export const TALLEST_CARD_PX = 540;
export const PANEL_H_CLAMP = Object.freeze({ lo: PANEL_H_LO, hi: PANEL_H_HI });

/* Endpoint rows the device picker can hold before the rest collapse into the
 * note line as "…and N more" — the idiom MX_MAX_ROWS uses for app rows. */
export const MAX_VISIBLE_DEVICES = 5;

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

/* ---------------- default-device pickers (the card's two rows) --------------
   `devices` is main's listDevices answer: [{id, name, isDefault}]. Entries are
   OS-supplied, so every helper here is junk-tolerant and nothing here touches
   the DOM — wheel.js paints the result. */

/** True only for a usable endpoint entry (a string id is the one requirement). */
function isDevice(d) {
  return !!d && typeof d === 'object' && typeof d.id === 'string' && d.id !== '';
}

/** The endpoint Windows currently treats as this flow's default, or null
 *  (no default set at all is a real state — a disabled/removable device). */
export function pickDefaultDevice(devices) {
  if (!Array.isArray(devices)) return null;
  for (const d of devices) if (isDevice(d) && d.isDefault === true) return d;
  return null;
}

/** Cheap change detector for the 2 s poll: two lists paint identically iff
 *  their signatures match (id, name and default flag in enumeration order).
 *  Junk answers '' — which never equals a real signature, so a failed read
 *  cannot leave a stale list looking freshly re-read. */
export function deviceSignature(devices) {
  if (!Array.isArray(devices) || !devices.length) return '';
  const parts = [];
  for (const d of devices) {
    if (!isDevice(d)) continue;
    parts.push(d.id + '\u0000' + String(d.name == null ? '' : d.name) + '\u0000' + (d.isDefault ? '1' : '0'));
  }
  return parts.length ? parts.join('\u0001') : '';
}

/** Cap the visible list to what the card can hold: {items, extra} keeps
 *  Windows' own order (the caller never re-sorts endpoints) and reports how
 *  many rows fell to the "…and N more" line. The current default is pinned in
 *  view even when it sits past the cap. Junk list → empty, not null. */
export function capDeviceList(devices, max = MAX_VISIBLE_DEVICES) {
  const cap = (typeof max === 'number' && isFinite(max) && max > 0) ? Math.floor(max) : MAX_VISIBLE_DEVICES;
  const usable = (Array.isArray(devices) ? devices : []).filter(isDevice);
  if (usable.length <= cap) return { items: usable, extra: 0 };
  const items = usable.slice(0, cap);
  const def = pickDefaultDevice(usable);
  // The current default is always pinned into the visible window: a machine
  // with more endpoints than the cap must never hide the device the user is
  // listening through — they could not switch back from inside the card.
  if (def && items.indexOf(def) < 0) items[cap - 1] = def;
  return { items, extra: Math.max(0, usable.length - items.length) };
}
