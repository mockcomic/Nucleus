'use strict';
/* Program icon — "a segment that points at a program wears that program's own
   icon". Companion to the dashboard logo (item.iconImage slug) and the picked
   custom artwork (custom:<hash>.<kind>): the bytes land in the SAME
   content-addressed custom-icon store through customIcons.install(), so the
   wheel rows, the live preview, the LRU cap and the export packages all
   already know how to carry them. This module only produces PNG bytes from a
   program file and hands them over.

   The extraction itself is the Windows shell — Electron's app.getFileIcon:
   it honours a shortcut's own icon location, the registry DisplayIcon, and
   embedded icon groups, at the largest size the file carries. Being a shell
   call it only exists on win32, and every other answer is a clean
   {ok:false, error}: the segment keeps its glyph, never a blank plate.

   The path arrives FROM THE RENDERER (the program the user just picked), so
   it is allow-listed here before anything touches the disk or the shell —
   absolute path, program-ish extension, no wildcard/path-expression
   characters. What a successful call gives a caller is that file's public
   icon and nothing else; a failed call reveals only that a name did not
   resolve. Same spirit as icons:pick-image, where main does the reading. */
const fs = require('fs');
const customIcons = require('./custom-icons');

const PROGRAM_EXT = /\.(exe|lnk|dll|msi|ico)$/i;
const PATH_MAX = 4096;
/* Wildcards and stray quotes are path-expression syntax to the shell, and
   control characters are illegal in Windows path names outright — refused so
   one string can never name more (or less) than exactly one file
   (drive-letter colons are allowed; the extension test + stat bound what
   remains). */
const JUNK_RE = /[\0-\x1f<>|?*"]/;

/** Shape-only check — no disk, no shell, no Electron (unit-testable).
 *  Returns the cleaned path, or null when the candidate can never name a
 *  program file. */
function programIconPath(raw) {
  if (typeof raw !== 'string') return null;
  const p = raw.trim().replace(/^"([^"]+)"$/, '$1').trim();
  if (!p || p.length > PATH_MAX || JUNK_RE.test(p)) return null;
  // Absolute only: a relative path would resolve against main's working
  // directory, so the same string could mean a different file every launch.
  if (!/^[A-Za-z]:[\\/]/.test(p) && !/^\\\\[^\\]/.test(p)) return null;
  if (!PROGRAM_EXT.test(p)) return null;
  return p;
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
  let png;
  try {
    // Lazy require: unit tests load this module under plain node, where
    // "electron" resolves to a path string, not an API object.
    const { app } = require('electron');
    const img = await app.getFileIcon(p, { size: 'larger' });
    if (!img || img.isEmpty()) return { ok: false, error: 'Windows has no icon for that file' };
    png = img.toPNG();
  } catch (err) {
    return { ok: false, error: 'Could not read the program icon — ' + String((err && err.message) || err) };
  }
  return customIcons.install(Buffer.from(png));
}

module.exports = { fromPath, programIconPath };
