'use strict';
/* Program icon — "a segment that points at a program wears that program's own
   icon". Companion to the dashboard logo (item.iconImage slug) and the picked
   custom artwork (custom:<hash>.<kind>): the bytes land in the SAME
   content-addressed custom-icon store through customIcons.install(), so the
   wheel rows, the live preview, the LRU cap and the export packages all
   already know how to carry them. This module only produces PNG bytes from a
   program file and hands them over.

    The extraction is Win32's icon-resource reader — PrivateExtractIconsW,
    which reads the icon group OUT OF THE FILE YOU NAME, then DrawIconEx into a
    32bpp DIB section to get pixels at the size we want (the project's koffi
    rules keep every declaration behind macro.ffi; see src/main/macro.js). It
    deliberately does NOT go through the shell's icon RESOLUTION the way
    app.getFileIcon does: that route answers "success" together with a generic
    glyph whenever resolution fails — measured on win32 with Electron 44, a
    plain Electron app's .exe came back as the generic program icon inside the
    packaged main process while the very same file yielded its real art from
    every other process on the machine — so a shell hiccup became *artwork*.
    An icon resource is not a resolution: the file either holds the icon or
    PrivateExtractIconsW answers 0, and 0 is reported as a clean {ok:false,
    error}. Consequences worth knowing:
      - a .lnk carries no resources of its own (measured: 0 icons), so
        shortcuts are unpacked first and the link's OWN icon position is
        honoured — %windir%\system32\Mycomput.dll,2 is Computer Management and
        index 0 of that DLL is something else entirely;
      - an .ico is read through the same call (it is a resource container too),
        so one path covers every accepted extension;
      - an .msi usually holds no icon at all and now says so instead of
        wearing the Windows Installer package glyph.
    Being Win32 calls these only exist on win32, and every other answer is a
    clean {ok:false, error}: the segment keeps its glyph, never a blank plate.

    The path arrives FROM THE RENDERER (the program the user just picked), so
    it is allow-listed here before anything touches the disk or the shell —
    absolute path, program-ish extension, no wildcard/path-expression
    characters. What a successful call gives a caller is that file's public
    icon and nothing else; a failed call reveals only that a name did not
    resolve. Same spirit as icons:pick-image, where main does the reading. */
const fs = require('fs');
const customIcons = require('./custom-icons');
const macro = require('./macro');

const PROGRAM_EXT = /\.(exe|lnk|dll|msi|ico)$/i;
const PATH_MAX = 4096;
/* Wildcards and stray quotes are path-expression syntax to the shell, and
   control characters are illegal in Windows path names outright — refused so
   one string can never name more (or less) than exactly one file
   (drive-letter colons are allowed; the extension test + stat bound what
   remains). */
const JUNK_RE = /[\0-\x1f<>|?*"]/;
/* The wheel draws a segment icon at ~26 px, so 64 covers a 2× display with
   room to spare and still lands as a few kilobytes — nowhere near the 2 MB the
   store caps one image at. PrivateExtractIconsW renders the file's group at
   exactly this size, so a program that ships only a 48 px group still gives a
   crisp 64 instead of the shell's 32. */
const ICON_SIZE = 64;
/* Windows keeps the icon position inside a shortcut as a signed int and the
   .lnk's contents are user-writable, so the index gets an explicit ceiling. */
const ICON_INDEX_MAX = 0xffff;
const DI_NORMAL = 0x3;

/** Expand `%NAME%` placeholders the way a .lnk stores them (and the way one
 *  typed into Settings reads). Windows names are case-insensitive, which
 *  Node's environment proxy already handles. A name that is not in the
 *  environment refuses the whole candidate rather than guessing at a path —
 *  `%NOPE%\app.exe` must never quietly become a relative path.
 *  Pure apart from the environment (unit-testable). */
function expandEnv(raw) {
  if (typeof raw !== 'string' || raw.indexOf('%') < 0) return raw;
  let unresolved = false;
  const out = raw.replace(/%([^%]+)%/g, (whole, name) => {
    const v = process.env[name];
    if (typeof v !== 'string' || !v) { unresolved = true; return whole; }
    return v;
  });
  return unresolved ? null : out;
}

/** Shape-only check — no disk, no shell, no Electron (unit-testable).
 *  Returns the cleaned (and environment-expanded) path, or null when the
 *  candidate can never name a program file. */
function programIconPath(raw) {
  if (typeof raw !== 'string') return null;
  const p = expandEnv(raw.trim().replace(/^"([^"]+)"$/, '$1').trim());
  if (!p || p.length > PATH_MAX || JUNK_RE.test(p)) return null;
  // Absolute only: a relative path would resolve against main's working
  // directory, so the same string could mean a different file every launch.
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\\\\[^\\]/.test(p)) return null;
  if (!PROGRAM_EXT.test(p)) return null;
  return p;
}

/** One icon POSITION inside a file. A junk or out-of-range index reads as 0 —
 *  the first icon, which is what a link with no position at all means.
 *  Pure: no FFI, no disk (unit-testable). */
function iconIndex(raw) {
  const n = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (!Number.isInteger(n) || n < 0 || n > ICON_INDEX_MAX) return 0;
  return n > 0 ? n : 0;                                     // -0 reads as 0, not as a distinct value
}

/** Where a shortcut wants to be extracted from: {path, index} — its own icon
 *  location (and the position recorded with it: a PWA's .ico, an installer's
 *  second icon) first, else the target's first icon. Shape-only + the same path
 *  discipline as programIconPath — the link file's contents are user-writable,
 *  so an unvalidated string from it gets the same refuse rules as one from the
 *  renderer. Empty/garbage in both slots yields null: unlike the shell route
 *  this one has no generic answer to fall back to, so the caller reports the
 *  miss instead of installing a placeholder. */
function linkIconSource(info) {
  if (!info || typeof info !== 'object') return null;
  for (const [cand, rawIndex] of [[info.icon, info.iconIndex], [info.target, 0]]) {
    const p = programIconPath(cand || '');
    if (!p) continue;
    try { if (fs.statSync(p).isFile()) return { path: p, index: iconIndex(rawIndex) }; } catch { /* gone */ }
  }
  return null;
}

/* The Win32 icon surface, declared once on first use (lazy so unit tests that
   only poke the pure shapes never touch koffi). Declaring through macro.ffi
   keeps macro.js the single koffi site; each block there is guarded, so the
   only ways in here fail are "no koffi" and "no gdi32" — both become a human
   error line, never a crash. */
let api = null;
function needApi() {
  if (api) return api;
  const ffi = macro.ffi;
  if (!ffi.available) throw new Error(ffi.loadError || 'the Win32 bindings are unavailable');
  if (!ffi.gdiAvailable) throw new Error(ffi.gdiLoadError || 'gdi32.dll is unavailable');
  const u = (spec) => ffi.declareUser32(spec);
  const g = (spec) => ffi.declareGdi32(spec);
  api = {
    extract: u('int32 __stdcall PrivateExtractIconsW(str16 path, int32 index, int32 cx, int32 cy, void** phIcon, uint32* pResId, int32 nIcons, uint32 flags)'),
    iconInfo: u('int32 __stdcall GetIconInfo(uint64 hIcon, void* pIconInfo)'),
    destroyIcon: u('int32 __stdcall DestroyIcon(uint64 hIcon)'),
    drawIcon: u('int32 __stdcall DrawIconEx(uint64 hdc, int32 x, int32 y, uint64 hIcon, int32 cx, int32 cy, uint32 step, void* brush, uint32 flags)'),
    getDC: u('uint64 __stdcall GetDC(uint64 hWnd)'),
    releaseDC: u('int32 __stdcall ReleaseDC(uint64 hWnd, uint64 hdc)'),
    memDC: g('uint64 __stdcall CreateCompatibleDC(uint64 hdc)'),
    deleteDC: g('int32 __stdcall DeleteDC(uint64 hdc)'),
    dibSection: g('uint64 __stdcall CreateDIBSection(uint64 hdc, void* pBi, uint32 usage, void** ppvBits, uint64 hSection, uint32 offset)'),
    select: g('uint64 __stdcall SelectObject(uint64 hdc, uint64 obj)'),
    deleteObj: g('int32 __stdcall DeleteObject(uint64 obj)'),
    copy: ffi.declareMsvcrt('void memcpy(void* dst, uint64 src, size_t n)')
  };
  return api;
}

/* Skia's 32-bit bitmap format is PREMULTIPLIED BGRA, and DrawIconEx returns
   whichever form the icon's source carried. If any colour channel ever exceeds
   its own alpha the buffer is straight alpha, so scale it; otherwise it is
   already premultiplied and passing it through untouched is exact. */
function toPremultiplied(bgra) {
  let straight = false;
  for (let i = 0; i + 3 < bgra.length; i += 4) {
    if (bgra[i] > bgra[i + 3] || bgra[i + 1] > bgra[i + 3] || bgra[i + 2] > bgra[i + 3]) { straight = true; break; }
  }
  if (!straight) return bgra;
  const out = Buffer.from(bgra);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = out[i + 3];
    if (a === 255) continue;
    out[i] = Math.round(out[i] * a / 255);
    out[i + 1] = Math.round(out[i + 1] * a / 255);
    out[i + 2] = Math.round(out[i + 2] * a / 255);
  }
  return out;
}

/** PNG bytes for one icon inside one real file, or null when the file holds no
 *  icon at that position. Throws only when Win32 itself is unusable.
 *
 *  The icon's own colour bitmap is NOT read: it is a 32bpp DDB that GetDIBits
 *  refuses to convert, so the pixels come from drawing the icon into a DIB
 *  section we own — which is also what renders the file's group at ICON_SIZE
 *  instead of whatever size the shell happened to cache. GetIconInfo is called
 *  only for the two HBITMAPs it hands out, which this call must free. */
function extractIcon(filePath, index) {
  const a = needApi();
  const hOut = Buffer.alloc(8), idOut = Buffer.alloc(4);
  if (a.extract(filePath, index, ICON_SIZE, ICON_SIZE, hOut, idOut, 1, 0) !== 1) return null;
  const hIcon = hOut.readBigUInt64LE(0);
  if (!hIcon) return null;
  try {
    const ii = Buffer.alloc(40);
    a.iconInfo(hIcon, ii);                                  // best-effort: the bitmaps are all we want
    const hbmColor = ii.readBigUInt64LE(8), hbmMask = ii.readBigUInt64LE(16);
    const screen = a.getDC(0n);
    const mdc = screen ? a.memDC(screen) : 0n;
    try {
      if (!mdc) return null;
      const bi = Buffer.alloc(44);                          // BITMAPINFOHEADER + one unused RGBQUAD
      bi.writeUInt32LE(40, 0);
      bi.writeInt32LE(ICON_SIZE, 4);
      bi.writeInt32LE(-ICON_SIZE, 8);                        // negative height = top-down rows
      bi.writeUInt16LE(1, 12);
      bi.writeUInt16LE(32, 14);                              // BI_RGB 32bpp → BGRA in memory
      const ppv = Buffer.alloc(8);
      const hbm = a.dibSection(screen, bi, 0, ppv, 0n, 0);
      const bitsAddr = ppv.readBigUInt64LE(0);
      if (!hbm || !bitsAddr) return null;
      try {
        const old = a.select(mdc, hbm);
        try {
          if (!a.drawIcon(mdc, 0, 0, hIcon, ICON_SIZE, ICON_SIZE, 0, null, DI_NORMAL)) return null;
          const raw = Buffer.alloc(ICON_SIZE * ICON_SIZE * 4);
          a.copy(raw, bitsAddr, raw.length);
          // Lazy require: unit tests load this module under plain node, where
          // "electron" resolves to a path string, not an API object.
          const { nativeImage } = require('electron');
          const img = nativeImage.createFromBitmap(toPremultiplied(raw), { width: ICON_SIZE, height: ICON_SIZE });
          if (!img || img.isEmpty()) return null;
          return img.toPNG();
        } finally { if (old) a.select(mdc, old); }
      } finally { a.deleteObj(hbm); }
    } finally {
      if (mdc) a.deleteDC(mdc);
      if (screen) a.releaseDC(0n, screen);
      if (hbmColor) a.deleteObj(hbmColor);
      if (hbmMask) a.deleteObj(hbmMask);
    }
  } finally {
    a.destroyIcon(hIcon);
  }
}

/** Extract the program's own icon into the custom-icon store.
 *  Resolves {ok:true, key, kind, dataUrl} — the same shape as a picked or
 *  URL-installed custom image — or {ok:false, error} for the caller's hint
 *  line / silent glyph fallback. Never throws. */
async function fromPath(raw) {
  const p = programIconPath(raw);
  if (!p) return { ok: false, error: 'Icons can only come from .exe, .lnk, .dll, .msi or .ico files' };
  if (process.platform !== 'win32') return { ok: false, error: 'Program icons are a Windows feature' };
  try {
    if (!fs.statSync(p).isFile()) return { ok: false, error: 'That path is not a file' };
  } catch { return { ok: false, error: 'No file exists at that path' }; }
  let target = { path: p, index: 0 };
  if (/\.lnk$/i.test(p)) {
    try {
      const { shell } = require('electron');
      const src = linkIconSource(shell.readShortcutLink(p));
      if (!src) return { ok: false, error: 'That shortcut does not point at a file with an icon' };
      target = src;
    } catch (err) {
      return { ok: false, error: 'Could not read that shortcut — ' + String((err && err.message) || err) };
    }
  }
  let png;
  try {
    png = extractIcon(target.path, target.index);
  } catch (err) {
    return { ok: false, error: 'Could not read the program icon — ' + String((err && err.message) || err) };
  }
  if (!png) {
    return { ok: false, error: target.index
      ? `That file has no icon at position ${target.index} — pick an image instead`
      : 'Windows has no icon inside that file — pick an image instead' };
  }
  return customIcons.install(Buffer.from(png));
}

module.exports = { fromPath, programIconPath, linkIconSource, iconIndex };
