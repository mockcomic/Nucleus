'use strict';
/* Usage tracking + the auto-filled `recent` segment.
   Counts ride the sidecar state.json under the 'usage' key — { [itemId]:
   { n: fireCount, t: lastUsedMs } } — never config.json, so stats stay out of
   exported/shared configs and a corrupt state file costs nothing (readState
   already returns {} on any failure).

   Electron- and fs-free: main owns the state file (main.js getState/setState)
   and passes plain objects in, so everything here is pure and unit-testable.
   The item walk mirrors config.walkItems (CommonJS + Electron); keep the two
   in step — tests/unit/usage.test.js pins the behaviors that matter. */

const MAX_KEYS = 400;          // state.json growth guard — least-recently-used entries go first
const MAX_N = 1e6;             // absurd fire-count cap; a resident app never needs more
const RECENT_MAX = 12;         // mirror of config.js MAX_CHILDREN — a fan past this is unreadable
const DEFAULT_COUNT = 8;
const MIN_COUNT = 3;
const MAX_COUNT = 12;

/* Bump one item's record IN PLACE (caller hands us the parsed state object).
   Non-string / oversized ids are ignored — they can never match a live item. */
function record(map, id, now = Date.now()) {
  if (!map || typeof map !== 'object' || typeof id !== 'string' || !id || id.length > 64) return map;
  const prev = map[id] && typeof map[id] === 'object' ? map[id] : null;
  const n = prev && Number.isFinite(prev.n) ? Math.min(prev.n + 1, MAX_N) : 1;
  map[id] = { n, t: now };
  const keys = Object.keys(map);
  if (keys.length > MAX_KEYS) {
    // Evict the oldest by last-use, never the entry we just touched.
    // Oldest last-use FIRST in the eviction walk (the just-touched entry is
    // newest by t, so it sits at the end of the list and is safe).
    keys.sort((a, b) => ((map[a] && map[a].t) || 0) - ((map[b] && map[b].t) || 0));
    for (const k of keys) {
      if (Object.keys(map).length <= MAX_KEYS) break;
      if (k === id) continue;
      delete map[k];
    }
  }
  return map;
}

/* Walk every executable item — rings + profile rings, folder children included.
   Folders and recent segments are containers, never candidates. */
function candidates(cfg, usageMap) {
  const out = [];
  const groups = [];
  if (cfg && cfg.rings && typeof cfg.rings === 'object') groups.push(cfg.rings);
  if (cfg && Array.isArray(cfg.profiles)) {
    for (const p of cfg.profiles) if (p && p.rings && typeof p.rings === 'object') groups.push(p.rings);
  }
  const seen = new Set();
  const down = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object' || typeof it.id !== 'string') continue;
      if (it.type === 'folder' || it.type === 'recent') {
        if (Array.isArray(it.children) && it.children.length) down(it.children);   // leaves live inside folders; the box itself never fires
        continue;
      }
      const u = usageMap && usageMap[it.id];
      if (!u || !Number.isFinite(u.t) || u.t <= 0) continue;          // never used (or junk record)
      if (seen.has(it.id)) continue;                                   // duplicate ids: first occurrence wins
      seen.add(it.id);
      out.push({ item: it, n: Number.isFinite(u.n) ? u.n : 1, t: u.t });
    }
  };
  for (const rings of groups) for (const k of Object.keys(rings)) down(rings[k]);
  return out;
}

/* The wheel's payload pass: replace every `recent` item's children with the
   most-recently-used actions. Returns `config` UNTOUCHED (same reference, zero
   clone) when nothing needs resolving — the summon path calls this every pop. */
function resolveRecents(config, usageMap, count = DEFAULT_COUNT, now = Date.now()) {
  let want = Number.isFinite(count) ? Math.round(count) : DEFAULT_COUNT;
  want = Math.max(MIN_COUNT, Math.min(MAX_COUNT, want, RECENT_MAX));
  let targets = 0;
  const scan = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'recent') targets++;
      if (Array.isArray(it.children) && it.children.length) scan(it.children);
    }
  };
  if (config && config.rings) for (const k of Object.keys(config.rings)) scan(config.rings[k]);
  if (config && Array.isArray(config.profiles)) {
    for (const p of config.profiles) if (p && p.rings) for (const k of Object.keys(p.rings)) scan(p.rings[k]);
  }
  if (!targets) return config;                                         // hot path: no recent segments → no clone

  const ranked = candidates(config, usageMap)
    .sort((a, b) => (b.t - a.t) || (b.n - a.n))                        // most recent first; ties by fire count
    .slice(0, want)
    .map((c) => c.item);
  const out = JSON.parse(JSON.stringify(config));                      // deep copy — the store's object is never mutated
  const pool = ranked.map((it) => JSON.parse(JSON.stringify(it)));     // fresh copies, real ids intact (ipc live-match)
  const fill = (arr) => {
    for (const it of Array.isArray(arr) ? arr : []) {
      if (!it || typeof it !== 'object') continue;
      if (it.type === 'recent') {
        /* Present the filled container as an ordinary folder: the shared
           renderer's dwell/fan/chevron machinery then drives it untouched.
           `recent` stays as a marker (nothing in the renderer reads it; the
           STORE config still says type 'recent' — this rewrite only exists
           inside the one-shot overlay payload). Children keep the real item
           ids, so the overlay's live-id match in ipc.js executes them. */
        it.type = 'folder';
        it.recent = true;
        it.icon = it.icon || '\uE823';                                 // history-clock glyph if unset
        it.children = pool.map((x) => JSON.parse(JSON.stringify(x)));
      } else if (Array.isArray(it.children) && it.children.length) fill(it.children);
    }
  };
  if (out.rings) for (const k of Object.keys(out.rings)) fill(out.rings[k]);
  if (out.profiles) for (const p of out.profiles) if (p && p.rings) for (const k of Object.keys(p.rings)) fill(p.rings[k]);
  return out;
}

module.exports = {
  record, candidates, resolveRecents,
  MAX_KEYS, MAX_N, RECENT_MAX, DEFAULT_COUNT, MIN_COUNT, MAX_COUNT
};
