/* Shared radial wheel renderer — used by both the live overlay and the settings preview,
   so what you edit is literally what you get.

   Folder segments (item.type === 'folder') carry an inline `children` sub-menu.
   They render with an outward chevron; when the host asks (via the dwell
   navigator below, or directly), their children branch out as a flyout: an
   annular fan centered on the parent's angle, stacked just outside the
   parent's outer edge. Nested folders stack further bands outward — the
   config caps the data tree at MAX_FOLDER_DEPTH levels (src/main/config.js),
   and a depth fuse here mirrors that ceiling. */

export const PAD = 26;
export const ICON_FONT = "'Segoe Fluent Icons','Segoe MDL2 Assets',system-ui";
export const UI_FONT = "'Segoe UI',system-ui,sans-serif";
/* Segoe Fluent/MDL2 ChevronRight — rotated outward on folder plates. */
export const CHEVRON_GLYPH = '\uE76C';

/* Flyout fan tuning: each child gets at least MIN_STEP degrees; the whole
   fan blooms to at most 3× the parent's sweep or MAX_SPAN degrees. */
const FLY_MIN_STEP = 14;
const FLY_MAX_SPAN = 300;
const FLY_GAP = 3;          // radial air between the parent plate and its fan
const FLY_DEPTH_LO = 44;    // fan band depth (scaled px), clamped
const FLY_DEPTH_HI = 84;
/* Data-side depth cap (config.js) is 3; this is the renderer's cycle fuse. */
export const MAX_FLY_LEVELS = 4;
/* How long the pointer may leave the open family before the fan collapses. */
export const FLY_CLOSE_GRACE = 140;

/* angle convention: degrees, 0 = 12 o'clock, increasing clockwise */
export function degToXY(cx, cy, r, deg) {
  const a = (deg - 90) * Math.PI / 180;
  return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
}

/* Bands between innerRadius and outerRadius, shared by the non-empty rings in
   index order (empty rings render nothing and consume no band — an empty ring
   2 lets ring 1 fill to the outer edge, as it always has). Two live bands keep
   the Ring split slider's semantics; three or more divide equally. */
export function ringSpans(cfg) {
  const ap = cfg.appearance;
  const keys = Object.keys(cfg.rings || {})
    .map(Number)
    .filter((n) => Number.isInteger(n) && n >= 1)
    .sort((a, b) => a - b);
  const active = keys
    .map((n) => ({ ring: n, items: cfg.rings[n] || cfg.rings[String(n)] || [] }))
    .filter((r) => r.items.length);
  if (!active.length) return [];
  const span = ap.outerRadius - ap.innerRadius;
  if (span <= 0) return [];   // no band (should be impossible post-validate) — degrade to hub-only instead of an unhittable dial
  const out = [];
  for (let i = 0; i < active.length; i++) {
    const f0 = active.length === 1 ? 0 : i / active.length;
    const f1 = active.length === 1 ? 1 : (i + 1) / active.length;
    active[i].r0 = ap.innerRadius + span * f0;
    active[i].r1 = ap.innerRadius + span * f1;
    out.push(active[i]);
  }
  if (active.length === 2) {
    const mid = ap.innerRadius + span * ap.ringSplit;
    out[0].r1 = mid;
    out[1].r0 = mid;
  }
  return out;
}

/* Fan geometry for one folder's children, as pure offsets from the parent's
   center angle: total span + per-child step. Exported for tests. */
export function fanSpans(parentDeg, n) {
  if (!(n > 0)) return { span: 0, step: 0 };
  const span = Math.min(FLY_MAX_SPAN, Math.max(parentDeg * 3, n * FLY_MIN_STEP));
  return { span, step: span / n };
}

/* ── marking selection (press → drag → release), pure verdict ────────────────
   The overlay arms on left-press and decides on release; this is the whole
   decision, exported so node tests cover the table without a DOM.
     onHub     — the release landed on the hub (back-out / dismiss semantics)
     releaseSeg— the segment under the pointer at release (null = off the wheel)
   A release on the SAME plate as the press is an ordinary click and fires —
   which is why marking can default ON without changing click behavior. */
export function decideMarking({ pressSeg = null, releaseSeg = null, onHub = false } = {}) {
  void pressSeg;                       // kept in the contract for callers/tests; today the release alone decides
  if (onHub) return 'dismiss';
  if (!releaseSeg) return 'cancel';    // flung off the wheel: nothing fires, the wheel stays open
  if (releaseSeg.item && releaseSeg.item.type === 'folder') return 'toggle';
  return 'fire';
}

/* ── type-to-filter ranking, pure ────────────────────────────────────────────
   Case-insensitive substring over label (prefix first — the best match should
   win ties of length) then over value; junk entries and an empty query yield
   no matches. Returns the matched ITEM objects in rank order. */
export function rankMatches(items, query) {
  const q = String(query || '').toLowerCase().trim();
  if (!q) return [];
  const score = (it) => {
    if (!it || typeof it !== 'object') return -1;
    const label = String(it.label || '').toLowerCase();
    const value = String(it.value || '').toLowerCase();
    if (label.startsWith(q)) return 0;
    if (label.includes(q)) return 1;
    if (value && value.includes(q)) return 2;
    return -1;
  };
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const s = score(it);
    if (s >= 0) out.push({ it, s });
  }
  out.sort((a, b) => a.s - b.s);
  return out.map((o) => o.it);
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

/* opts.iconImages is a slug→dataUrl Map (or plain object) filled by the host
   renderer; an unset/failed lookup degrades to the glyph icon, never to blank. */
function iconHrefFor(opts, slug) {
  if (!slug || !opts || !opts.iconImages) return null;
  const m = opts.iconImages;
  const v = typeof m.get === 'function' ? m.get(slug) : m[slug];
  return typeof v === 'string' && v ? v : null;
}

function annulusFull(cx, cy, r0, r1) {
  const c = (r, sweep) =>
    `M ${cx - r} ${cy} A ${r} ${r} 0 1 ${sweep} ${cx + r} ${cy} A ${r} ${r} 0 1 ${sweep} ${cx - r} ${cy} Z`;
  return c(r1, 1) + ' ' + c(r0, 0);
}

export function sectorPath(cx, cy, r0, r1, a0, a1) {
  if (a1 - a0 >= 359.99) return annulusFull(cx, cy, r0, r1);
  const large = (a1 - a0) > 180 ? 1 : 0;
  const [x0o, y0o] = degToXY(cx, cy, r1, a0);
  const [x1o, y1o] = degToXY(cx, cy, r1, a1);
  const [x0i, y0i] = degToXY(cx, cy, r0, a0);
  const [x1i, y1i] = degToXY(cx, cy, r0, a1);
  return `M ${x0o} ${y0o} A ${r1} ${r1} 0 ${large} 1 ${x1o} ${y1o} L ${x1i} ${y1i} A ${r0} ${r0} 0 ${large} 0 ${x0i} ${y0i} Z`;
}

/* Shared plate decoration for ring segments AND flyout children: the hover
   lift vector, icon (logo image or glyph), truncated label, and the folder
   chevron. Returns the resolved imgHref for the segment record. */
function paintItemContent(g, item, cx, cy, r0, r1, center, ap, opts) {
  const band = r1 - r0;
  const rm = (r0 + r1) / 2;
  const midRad = (center - 90) * Math.PI / 180;
  const tx = (Math.cos(midRad) * 3).toFixed(2), ty = (Math.sin(midRad) * 3).toFixed(2);
  g.style.setProperty('--tx', tx + 'px');
  g.style.setProperty('--ty', ty + 'px');

  const imgHref = iconHrefFor(opts, item.iconImage);
  const showIcon = !!item.icon || !!imgHref;
  const showLabel = ap.showLabels && !!item.label && !item.hideLabel;
  const iconSize = Math.max(13, Math.min(26, band * 0.30));

  if (showIcon) {
    const ir = showLabel ? rm - band * 0.10 : rm;
    const [ix, iy] = degToXY(cx, cy, ir, center);
    if (imgHref) {
      // A color logo reads better a touch larger than a mono glyph.
      const w = Math.max(17, Math.min(34, band * 0.40));
      g.appendChild(svgEl('image', {
        href: imgHref, x: ix - w / 2, y: iy - w / 2, width: w, height: w,
        preserveAspectRatio: 'xMidYMid meet', class: 'seg-img'
      }));
    } else {
      const t = svgEl('text', {
        x: ix, y: iy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
        'font-family': ICON_FONT, 'font-size': iconSize, fill: ap.colors.text, class: 'seg-icon'
      });
      t.textContent = item.icon;
      g.appendChild(t);
    }
  }
  if (showLabel) {
    const lr = showIcon ? rm + band * 0.20 : rm;
    const [lx, ly] = degToXY(cx, cy, lr, center);
    const t = svgEl('text', {
      x: lx, y: ly + 1, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': UI_FONT, 'font-size': ap.fontSize, 'font-weight': 600,
      fill: ap.colors.text, class: 'seg-label'
    });
    t.textContent = item.label;
    const maxChars = Math.max(6, Math.floor((band * 0.85) / (ap.fontSize * 0.55)));
    if (item.label.length > maxChars) t.textContent = item.label.slice(0, maxChars - 1) + '…';
    g.appendChild(t);
  }
  if (item.type === 'folder' && Array.isArray(item.children) && item.children.length && band >= 26) {
    // Small outward chevron riding the plate's outer edge — the sub-menu affordance.
    const cr = r1 - Math.min(10, band * 0.16);
    const [px, py] = degToXY(cx, cy, cr, center);
    const t = svgEl('text', {
      x: px, y: py, 'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-family': ICON_FONT, 'font-size': Math.max(9, Math.min(13, band * 0.22)),
      fill: ap.colors.text, 'fill-opacity': 0.85, class: 'seg-chevron',
      transform: `rotate(${(center - 90).toFixed(2)} ${px.toFixed(2)} ${py.toFixed(2)})`
    });
    t.textContent = CHEVRON_GLYPH;
    g.appendChild(t);
  }
  return imgHref;
}

/**
 * Build the wheel into `container`. Returns { cfg, segments, setHover, hitTest,
 * flyout, center, size } (see below for the flyout API).
 * opts: { preview?:bool, scale?:number, pad?:number }
 */
/* Def ids must be unique PER WHEEL, not per document: the settings page hosts
   thirteen wheels at once (preview + twelve theme chips). With a shared id,
   url(#rwdrop) resolves to the first one in document order — a chip inside the
   collapsed Appearance tab — and Chromium then skips painting the preview's
   entire shadow layer (all plates, icons, labels), making the live preview
   look frozen whenever the theme gallery was built first. */
let _wheelSeq = 0;

export function buildWheel(container, cfg, opts = {}) {
  const uid = 'rw' + (++_wheelSeq);
  const dropId = uid + '-drop', topId = uid + '-top', hubId = uid + '-hub';
  const scale = opts.scale == null ? 1 : opts.scale;
  const pad = opts.pad == null ? PAD : opts.pad;
  const s = { ...cfg, appearance: { ...cfg.appearance } };
  s.appearance.innerRadius = cfg.appearance.innerRadius * scale;
  s.appearance.outerRadius = cfg.appearance.outerRadius * scale;
  const size = s.appearance.outerRadius * 2 + pad * 2;
  const cx = size / 2, cy = size / 2;
  const ap = s.appearance;

  container.innerHTML = '';
  const svg = svgEl('svg', {
    width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'wheel-svg'
  });
  const root = svgEl('g', { class: 'wheel-root' });
  svg.appendChild(root);

  const shadow = svgEl('g', { class: 'shadow-layer', filter: `url(#${dropId})` });
  const defs = svgEl('defs');
  const filt = svgEl('filter', { id: dropId, x: '-40%', y: '-40%', width: '180%', height: '180%' });
  /* Theme persona (see themes.mjs): light themes carry rgba() values the
     settings chrome computed; untouched, the machined-midnight defaults. */
  const persona = {
    shadow: ap.colors.shadow || 'rgba(0,0,0,0.55)',
    edge: ap.colors.edge || 'rgba(255,255,255,0.06)',
    rim: ap.colors.stroke || 'rgba(255,255,255,0.08)',
    light: ap.colors.sheen || '#ffffff',
  };
  const blur = opts.shadowBlur == null ? 14 : opts.shadowBlur;
  const feDrop = svgEl('feDropShadow', { dx: '0', dy: opts.shadowDy == null ? 6 : opts.shadowDy, stdDeviation: String(blur), 'flood-color': persona.shadow });
  filt.appendChild(feDrop); defs.appendChild(filt);
  /* Machined top-light: one off-center specular wash over the whole dial, and a
     lit crown on the hub — depth from light on solid matter, never from glow. */
  const topGrad = svgEl('radialGradient', { id: topId, cx: '32%', cy: '16%', r: '95%' });
  topGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': persona.light, 'stop-opacity': '0.06' }));
  topGrad.appendChild(svgEl('stop', { offset: '55%', 'stop-color': persona.light, 'stop-opacity': '0.015' }));
  topGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': persona.light, 'stop-opacity': '0' }));
  defs.appendChild(topGrad);
  const hubGrad = svgEl('radialGradient', { id: hubId, cx: '38%', cy: '26%', r: '90%' });
  hubGrad.appendChild(svgEl('stop', { offset: '0%', 'stop-color': persona.light, 'stop-opacity': '0.07' }));
  hubGrad.appendChild(svgEl('stop', { offset: '60%', 'stop-color': persona.light, 'stop-opacity': '0.02' }));
  hubGrad.appendChild(svgEl('stop', { offset: '100%', 'stop-color': persona.light, 'stop-opacity': '0' }));
  defs.appendChild(hubGrad);
  svg.insertBefore(defs, root);

  const segments = [];
  const gap = Math.min(ap.gapDeg, 10);

  for (const rg of ringSpans(s)) {
    const n = rg.items.length;
    if (!n) continue;
    const step = 360 / n;
    const gRing = svgEl('g', { class: `ring ring${rg.ring}` });
    rg.items.forEach((item, i) => {
      const center = ap.startAngle + i * step;
      const halfSpan = step / 2;
      const a0 = center - halfSpan + (gap / 2);
      const a1 = center + halfSpan - (gap / 2);
      const g = svgEl('g', { class: 'seg' });
      const plateFill = item.color || ap.colors[rg.ring % 2 === 1 ? 'ring1' : 'ring2'];
      const path = svgEl('path', {
        d: sectorPath(cx, cy, rg.r0, rg.r1, a0, a1),
        /* Plates alternate outward: odd rings the ring1 tint, even rings ring2. */
        fill: plateFill,
        stroke: persona.edge, 'stroke-width': 1,
        'fill-rule': 'evenodd'
      });
      g.appendChild(path);

      const imgHref = paintItemContent(g, item, cx, cy, rg.r0, rg.r1, center, ap, opts);
      gRing.appendChild(g);
      segments.push({ el: g, path, item, imgHref, ring: rg.ring, r0: rg.r0, r1: rg.r1, center, halfSpan, baseFill: plateFill });
    });
    shadow.appendChild(gRing);
  }
  root.appendChild(shadow);

  /* Lit-from-above pass over the plates + a machined rim on the outer edge.
     Purely decorative discs — pointer-events stay with the geometry hit-test. */
  root.appendChild(svgEl('circle', { cx, cy, r: ap.outerRadius, fill: `url(#${topId})`, class: 'top-light' }));
  root.appendChild(svgEl('circle', { cx, cy, r: ap.outerRadius, fill: 'none', stroke: persona.rim, 'stroke-width': 1, class: 'rim' }));

  /* hub */
  const hub = svgEl('circle', {
    cx, cy, r: ap.innerRadius, fill: ap.colors.center,
    stroke: ap.colors.accent, 'stroke-opacity': 0.22, 'stroke-width': 1.5, class: 'hub'
  });
  root.appendChild(hub);
  root.appendChild(svgEl('circle', { cx, cy, r: ap.innerRadius, fill: `url(#${hubId})`, class: 'hub-top' }));
  const hubIcon = svgEl('text', {
    x: cx, y: cy - 12, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': ICON_FONT, 'font-size': Math.min(34, ap.innerRadius * 0.42), fill: ap.colors.text, class: 'hub-icon'
  });
  /* Hovered segment's dashboard logo (same slot as hubIcon, image wins). */
  const hubImgSize = Math.max(24, Math.min(44, ap.innerRadius * 0.62));
  const hubImg = svgEl('image', {
    x: cx - hubImgSize / 2, y: (cy - 12) - hubImgSize / 2, width: hubImgSize, height: hubImgSize,
    preserveAspectRatio: 'xMidYMid meet', class: 'hub-img', visibility: 'hidden'
  });
  const hubLabel = svgEl('text', {
    x: cx, y: cy + Math.min(30, ap.innerRadius * 0.40), 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': UI_FONT, 'font-size': Math.max(11, ap.fontSize), 'font-weight': 600, 'letter-spacing': '0.4',
    fill: ap.colors.text, class: 'hub-label'
  });
  const centerLabel = svgEl('text', {
    x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': UI_FONT, 'font-size': Math.max(12, ap.fontSize), 'font-weight': 600, 'letter-spacing': '0.8',
    fill: ap.colors.text, 'fill-opacity': 0.85, class: 'center-label'
  });
  centerLabel.textContent = ap.centerLabel || '';
  /* Type-to-filter readout: the query lives in the hub while typing (CSS
     hides the hub-report layers under .wheel-root.filtering so they can't
     collide with it). */
  const filterText = svgEl('text', {
    x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': UI_FONT, 'font-size': Math.max(13, ap.fontSize + 2), 'font-weight': 600, 'letter-spacing': '0.6',
    fill: ap.colors.accent, visibility: 'hidden', class: 'filter-text'
  });
  root.appendChild(hubIcon); root.appendChild(hubImg); root.appendChild(hubLabel); root.appendChild(centerLabel);
  root.appendChild(filterText);

  const prefersReducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (ap.animationMs > 0 && !opts.preview && !prefersReducedMotion) {
    root.style.animation = `wheelpop ${ap.animationMs}ms cubic-bezier(.34,1.56,.64,1)`;
    root.addEventListener('animationend', () => { root.style.animation = ''; }, { once: true });
  }

  container.appendChild(svg);

  let hovered = null;
  function setHover(seg) {
    if (hovered === seg) return;
    if (hovered) {
      hovered.el.classList.remove('hovered');
      hovered.path.setAttribute('fill', hovered.baseFill);
    }
    hovered = seg || null;
    if (hovered) {
      hovered.el.classList.add('hovered');
      hovered.path.setAttribute('fill', ap.colors.hover);
      if (hovered.imgHref) {
        hubImg.setAttribute('href', hovered.imgHref);
        hubImg.setAttribute('visibility', 'visible');
        hubIcon.textContent = '';
      } else {
        hubImg.removeAttribute('href');
        hubImg.setAttribute('visibility', 'hidden');
        hubIcon.textContent = hovered.item.icon || '';
      }
      hubLabel.textContent = hovered.item.label || '';
      centerLabel.setAttribute('fill-opacity', hovered.item.label || hovered.item.icon || hovered.imgHref ? 0 : 0.85);
    } else {
      hubIcon.textContent = '';
      hubImg.removeAttribute('href');
      hubImg.setAttribute('visibility', 'hidden');
      hubLabel.textContent = '';
      centerLabel.setAttribute('fill-opacity', ap.centerLabel ? 0.85 : 0);
    }
  }

  /* ── folder flyouts ───────────────────────────────────────────────────────
     Each open level is { parentSeg, group, segs, r1f }. Children of the same
     parent stack outward from its plate; opening a level closes anything at
     the same depth on a different parent AND everything deeper. Flyout segs
     ride the shared `segments` array (so hover, hub-report, and keyboard
     walking come for free) and hitTest scans LAST-IN first, which gives the
     fan priority over the ring plates it overlays. */
  const flyGroups = [];

  const isFolderSeg = (seg) => !!seg && !!seg.item && seg.item.type === 'folder' &&
    Array.isArray(seg.item.children) && seg.item.children.length > 0;

  function occlusionCheck(seg, parentSeg, r0f, r1f) {
    if (seg.flyout) return false;                    // other fans manage themselves
    if (seg.r1 <= r0f - 1) return false;             // band below the fan
    const d = Math.abs(((seg.center - parentSeg.center + 540) % 360) - 180);
    const { span } = fanSpans(parentSeg.halfSpan * 2, parentSeg.item.children.length);
    return d < span / 2 + seg.halfSpan;
  }
  function refreshOcclusion() {
    for (const seg of segments) {
      if (seg.flyout) continue;
      let covered = false;
      for (const f of flyGroups) if (occlusionCheck(seg, f.parentSeg, f.r0f, f.r1f)) { covered = true; break; }
      seg.el.classList.toggle('occluded', covered);
    }
  }

  function openFlyout(parentSeg) {
    if (!isFolderSeg(parentSeg)) return false;
    if (flyGroups.some((f) => f.parentSeg === parentSeg)) return true;   // already open
    const depth = parentSeg.flyout ? parentSeg.flyLevel + 1 : 0;
    if (depth >= MAX_FLY_LEVELS) return false;                            // cycle fuse
    // Anything at or deeper than this level belongs to a different branch now.
    while (flyGroups.length > depth) closeTop();
    const band = parentSeg.r1 - parentSeg.r0;
    const depthPx = Math.max(FLY_DEPTH_LO, Math.min(FLY_DEPTH_HI, band * 0.45));
    const r0f = parentSeg.r1 + FLY_GAP;
    const r1f = r0f + depthPx;
    const kids = parentSeg.item.children;
    const { span, step } = fanSpans(parentSeg.halfSpan * 2, kids.length);
    const gFly = svgEl('g', { class: 'flyout' });
    const made = [];
    kids.forEach((child, i) => {
      const center = parentSeg.center - span / 2 + step * (i + 0.5);
      const halfSpan = step / 2 - gap / 2;
      const g = svgEl('g', { class: 'seg seg-fly' });
      // A child inherits its parent's plate tint unless it picks its own color —
      // the fan reads as one branch, matching-machined, like a real folder.
      const plateFill = child.color || parentSeg.baseFill;
      const path = svgEl('path', {
        d: sectorPath(cx, cy, r0f, r1f, center - halfSpan, center + halfSpan),
        fill: plateFill, stroke: persona.edge, 'stroke-width': 1, 'fill-rule': 'evenodd'
      });
      g.appendChild(path);
      const imgHref = paintItemContent(g, child, cx, cy, r0f, r1f, center, ap, opts);
      gFly.appendChild(g);
      const rec = {
        el: g, path, item: child, imgHref, ring: parentSeg.ring,
        flyout: true, flyLevel: depth, parentSeg,
        r0: r0f, r1: r1f, center, halfSpan: Math.max(2, halfSpan), baseFill: plateFill
      };
      made.push(rec);
      segments.push(rec);
    });
    // Branch the fan from the hub centre — the entrance scales about the wheel
    // centre so plates read as growing outward from the parent. Parented into
    // the shadow layer with the ring plates: same machined drop shadow, and
    // the top-light/rim wash still rides over everything.
    shadow.appendChild(gFly);
    gFly.style.transformBox = 'view-box';
    gFly.style.transformOrigin = `${cx}px ${cy}px`;
    flyGroups.push({ parentSeg, group: gFly, segs: made, r0f, r1f });
    parentSeg.el.classList.add('fly-parent');
    parentSeg.path.setAttribute('fill', ap.colors.hover);
    refreshOcclusion();
    return true;
  }

  function closeTop() {
    const f = flyGroups.pop();
    if (!f) return;
    // A child of this fan holding the hover (or the keyboard cursor) must
    // release it before its plates go away; hovering the parent plate stays.
    if (hovered && f.segs.indexOf(hovered) >= 0) setHover(null);
    for (const s of f.segs) {
      const i = segments.indexOf(s);
      if (i >= 0) segments.splice(i, 1);
    }
    f.group.remove();
    f.parentSeg.el.classList.remove('fly-parent');
    if (hovered !== f.parentSeg) f.parentSeg.path.setAttribute('fill', f.parentSeg.baseFill);
    refreshOcclusion();
  }
  function closeFlyouts(fromLevel = 0) {
    while (flyGroups.length > fromLevel) closeTop();
  }

  const flyout = {
    open: openFlyout,
    closeAll: () => closeFlyouts(0),
    // Close a level and everything deeper than it.
    closeLevel: (depth) => closeFlyouts(Math.max(0, depth)),
    isOpen: (seg) => flyGroups.some((f) => f.parentSeg === seg),
    depthOf: (seg) => flyGroups.findIndex((f) => f.parentSeg === seg),
    levels: () => flyGroups.length,
    isFolder: isFolderSeg,
    // Furthest radius currently painted (for the host's window-grow request).
    reach: () => (flyGroups.length ? flyGroups[flyGroups.length - 1].r1f : 0),
    // Is this seg part of an open family (the fan's children or its parent chain)?
    inOpenFamily: (seg) => {
      if (!seg) return false;
      for (let s = seg; s; s = s.parentSeg || null) if (flyGroups.some((f) => f.parentSeg === s)) return true;
      return false;
    }
  };

  function hitTest(px, py) {
    const dx = px - cx, dy = py - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < ap.innerRadius) return { hub: true, dist };
    let deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    // Scan outward-in: flyout children (appended last) take priority over the
    // ring plates they visually cover; deeper fans over shallower ones.
    for (let i = segments.length - 1; i >= 0; i--) {
      const seg = segments[i];
      if (dist < seg.r0 - 1 || dist > seg.r1 + 1) continue;
      let d = Math.abs(deg - ((seg.center % 360) + 360) % 360);
      d = Math.min(d, 360 - d);
      if (d <= seg.halfSpan) return { seg, dist };
    }
    return null;
  }

  /* Type-to-filter display. The host (overlay only) re-applies after any fan
     open/close — freshly created flyout plates need their dim class too.
     state: null = clear; { query, segs:Set<seg> } = dim everything unlisted. */
  function applyFilter(state) {
    const on = !!(state && String(state.query || '').length);
    root.classList.toggle('filtering', on);
    for (const seg of segments) {
      const dim = on && !(state.segs && state.segs.has(seg));
      seg.el.classList.toggle('filtered', dim);
    }
    if (on) {
      filterText.textContent = String(state.query);
      filterText.setAttribute('visibility', 'visible');
      centerLabel.setAttribute('fill-opacity', '0');
    } else {
      filterText.textContent = '';
      filterText.setAttribute('visibility', 'hidden');
      centerLabel.setAttribute('fill-opacity', ap.centerLabel ? '0.85' : '0');
    }
  }

  // Force the "nothing hovered" hub reset once at build time — the
  // hovered===seg guard would otherwise skip it (hovered already starts as
  // null, so a plain setHover(null) was a dead no-op; harmless only while the
  // build-time defaults below coincided with this reset).
  hovered = undefined;
  setHover(null);
  return { cfg: s, size, segments, setHover, hitTest, flyout, applyFilter, center: { cx, cy }, outerRadius: ap.outerRadius };
}

/**
 * Dwell state machine for folder flyouts, shared by the overlay (wheel.js) and
 * the settings preview, so the demo matches the product exactly.
 *
 * The host calls feed(seg, onWheel) after every hover resolution — seg is the
 * hit segment (or null) and onWheel says whether the pointer is anywhere on
 * the wheel (hub and dead-zone between parent and fan count as on-wheel, so
 * a crossing gap never collapses the family instantly). toggle(seg) handles
 * click/Enter on a folder plate; back() peels the deepest level (hub click).
 * Geometry lives entirely in buildWheel's flyout API — this is timing only.
 *
 * opts: { dwellMs (0 = instant), graceMs, onGrow(reachPx) called after any
 *         expansion whose fan reaches reach (the host decides whether that
 *         needs more window) }
 */
export function createFlyoutNavigator(built, opts = {}) {
  const dwellMs = Math.max(0, opts.dwellMs == null ? 180 : opts.dwellMs);
  const graceMs = Math.max(0, opts.graceMs == null ? FLY_CLOSE_GRACE : opts.graceMs);
  const onGrow = typeof opts.onGrow === 'function' ? opts.onGrow : null;
  const fl = built.flyout;

  let openT = null, closeT = null, lastKey = '';
  const latched = new Set();   // folders the user collapsed — stay shut until the pointer leaves the wheel

  const clearTimers = () => {
    if (openT) { clearTimeout(openT); openT = null; }
    if (closeT) { clearTimeout(closeT); closeT = null; }
  };
  const doOpen = (seg) => {
    clearTimers();
    if (fl.open(seg) && onGrow) onGrow(fl.reach());
  };
  const startClose = (alsoUnlatch) => {
    if (openT) { clearTimeout(openT); openT = null; }
    if (closeT) clearTimeout(closeT);
    closeT = setTimeout(() => {
      closeT = null;
      fl.closeAll();
      if (alsoUnlatch) latched.clear();
    }, graceMs);
  };

  function feed(seg, onWheel) {
    const key = seg ? 's' + segKey(seg) : (onWheel ? 'w' : 'o');
    if (key === lastKey) return;
    lastKey = key;
    if (seg && fl.inOpenFamily(seg)) {
      // pointer inside the open family — hold everything steady
      clearTimers();
      return;
    }
    if (seg && fl.isFolder(seg) && !fl.isOpen(seg) && !latched.has(seg)) {
      // hovering a (fresh) folder: dwell-open it; any unrelated open family
      // closes after the grace, so sweeping folders reads as one sweep
      if (openT) clearTimeout(openT);
      openT = setTimeout(() => doOpen(seg), dwellMs);
      if (fl.levels()) startClose();
      return;
    }
    clearTimers();
    if (fl.levels()) startClose(!onWheel);
    else if (!onWheel) latched.clear();   // fully off the wheel: folders may auto-open again
  }
  function segKey(seg) {
    if (!seg) return '';
    const i = built.segments.indexOf(seg);
    return i >= 0 ? 'i' + i : 'p' + ((seg.item && seg.item.id) || '');
  }

  /* Click / Enter on a folder plate: open now, or collapse (with latch) if
     this one is already open. */
  function toggle(seg) {
    if (!seg || !fl.isFolder(seg)) return false;
    clearTimers();
    const d = fl.depthOf(seg);
    if (d >= 0) {
      fl.closeLevel(d);
      latched.add(seg);
    } else {
      latched.delete(seg);
      doOpen(seg);
    }
    return true;
  }

  /* Hub click / Backspace: peel the deepest open level. True = consumed. */
  function back() {
    if (!fl.levels()) return false;
    clearTimers();
    fl.closeLevel(fl.levels() - 1);
    return true;
  }

  function reset() {
    clearTimers();
    fl.closeAll();
    latched.clear();
    lastKey = '';
  }

  return { feed, toggle, back, reset };
}