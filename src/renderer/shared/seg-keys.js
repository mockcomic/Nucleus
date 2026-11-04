/* Disclosure keys for the Settings → Segments list (src/renderer/settings/settings.js).

   A key addresses one row across the whole tree: "1-3" is ring 1's fourth
   segment, "1-3/0" that folder's first child, "1-3/0/2" a sub-folder's child.
   Exactly ONE key is open at a time, and a folder row keeps its sub-menu
   manager on screen while a DESCENDANT is open — so collapsing a nested row
   must hand the panel back to the row that contains it, not to nothing
   (nulling the key hides the folder manager the child row was clicked through). */

/* The key to open after collapsing `key`: its containing folder row, or null
   for a ring-level row (nothing above it to fall back to). */
export function collapseEditorKey(key) {
  const k = typeof key === 'string' ? key : '';
  const up = k.lastIndexOf('/');
  return up < 0 ? null : k.slice(0, up);
}
