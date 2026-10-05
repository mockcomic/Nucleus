'use strict';
/* App-setting actions (type: 'setting'). Each catalog entry is a toggle of one
   live boolean config flag — firing the segment flips it through the same
   store.set() pipeline the Settings window uses, so hotkey/game-mode/autostart
   side effects (handleConfigChanged) all fire exactly as if the user clicked
   the switch in Settings. The CATALOG drives the settings dropdown, IDS gates
   execution, and apply() is the only mutator.

   Deliberately NOT a CATALOG here: parameters whose change needs a value the
   item must carry (radii, fonts, counts). The combo in settings.js makes a
   future "cycle through N values" entry an additive change. */

/* Every entry names its config path so apply() reads/writes through one code
   path; `defaults` rebuilds a missing intermediate object (gameMode) the same
   shape validate() would have produced. */
const ENTRIES = [
  { id: 'toggle_wheel_sound', label: 'Wheel sounds', group: 'Wheel',
    icon: '\uE767', path: ['behavior', 'wheelSound'] },
  { id: 'toggle_labels', label: 'Segment labels', group: 'Wheel',
    icon: '\uE8C4', path: ['appearance', 'showLabels'] },
  { id: 'toggle_marking', label: 'Press-drag marking', group: 'Wheel',
    icon: '\uE73A', path: ['behavior', 'markingSelect'] },
  { id: 'toggle_type_filter', label: 'Type-to-filter', group: 'Wheel',
    icon: '\uE71C', path: ['behavior', 'typeToFilter'] },
  { id: 'toggle_retrigger', label: 'Re-trigger toggles', group: 'Wheel',
    icon: '\uE895', path: ['behavior', 'reTriggerToggles'] },
  { id: 'toggle_dismiss_escape', label: 'Dismiss with Esc', group: 'Dismissal',
    icon: '\uE711', path: ['behavior', 'dismissOnEscape'] },
  { id: 'toggle_dismiss_rightclick', label: 'Dismiss with right-click', group: 'Dismissal',
    icon: '\uE974', path: ['behavior', 'dismissOnRightClick'] },
  { id: 'toggle_click_through', label: 'Mouse click-through', group: 'Dismissal',
    icon: '\uE962', path: ['behavior', 'mouseClickThrough'] },
  { id: 'toggle_focus_existing', label: 'Focus running apps', group: 'App',
    icon: '\uE8B7', path: ['behavior', 'focusExistingApp'] },
  { id: 'toggle_profiles', label: 'App profiles', group: 'App',
    icon: '\uE7EE', path: ['behavior', 'profilesEnabled'] },
  { id: 'toggle_game_mode', label: 'Game mode', group: 'App',
    icon: '\uE7FC', path: ['behavior', 'gameMode', 'enabled'],
    parent: ['behavior'], fill: () => ({ enabled: false, apps: [] }) },
  { id: 'toggle_autostart', label: 'Start with Windows', group: 'App',
    icon: '\uE77B', path: ['behavior', 'autostart'] }
];

const CATALOG = ENTRIES.map((e) => ({ id: e.id, label: e.label, group: e.group, icon: e.icon }));
const IDS = new Set(ENTRIES.map((e) => e.id));
const BY_ID = new Map(ENTRIES.map((e) => [e.id, e]));

function isKnown(id) { return BY_ID.has(String(id || '')); }

/* Read/write helpers walking the entry's path. A missing/non-object hop reads
   undefined (toggle target then falls back to the validated defaults below);
   on write, a missing parent is rebuilt via entry.fill() — matching what
   validate() would produce, so the store stays canonical either way. */
function readAt(cfg, path) {
  let o = cfg;
  for (const k of path) {
    if (!o || typeof o !== 'object') return undefined;
    o = o[k];
  }
  return o;
}

function writeAt(cfg, entry, value) {
  const hops = entry.path.slice(0, -1);
  const leaf = entry.path[entry.path.length - 1];
  let o = cfg;
  for (const k of hops) {
    if (!o[k] || typeof o[k] !== 'object') o[k] = entry.fill ? entry.fill() : {};
    o = o[k];
  }
  o[leaf] = value;
}

/**
 * Flip one app setting through the live store. Throws a user-readable Error
 * (the wheel's failure balloon path) for an unknown or empty id — NOTHING
 * reaches the store unless the id is in the catalog, so a hand-edited config
 * can never steer an arbitrary config path from the wheel.
 * Returns the merged config store.set() produced.
 */
async function apply(id, store) {
  const key = String(id == null ? '' : id).trim();
  if (!key) throw new Error('no setting configured');
  const entry = BY_ID.get(key);
  if (!entry) throw new Error(`unknown setting '${id}'`);
  if (!store || typeof store.get !== 'function' || typeof store.set !== 'function') {
    throw new Error('app settings are unavailable here');
  }
  const cfg = JSON.parse(JSON.stringify(store.get() || {}));
  const cur = readAt(cfg, entry.path);
  // Toggle discipline: anything that is not exactly true flips ON; junk/absent
  // (which validate() would never leave) reads false, mirroring the store's
  // opt-in flags' fail-closed defaults.
  writeAt(cfg, entry, cur !== true);
  return store.set(cfg);
}

module.exports = { CATALOG, IDS, isKnown, apply, ENTRIES };
