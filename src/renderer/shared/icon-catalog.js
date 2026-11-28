/* Curated Segoe Fluent / MDL2 glyph catalog for the icon picker.
   Glyphs render exactly as shown in the picker (WYSIWYG), names are hints.
   Every code/name pair is shape-checked against the installed fonts (docs
   cmap names + a rendered contact sheet) — e.g. the Refresh button's glyph
   is E72C, Trash is E74D (E75D is a literal underscore), Mute is E74F
   (E74E is the Save floppy), Play is E768 (E9A1 is TapAndSend). */
export const ICON_CATALOG = [
  { code: '\uE700', name: 'Menu' }, { code: '\uE701', name: 'Wi-Fi' }, { code: '\uE702', name: 'Bluetooth' },
  { code: '\uE8EC', name: 'Tag' }, { code: '\uE706', name: 'Brightness' }, { code: '\uE708', name: 'Quiet hours' },
  { code: '\uE709', name: 'Airplane' }, { code: '\uE70B', name: 'Quick note' }, { code: '\uE70F', name: 'Edit' },
  { code: '\uE711', name: 'Close' }, { code: '\uE713', name: 'Settings' }, { code: '\uE715', name: 'Mail' },
  { code: '\uE716', name: 'People' }, { code: '\uE718', name: 'Pin' }, { code: '\uE719', name: 'Store' },
  { code: '\uE71B', name: 'Link' }, { code: '\uE71D', name: 'All apps' }, { code: '\uE720', name: 'Mic' },
  { code: '\uE721', name: 'Search' }, { code: '\uE722', name: 'Camera' }, { code: '\uE72C', name: 'Refresh' },
  { code: '\uE72D', name: 'Share' }, { code: '\uE72E', name: 'Lock' }, { code: '\uE734', name: 'Star' },
  { code: '\uE738', name: 'Remove' }, { code: '\uE73E', name: 'Check' }, { code: '\uE73F', name: 'Back to window' },
  { code: '\uE740', name: 'Full screen' }, { code: '\uE74D', name: 'Trash' }, { code: '\uE74E', name: 'Save' },
  { code: '\uE74F', name: 'Mute' }, { code: '\uE754', name: 'Flashlight' }, { code: '\uE756', name: 'Terminal' },
  { code: '\uE765', name: 'Keyboard' }, { code: '\uE767', name: 'Speaker' }, { code: '\uE768', name: 'Play' },
  { code: '\uE769', name: 'Pause' }, { code: '\uE774', name: 'Globe' }, { code: '\uE77F', name: 'Paste' },
  { code: '\uE790', name: 'Color' }, { code: '\uE793', name: 'Light' }, { code: '\uE7BA', name: 'Warning' },
  { code: '\uE7C3', name: 'Page' }, { code: '\uE7E8', name: 'Power' }, { code: '\uE7EE', name: 'Profile' },
  { code: '\uE7F4', name: 'Monitor' }, { code: '\uE80F', name: 'Home' }, { code: '\uE823', name: 'Recent' },
  { code: '\uE838', name: 'Open folder' }, { code: '\uE895', name: 'Sync' }, { code: '\uE896', name: 'Download' },
  { code: '\uE899', name: 'Emoji' }, { code: '\uE8A5', name: 'Document' }, { code: '\uE8B0', name: 'Click' },
  { code: '\uE8B7', name: 'Folder' }, { code: '\uE8BD', name: 'Chat' }, { code: '\uE8C8', name: 'Copy' },
  { code: '\uE8EF', name: 'Calculator' }, { code: '\uE8FC', name: 'Start flag' }, { code: '\uE8F4', name: 'New folder' },
  { code: '\uE91B', name: 'Photo' }, { code: '\uE932', name: 'Label' }, { code: '\uE943', name: 'Code' },
  { code: '\uE962', name: 'Mouse' }, { code: '\uE995', name: 'Volume' }, { code: '\uE9D5', name: 'Checklist' },
  { code: '\uE7FC', name: 'Gamepad' }, { code: '\uEA37', name: 'List' }, { code: '\uEA3A', name: 'Ring' },
  { code: '\uEB51', name: 'Heart' }, { code: '\uECA5', name: 'Tiles' }, { code: '\uEDA2', name: 'Storage' },
  { code: '\uE8D6', name: 'Music' }, { code: '\uF0E2', name: 'Grid' }, { code: '\uF7ED', name: 'Screenshot' }
];

/* One unique default mark per segment type — the answer to "what is this
   plate?" when the user hasn't chosen art. Every codepoint is in the catalog
   above (shape-checked), and each glyph mirrors the type chip's word so the
   picture and the label agree at a glance: program → the All-apps grid,
   website → Globe, file → Document, Windows → the Start flag, mixer →
   Speaker, app toggle → Settings gear, folder → Open folder, recents → the
   history clock, command → Terminal, keystrokes → Keyboard. Setting segments
   normally wear the app's own image (iconImage); the gear is what shows
   before that resolves. The wheel, the segment rows and the icon picker all
   read this map — never restack a private ternary chain. */
export const TYPE_ICON = {
  app: '\uE71D',       // All apps
  url: '\uE774',       // Globe
  file: '\uE8A5',      // Document
  sys: '\uE8FC',       // Start flag
  mixer: '\uE767',     // Speaker
  setting: '\uE713',   // Settings
  folder: '\uE838',    // Open folder
  recent: '\uE823',    // Recent
  command: '\uE756',   // Terminal
  macro: '\uE765'      // Keyboard
};
/* ChevronRight — the neutral mark for types the map doesn't know (legacy or
   hand-edited configs). Same glyph the folder plates' sub-menu chevron uses. */
export const TYPE_ICON_FALLBACK = '\uE76C';

/* The glyph a segment shows: its chosen icon if it has one, else its type's
   default. Callers that also resolve iconImage (the wheel, the row spans)
   layer the image precedence themselves. */
export function typeIconFor(item) {
  if (item && item.icon) return item.icon;
  return (item && TYPE_ICON[item.type]) || TYPE_ICON_FALLBACK;
}
