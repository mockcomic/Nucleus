/* Shared radial wheel renderer — used by both the live overlay and the settings preview,
   so what you edit is literally what you get. */

export const PAD = 26;
export const ICON_FONT = "'Segoe Fluent Icons','Segoe MDL2 Assets',system-ui";
export const UI_FONT = "'Segoe UI',system-ui,sans-serif";

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

/**
 * Build the wheel into `container`. Returns { cfg, segments, setHover, size }.
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
      const path = svgEl('path', {
        d: sectorPath(cx, cy, rg.r0, rg.r1, a0, a1),
        /* Plates alternate outward: odd rings the ring1 tint, even rings ring2. */
        fill: item.color || ap.colors[rg.ring % 2 === 1 ? 'ring1' : 'ring2'],
        stroke: persona.edge, 'stroke-width': 1,
        'fill-rule': 'evenodd'
      });
      g.appendChild(path);

      const midRad = (center - 90) * Math.PI / 180;
      const tx = (Math.cos(midRad) * 3).toFixed(2), ty = (Math.sin(midRad) * 3).toFixed(2);
      g.style.setProperty('--tx', tx + 'px');
      g.style.setProperty('--ty', ty + 'px');

      const band = rg.r1 - rg.r0;
      const rm = (rg.r0 + rg.r1) / 2;
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
      gRing.appendChild(g);
      segments.push({ el: g, path, item, imgHref, ring: rg.ring, r0: rg.r0, r1: rg.r1, center, halfSpan, baseFill: path.getAttribute('fill') });
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
  root.appendChild(hubIcon); root.appendChild(hubImg); root.appendChild(hubLabel); root.appendChild(centerLabel);

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

  function hitTest(px, py) {
    const dx = px - cx, dy = py - cy;
    const dist = Math.hypot(dx, dy);
    if (dist < ap.innerRadius) return { hub: true, dist };
    let deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    for (const seg of segments) {
      if (dist < seg.r0 - 1 || dist > seg.r1 + 1) continue;
      let d = Math.abs(deg - ((seg.center % 360) + 360) % 360);
      d = Math.min(d, 360 - d);
      if (d <= seg.halfSpan) return { seg, dist };
    }
    return null;
  }

  // Force the "nothing hovered" hub reset once at build time — the
  // hovered===seg guard would otherwise skip it (hovered already starts as
  // null, so a plain setHover(null) was a dead no-op; harmless only while the
  // build-time defaults below coincided with this reset).
  hovered = undefined;
  setHover(null);
  return { cfg: s, size, segments, setHover, hitTest };
}
