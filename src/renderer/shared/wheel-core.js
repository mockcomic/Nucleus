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

export function ringSpans(cfg) {
  const ap = cfg.appearance;
  const has2 = (cfg.rings[2] || []).length > 0;
  const mid = has2 ? ap.innerRadius + (ap.outerRadius - ap.innerRadius) * ap.ringSplit : ap.outerRadius;
  const out = [{ ring: 1, r0: ap.innerRadius, r1: mid, items: cfg.rings[1] || [] }];
  if (has2) out.push({ ring: 2, r0: mid, r1: ap.outerRadius, items: cfg.rings[2] || [] });
  return out;
}

function svgEl(tag, attrs = {}) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
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
 * opts: { preview?:bool, scale?:number }
 */
export function buildWheel(container, cfg, opts = {}) {
  const scale = opts.scale == null ? 1 : opts.scale;
  const s = { ...cfg, appearance: { ...cfg.appearance } };
  s.appearance.innerRadius = cfg.appearance.innerRadius * scale;
  s.appearance.outerRadius = cfg.appearance.outerRadius * scale;
  const size = s.appearance.outerRadius * 2 + PAD * 2;
  const cx = size / 2, cy = size / 2;
  const ap = s.appearance;

  container.innerHTML = '';
  const svg = svgEl('svg', {
    width: size, height: size, viewBox: `0 0 ${size} ${size}`, class: 'wheel-svg'
  });
  const root = svgEl('g', { class: 'wheel-root' });
  svg.appendChild(root);

  const shadow = svgEl('g', { class: 'shadow-layer', filter: 'url(#rwdrop)' });
  const defs = svgEl('defs');
  const filt = svgEl('filter', { id: 'rwdrop', x: '-40%', y: '-40%', width: '180%', height: '180%' });
  const feDrop = svgEl('feDropShadow', { dx: '0', dy: '6', stdDeviation: '14', 'flood-color': 'rgba(0,0,0,0.55)' });
  filt.appendChild(feDrop); defs.appendChild(filt); svg.insertBefore(defs, root);

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
        fill: item.color || (rg.ring === 1 ? ap.colors.ring1 : ap.colors.ring2),
        stroke: 'rgba(255,255,255,0.06)', 'stroke-width': 1,
        'fill-rule': 'evenodd'
      });
      g.appendChild(path);

      const midRad = (center - 90) * Math.PI / 180;
      const tx = (Math.cos(midRad) * 3).toFixed(2), ty = (Math.sin(midRad) * 3).toFixed(2);
      g.style.setProperty('--tx', tx + 'px');
      g.style.setProperty('--ty', ty + 'px');

      const band = rg.r1 - rg.r0;
      const rm = (rg.r0 + rg.r1) / 2;
      const showIcon = !!item.icon;
      const showLabel = ap.showLabels && !!item.label;
      const iconSize = Math.max(13, Math.min(26, band * 0.30));

      if (showIcon) {
        const ir = showLabel ? rm - band * 0.10 : rm;
        const [ix, iy] = degToXY(cx, cy, ir, center);
        const t = svgEl('text', {
          x: ix, y: iy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
          'font-family': ICON_FONT, 'font-size': iconSize, fill: ap.colors.text, class: 'seg-icon'
        });
        t.textContent = item.icon;
        g.appendChild(t);
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
      segments.push({ el: g, path, item, ring: rg.ring, r0: rg.r0, r1: rg.r1, center, halfSpan, baseFill: path.getAttribute('fill') });
    });
    shadow.appendChild(gRing);
  }
  root.appendChild(shadow);

  /* hub */
  const hub = svgEl('circle', {
    cx, cy, r: ap.innerRadius, fill: ap.colors.center,
    stroke: ap.colors.accent, 'stroke-opacity': 0.22, 'stroke-width': 1.5, class: 'hub'
  });
  root.appendChild(hub);
  const hubIcon = svgEl('text', {
    x: cx, y: cy - 12, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': ICON_FONT, 'font-size': Math.min(34, ap.innerRadius * 0.42), fill: ap.colors.text, class: 'hub-icon'
  });
  const hubLabel = svgEl('text', {
    x: cx, y: cy + Math.min(30, ap.innerRadius * 0.40), 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': UI_FONT, 'font-size': Math.max(11, ap.fontSize), 'font-weight': 600,
    fill: ap.colors.text, class: 'hub-label'
  });
  const centerLabel = svgEl('text', {
    x: cx, y: cy, 'text-anchor': 'middle', 'dominant-baseline': 'central',
    'font-family': UI_FONT, 'font-size': Math.max(12, ap.fontSize), 'font-weight': 600,
    fill: ap.colors.text, 'fill-opacity': 0.85, class: 'center-label'
  });
  centerLabel.textContent = ap.centerLabel || '';
  root.appendChild(hubIcon); root.appendChild(hubLabel); root.appendChild(centerLabel);

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
      hubIcon.textContent = hovered.item.icon || '';
      hubLabel.textContent = hovered.item.label || '';
      centerLabel.setAttribute('fill-opacity', hovered.item.label || hovered.item.icon ? 0 : 0.85);
    } else {
      hubIcon.textContent = '';
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

  setHover(null);
  return { cfg: s, size, segments, setHover, hitTest };
}
