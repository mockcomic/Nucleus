/* Disclosure keys for the Settings → Segments list (src/renderer/settings/settings.js).

   A key addresses one row across the whole tree. Keys are built from ITEM IDS
   (stable across reorder/fold/ring-move): a ring-level row's key is its id, a
   folder child's is "<parent key>/<child id>", and so on. Exactly ONE key is
   open at a time, and a folder row keeps its FULL editor — fields and sub-menu
   manager — on screen while a DESCENDANT is open — so collapsing a nested row
   must hand the panel back
   to the row that contains it, not to nothing (nulling the key hides the
   folder manager the child row was clicked through). Legacy note: keys used to
   be positional ("1-3", "1-3/0") and were retargeted by every reorder. */

/* The key to open after collapsing `key`: its containing folder row, or null
   for a ring-level row (nothing above it to fall back to). */
export function collapseEditorKey(key) {
  const k = typeof key === 'string' ? key : '';
  const up = k.lastIndexOf('/');
  return up < 0 ? null : k.slice(0, up);
}
