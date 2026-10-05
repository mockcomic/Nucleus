'use strict';
/* Pure-JS PNG + ICO generation (no native deps). The icon is a miniature of the
   radial wheel itself: 6 segments around a hub, top segment lit like hover,
   accent ring + center dot — Midnight theme palette. Runtime tray icons are
   written to userData/icons; scripts/make-icons.mjs writes assets/tray.ico
   for packaging. */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- PNG encoder (8-bit RGBA, no interlace) ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(w, h, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // bit depth, color type RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) {
    raw[y * (1 + w * 4)] = 0; // filter none
    rgba.copy(raw, y * (1 + w * 4) + 1, y * w * 4, (y + 1) * w * 4);
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- ICO container (PNG-encoded entries) ---------------- */
function buildIco(entries) { // entries: [{size, png}]
  const count = entries.length;
  const header = Buffer.alloc(6 + count * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(count, 4);
  let off = 6 + count * 16;
  entries.forEach((e, i) => {
    const p = 6 + i * 16;
    header[p] = e.size >= 256 ? 0 : e.size;
    header[p + 1] = e.size >= 256 ? 0 : e.size;
    header[p + 2] = 0; header[p + 3] = 0;
    header.writeUInt16LE(1, p + 4); header.writeUInt16LE(32, p + 6);
    header.writeUInt32LE(e.png.length, p + 8);
    header.writeUInt32LE(off, p + 12);
    off += e.png.length;
  });
  return Buffer.concat([header, ...entries.map(e => e.png)]);
}

/* ------------------------- the wheel artwork ------------------------------ */
const C = {
  bg: [0x10, 0x14, 0x18],       // plate under the wheel
  ring: [0x1b, 0x27, 0x33],     // normal segments   (ring1)
  hover: [0x2e, 0x7d, 0xd1],    // lit segment       (hover)
  accent: [0x4c, 0x9f, 0xf0],   // hub ring          (accent)
  center: [0x0a, 0x0e, 0x12],   // hub disc          (center)
  text: [0xe8, 0xee, 0xf4]      // hub dot           (text)
};

const SEGMENTS = 6;
const STEP = 360 / SEGMENTS;
const GAP_HALF = 4;        // degrees cut from each segment edge
const R_DISC = 0.470;      // plate radius
const R_BAND_O = 0.452;    // segment band outer / inner
const R_BAND_I = 0.190;
const R_HUB_O = 0.158;     // accent ring outer / inner
const R_HUB_I = 0.118;
const R_DOT = 0.052;
const AA = 0.014;          // radial antialiasing width (normalized units)

const smooth = (v, R) => Math.min(1, Math.max(0, (R + AA - v) / (2 * AA)));

function drawTray(size) {
  const SS = 4; // supersample — angular edges get real antialiasing
  const rgba = Buffer.alloc(size * size * 4);
  const half = size / 2;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let aR = 0, aG = 0, aB = 0, aA = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px + (sx + 0.5) / SS - half) / size;
          const y = (py + (sy + 0.5) / SS - half) / size;
          const d = Math.hypot(x, y);
          let r = 0, g = 0, b = 0, a = 0;
          const layer = (col, t) => {
            if (t <= 0) return;
            const over = t * (1 - a);
            r += col[0] * over; g += col[1] * over; b += col[2] * over; a += over;
          };

          // layers are composited front-first (the 'over' weight is (1-a)):
          if (d < R_DOT + AA) layer(C.text, smooth(d, R_DOT));       // center dot
          if (d < R_HUB_I + AA) layer(C.center, smooth(d, R_HUB_I)); // hub disc
          if (d > R_HUB_I - AA && d < R_HUB_O + AA) {           // accent hub ring
            layer(C.accent, smooth(d, R_HUB_O) * smooth(-d, -R_HUB_I));
          }

          if (d > R_BAND_I - AA && d < R_BAND_O + AA) {         // the ring of segments
            const inBand = smooth(d, R_BAND_O) * smooth(-d, -R_BAND_I);
            if (inBand > 0) {
              const deg = (Math.atan2(x, -y) * 180 / Math.PI + 360) % 360; // 0 = top, clockwise
              const cdeg = ((Math.round(deg / STEP) * STEP) % 360 + 360) % 360;
              let off = deg - cdeg; if (off > 180) off -= 360; if (off < -180) off += 360;
              const inside = Math.abs(off) <= STEP / 2 - GAP_HALF ? 1 : 0;
              if (inside) layer(cdeg === 0 ? C.hover : C.ring, inBand);
            }
          }

          layer(C.bg, smooth(d, R_DISC));                       // dark plate keeps it legible on any taskbar

          aR += r; aG += g; aB += b; aA += a;
        }
      }
      const n = SS * SS;
      const A = aA / n;
      const o = (py * size + px) * 4;
      if (A > 0.004) {
        // unpremultiply the coverage-weighted color:
        rgba[o] = Math.min(255, Math.round(aR / n / A));
        rgba[o + 1] = Math.min(255, Math.round(aG / n / A));
        rgba[o + 2] = Math.min(255, Math.round(aB / n / A));
        rgba[o + 3] = Math.round(A * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

function ensureRuntimeIcons(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const p16 = path.join(dir, 'tray-16.png');
  const p32 = path.join(dir, 'tray-32.png');
  // existsSync alone never repairs the 0-byte leftovers of an interrupted
  // first run — a corrupt tray-32.png would mean a permanently blank tray.
  const usable = (p) => { try { return fs.existsSync(p) && fs.statSync(p).size > 0; } catch { return false; } };
  if (!usable(p32)) fs.writeFileSync(p32, drawTray(32));
  if (!usable(p16)) fs.writeFileSync(p16, drawTray(16));
  return { tray32: p32, tray16: p16 };
}

function ensureProjectIcons(assetsDir) {
  fs.mkdirSync(assetsDir, { recursive: true });
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const ico = buildIco(sizes.map(s => ({ size: s, png: drawTray(s) })));
  fs.writeFileSync(path.join(assetsDir, 'tray.ico'), ico);
  fs.writeFileSync(path.join(assetsDir, 'tray-32.png'), drawTray(32));
  return path.join(assetsDir, 'tray.ico');
}

/* ------------------------- the app's own icon as segment art ---------------
   `builtin:app` is a reserved iconImage key: the wheel art above, served as a
   data URL through the SAME icons:data-url lookup as dashboard/custom icons
   (ipc.js intercepts it before both families). The colon keeps it outside
   dashboard's SLUG_RE and custom's `custom:<hex>.<kind>` shape, so it can
   never be mistaken for — or prefetched as — a downloadable icon. */
const APP_ICON_KEY = 'builtin:app';
let _appIconCache = null;   // { dir, dataUrl } — one render per process

function appIconDataUrl(dir) {
  if (_appIconCache && _appIconCache.dir === dir) return _appIconCache.dataUrl;
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'app-icon-128.png');
  // Same repair discipline as ensureRuntimeIcons: a 0-byte leftover from an
  // interrupted first run must not mean a permanently blank segment.
  let usable = false;
  try { usable = fs.statSync(p).size > 0; } catch {}
  if (!usable) fs.writeFileSync(p, drawTray(128));
  const buf = fs.readFileSync(p);
  const dataUrl = 'data:image/png;base64,' + buf.toString('base64');
  _appIconCache = { dir, dataUrl };
  return dataUrl;
}

module.exports = { ensureRuntimeIcons, ensureProjectIcons, drawTray, encodePng, buildIco, APP_ICON_KEY, appIconDataUrl };
