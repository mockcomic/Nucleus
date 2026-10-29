'use strict';
const { app, ipcMain, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');
const actions = require('./actions');
const appsettings = require('./appsettings');
const audio = require('./audio');
const autostart = require('./autostart');
const apps = require('./apps');
const bundle = require('./bundle');
const dashboardIcons = require('./dashboard-icons');
const customIcons = require('./custom-icons');
const exeIcon = require('./exe-icon');
const donate = require('./donate');
const iconGen = require('./icon-gen');
const usage = require('./usage');
const sys = require('./sys');
const { walkItems, sanitizeItem } = require('./config');
const log = require('./logger');
const { supportsVibrancy } = require('./windows');

/* Version string for the UI: app.getVersion() plus the dist build number when
   one has been stamped (log.buildNumber() reads the generated build-info.js
   and returns null for the seed/dev tree, so those displays stay plain). */
function displayVersion() {
  const bn = log.buildNumber();
  const v = app.getVersion();
  return bn ? `${v} (build ${bn})` : v;
}

/**
 * deps = { store, hotkeyMgr, overlay, settings, welcome, tray, getState, setState,
 *          registerHotkey, toggleWheel, quitApp, isQuitting }
 */
function registerIpc(deps) {
  const { store, overlay, settings, welcome, tray } = deps;

  /* ---- sender-frame gate (defense-in-depth, pairs with preload scoping) ----
     A privileged channel answers only the window its API was bridged for; a
     compromised overlay can't invoke config:set directly even if it
     reconstructs the channel name. Read-only channels stay ungated — their
     data is already on-screen in every window. */
  /* Exact file URL of a page we ship, not a substring. A document at
     https://evil/renderer/settings/ or C:\temp\renderer\settings\index.html
     contains the old needle and must not inherit the Settings bridge.
     Compared case-insensitively: Windows file URLs do not preserve case. */
  const isAppPageUrl = (url, page) => {
    let parsed;
    try { parsed = new URL(String(url || '')); } catch { return false; }
    if (parsed.protocol !== 'file:') return false;
    let actual;
    try { actual = fileURLToPath(parsed); } catch { return false; }
    const expected = path.join(app.getAppPath(), 'src', 'renderer', page, 'index.html');
    return path.normalize(actual).toLowerCase() === path.normalize(expected).toLowerCase();
  };
  const frameOn = (ev, ...names) => {
    try {
      const u = (ev.senderFrame && ev.senderFrame.url) || '';
      return names.some((n) => isAppPageUrl(u, n));
    } catch { return false; }
  };
  const PRIVILEGED = {
    'config:set': ['settings'], 'config:flush': ['settings'],
    'config:export': ['settings'], 'config:import': ['settings'],
    'config:reset': ['settings'], 'config:open-folder': ['settings'],
    'hotkey:set': ['settings', 'welcome'], 'autostart:set': ['settings'],
    'action:preview': ['settings'], 'overlay:show': ['settings', 'welcome'],
    'dialog:pick-file': ['settings'],
    // pick-image opens a modal on the Settings window and reads the chosen path
    // in main, so it is gated like every other privileged channel.
    'icons:pick-image': ['settings'], 'icons:add-url': ['settings'],
    // from-program names a path (the program just picked in the editor), but
    // main only runs the shell's icon extraction on it after the allow-list
    // in exe-icon.js (absolute, program extension, exists, isFile) — the
    // observable result is that file's public icon, installed like any
    // picked image. Gated to the page that owns the app picker.
    'icons:from-program': ['settings'],
    // Downloads and log-folder operations have hard-coded targets (fixed CDN
    // host, fixed log dir) — but they still touch network/disk, so they are
    // gated like every other channel. Only Settings bridges these; the wheel
    // resolves its art through icons:data-url, which lists 'wheel' as well.
    'icons:search': ['settings'], 'icons:fetch': ['settings'],
    'icons:data-url': ['settings', 'wheel'],
    'log:open-folder': ['settings'], 'logs:tail': ['settings'],
    // Opens the developer's fixed PayPal.me link (hard-coded in main/donate.js —
    // the renderer never supplies a URL). Touches the machine (default browser),
    // so it is gated like the other open-folder channels. Settings-only: the
    // Support card and the sidebar link both live in this window.
    'donate:open': ['settings'],
    'wheel:segment-click': ['wheel'], 'wheel:dismiss': ['wheel'],
    // growCanvas lets an opened flyout ask for more transparent window; the
    // value is geometry only — clamped and re-centered in Overlay.grow.
    'wheel:grow': ['wheel'],
    // The filter-query flag only decides whether main or the page owns Esc
    // while the wheel is visible — UI state, never data.
    'wheel:filter': ['wheel'],
    // Packages are the export dialog with icon bytes attached; usage:clear
    // empties the recents sidecar. Both Settings-only like every writer.
    'config:export-bundle': ['settings'], 'usage:clear': ['settings'],
    // The stats panel reads the same sidecar usage:clear writes, and the backup
    // list/restore reach into userData — Settings-only, like every other writer.
    'usage:stats': ['settings'], 'config:backups': ['settings'],
    'config:restore-backup': ['settings'],
    'welcome:done': ['welcome'], 'settings:close': ['settings'], 'app:quit': ['settings'],
    // Audio writers reach the system's audio policy — same trust level as the
    // other machine-touching writers. All three writers are granted the wheel
    // frame deliberately: the volume-mixer panel legitimately drags levels AND
    // switches the default output/input device, exactly like the Settings
    // Audio tab it mirrors. That is a reviewed security decision (see
    // tests/unit/ipc-gating.test.js, which pins these owner lists): the wheel
    // renderer is as trusted as the overlay that already executes any
    // configured segment, and every argument is clamped in main/audio.js
    // before it reaches COM — the endpoint id through sanitizeDeviceId, the
    // flow through parseFlow, and a switch is verified by reading the default
    // back through the documented enumerator before {ok:true} is claimed. The
    // read channels (audio:devices/levels/sessions/available) stay ungated
    // like sys:catalog: they hand back data the on-screen UI already shows.
    'audio:set-default': ['settings', 'wheel'],
    'audio:set-volume': ['settings', 'wheel'], 'audio:set-session': ['settings', 'wheel'],
    // The update channels are Settings-only: the chip and the Check-now button
    // live in this window (the tray reaches main directly, not through IPC).
    // open-release still re-validates its URL against main's sanitized
    // snapshot — a compromised page can at worst force the fixed releases page.
    // update:install only re-opens main's own prompt; the download target and
    // the spawn path are chosen in update.js, never by the page.
    'update:state': ['settings'], 'update:check': ['settings'], 'update:open-release': ['settings'],
    'update:install': ['settings']
  };
  const SEND_CHANNELS = new Set(['config:flush', 'wheel:segment-click', 'wheel:dismiss', 'wheel:grow', 'wheel:filter', 'welcome:done', 'settings:close', 'app:quit']);
  const refused = (ch, ev) => {
    log.warn(`refused ${ch} from an untrusted frame`);
    return SEND_CHANNELS.has(ch) ? undefined : { ok: false, error: 'untrusted frame' };
  };
  const guardHandle = (ch, fn) => ipcMain.handle(ch, PRIVILEGED[ch]
    ? (ev, ...a) => (frameOn(ev, ...PRIVILEGED[ch]) ? fn(ev, ...a) : refused(ch, ev))
    : fn);
  const guardOn = (ch, fn) => ipcMain.on(ch, PRIVILEGED[ch]
    ? (ev, ...a) => { if (frameOn(ev, ...PRIVILEGED[ch])) fn(ev, ...a); else refused(ch, ev); }
    : fn);

  const broadcast = (channel, payload) => settings.send(channel, payload);

  /* ---- wheel overlay events ---- */
  guardOn('wheel:dismiss', () => overlay.hide());

  /* A branch-open flyout may reach past the wheel's outer radius (folders on
     the outermost ring). One geometry-only message asks the window to grow
     around itself; main owns all clamping. */
  guardOn('wheel:grow', (e, reachPx) => {
    const n = Number(reachPx);
    if (Number.isFinite(n) && n > 0 && n <= 2048) overlay.grow(n);
  });

  /* Renderer → main: "a type-to-filter query is on screen". While true, Esc
     belongs to the page (it clears the query before it dismisses). */
  guardOn('wheel:filter', (e, on) => overlay.setFiltering(!!on));

  guardOn('wheel:segment-click', async (e, item) => {
    overlay.hide();
    /* The overlay payload is renderer-supplied — never execute it as-is.
       Match the clicked item against the LIVE config by id so a bugged or
       compromised renderer cannot inject an arbitrary action payload. The
       walk is recursive: flyout children live inside folder items. */
    let live = null;
    if (item && typeof item === 'object' && item.id) {
      walkItems(store.get(), (x) => { if (x && x.id === item.id) { live = x; return false; } });
    }
    if (!live) { log.warn('ignored segment click for unknown item', item && item.id); return; }
    item = live;
    /* Usage sidecar: fires from the REAL wheel only (never action:preview —
       test runs must not pollute recents). Feeds the `recent` segment's
       auto-filled fan via usage.resolveRecents on the next summon. Best-
       effort: a state.json write failure must never cost the actual action. */
    try {
      const u = deps.getState('usage', {}) || {};
      usage.record(u, item.id);
      deps.setState('usage', u);
    } catch (err) { log.warn('usage record failed:', err && err.message); }
    // sys.ALIAS forms (volup, clipboard, …) canonicalize through the same map
    // sys.run() uses, so aliased key-actions get the focus-regain wait too.
    const sysKey = sys.ALIAS[String(item.value || '').toLowerCase()] || String(item.value || '').toLowerCase();
    const isKeyAction = item.type === 'macro' || (item.type === 'sys' && sys.KEY_ACTIONS.has(sysKey));
    if (isKeyAction) await new Promise((r) => setTimeout(r, 120)); // let the former window regain focus
    try {
      await actions.executeAction(item, actionCtx());
    } catch (err) {
      if (tray) tray.balloon(`${item && item.label ? item.label : 'Action'} failed`, String(err && err.message || err), 'error');
      log.error('action failed:', item && item.label, (err && (err.stack || err.message)) || err);
    }
  });

  /* Context handed to every executeAction: the quit hook, the live
     focus-existing-app flag (read per click, so the setting takes effect
     without a restart), and the app-setting mutator. applySetting writes
     through store.set() (so handleConfigChanged still re-arms autostart,
     game mode, hotkey policy), then pushes the result to an open Settings
     window with the reload-broadcast shape — its rev/echo/dirty-queue logic
     reconciles the UI instead of clobbering it. */
  function actionCtx() {
    const bhv = (store.get() || {}).behavior || {};
    return {
      quit: () => deps.quitApp(),
      focusExistingApp: bhv.focusExistingApp === true,
      /* Freshly-opened APP WINDOW placement (winplace.js): 'default' | 'cursor'
         | 'center', read per click like focusExistingApp so it applies at once.
         The validated store value is already whitelisted — pass it through. */
      appOpenPosition: bhv.appOpenPosition,
      applySetting: async (id) => {
        const merged = await appsettings.apply(id, store);
        try {
          settings.send('config:changed', { config: JSON.parse(JSON.stringify(merged)), rev: store.rev });
        } catch { /* settings may be closed */ }
        return merged;
      }
    };
  }

  /* ---- config ---- */
  guardHandle('config:get', () => ({
    config: JSON.parse(JSON.stringify(store.get())),
    rev: store.rev,
    hotkeyError: store.hotkeyError || null,
    importedFrom: store.importedFrom || null,
    broken: !!store.broken
  }));

  guardHandle('config:set', (ev, cfg) => {
    // store.set throws when the disk refuses (AV lock, disk full): report it
    // as ok:false so the Settings "Not saved" path runs — never reject the
    // invoke (the renderer's await has no catch and would strand the UI).
    try {
      const merged = store.set(cfg);
      store.broken = false;   // a successful write means config.json is healthy again
      return { ok: true, config: JSON.parse(JSON.stringify(merged)), rev: store.rev, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  // Exit flush from the settings renderer (pagehide/beforeunload): a send()
  // lands here synchronously even while the window is being destroyed. The
  // payload rides through store.set → validate(), so a bad frame can at worst
  // trigger a rejected save, never an arbitrary write.
  guardOn('config:flush', (ev, cfg) => {
    if (!cfg || typeof cfg !== 'object') return;
    try { store.set(cfg); store.broken = false; }
    catch (err) { log.error('exit-flush save failed:', err && err.message); }
  });

  guardHandle('config:export', async (ev) => {
    const w = settings.win;
    const r = await dialog.showSaveDialog(w, {
      title: 'Export config', defaultPath: 'nucleus-config.json',
      filters: [{ name: 'JSON', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    try {
      fs.writeFileSync(r.filePath, JSON.stringify(store.get(), null, 2), 'utf8');
    } catch (err) {
      return { ok: false, error: 'Could not write export: ' + String(err && err.message || err) };
    }
    return { ok: true, path: r.filePath };
  });

  guardHandle('config:export-bundle', async (ev) => {
    const w = settings.win;
    const r = await dialog.showSaveDialog(w, {
      title: 'Export package (config + icons)', defaultPath: 'nucleus-package.json',
      filters: [{ name: 'Nucleus package', extensions: ['json'] }]
    });
    if (r.canceled || !r.filePath) return { ok: false, canceled: true };
    let built;
    try {
      built = bundle.buildBundle(store.get());
    } catch (err) {
      return { ok: false, error: 'Could not build the package: ' + String(err && err.message || err) };
    }
    if (!built.ok) return built;   // over-cap error names the counts — never a silently truncated package
    const json = JSON.stringify(built.bundle, null, 1);
    try {
      const tmp = r.filePath + '.tmp';
      fs.writeFileSync(tmp, json, 'utf8');
      fs.renameSync(tmp, r.filePath);   // same atomic discipline as the config store
    } catch (err) {
      try { fs.unlinkSync(r.filePath + '.tmp'); } catch { /* best effort */ }
      return { ok: false, error: 'Could not write the package: ' + String(err && err.message || err) };
    }
    log.info(`package exported: ${built.icons} icons (${built.skipped.length} missing) -> ${r.filePath}`);
    return { ok: true, path: r.filePath, icons: built.icons, skipped: built.skipped.length };
  });

  /* One import pipeline, two entrances: Advanced → Import… (pick any file) and
     Advanced → Restore a backup… (opens straight at the rolling-backups folder).
     `reason` tags the pre-replacement backup so the file name says what happened. */
  async function importConfigFile(filePath, reason) {
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile() || st.size > bundle.BUNDLE_FILE_MAX) {
        return { ok: false, error: 'That file is too large to import (limit ' + ((bundle.BUNDLE_FILE_MAX / 1048576) | 0) + ' MB)' };
      }
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      /* A package (config + icon bytes) installs its icons FIRST so the first
         summon after the config lands already finds its art. Per-icon failures
         are skips, never aborts — the config import proceeds regardless. */
      const isBundle = bundle.looksLikeBundle(raw);
      let icons = null;
      if (isBundle) {
        const got = bundle.importIcons(raw);
        icons = { installed: got.installed, skipped: got.skipped.length };
        log.info(`package imported: ${got.installed} icons (${got.skipped.length} skipped)`);
      }
      // Always keep the displaced config: this is the one action whose Undo
      // toast the user may never see (window closed, app quit).
      const merged = store.set(isBundle ? raw.config : raw, { backup: 'force', reason });
      store.broken = false;
      return { ok: true, config: merged, rev: store.rev, hotkeyError: store.hotkeyError || null, icons };
    } catch (err) {
      return { ok: false, error: 'Import failed: ' + (err.message || err) };
    }
  }

  guardHandle('config:import', async () => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Import config or package',
      filters: [{ name: 'JSON', extensions: ['json'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    return importConfigFile(r.filePaths[0], 'import');
  });

  /* The backup inventory (newest first) for the Advanced panel. */
  guardHandle('config:backups', () => ({ ok: true, backups: store.listBackups(24) }));

  /* Restore = import, but the dialog opens inside the backups folder so the
     user never has to navigate to %APPDATA% by hand. Cancelling changes nothing. */
  guardHandle('config:restore-backup', async () => {
    const dir = store.backupDir();
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* the dialog reports it */ }
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Restore a config backup', defaultPath: dir,
      filters: [{ name: 'Nucleus config', extensions: ['json'] }], properties: ['openFile']
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const got = await importConfigFile(r.filePaths[0], 'restore');
    if (got.ok) log.info(`config restored from backup: ${path.basename(r.filePaths[0])}`);
    return got;
  });

  /* The Advanced → Usage panel: fire counts joined to the LIVE config, so a
     deleted segment drops out of the list instead of lingering as a phantom. */
  guardHandle('usage:stats', (ev, limit) => {
    try {
      const map = deps.getState('usage', {}) || {};
      const s = usage.stats(store.get(), map, { limit: Number.isFinite(+limit) ? +limit : undefined });
      return Object.assign({ ok: true }, s);
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err), rows: [], segments: 0, totalFires: 0, records: 0, orphans: 0 };
    }
  });

  guardHandle('config:reset', () => {
    try {
      const merged = store.set({}, { backup: 'force', reason: 'reset' }); // validate({}) == defaults
      store.broken = false;
      return { ok: true, config: merged, rev: store.rev, hotkeyError: store.hotkeyError || null };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  guardHandle('config:open-folder', () => shell.openPath(path.dirname(store.file())));

  /* Support the developer — opens the fixed PayPal.me URL from main/donate.js
     in the default browser. No argument crosses the bridge. */
  guardHandle('donate:open', () => donate.openDonate());

  /* Recents live in the state.json sidecar, not the config — clearing them
     never touches the user's segments. */
  guardHandle('usage:clear', () => {
    try {
      deps.setState('usage', {});
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  /* ---- logs ----
     'log:line' is deliberately NOT frame-gated: the preload console hook is a
     fire-and-forget send() that must survive page teardown (crash-time logs),
     and its payload is sanitized + clamped inside the logger. The renderer can
     write log lines, nothing else. */
  ipcMain.on('log:line', (ev, payload) => log.forwardRenderer(payload));
  guardHandle('log:open-folder', () => {
    const d = log.dir();
    if (!d) return { ok: false, error: 'log folder unavailable' };
    try { fs.mkdirSync(d, { recursive: true }); } catch { /* openPath reports the failure */ }
    return shell.openPath(d).then((err) => (err ? { ok: false, error: err } : { ok: true }));
  });
  guardHandle('logs:tail', (ev, n) => {
    const d = log.dir();
    if (!d) return { ok: false, error: 'log folder unavailable', lines: [] };
    try {
      const files = fs.readdirSync(d).filter((f) => /^(?:nucleus|radial-wheel)-\d{4}-\d{2}-\d{2}\.log$/.test(f)).sort();
      if (!files.length) return { ok: true, lines: [], file: null };
      const file = files[files.length - 1];
      const lines = fs.readFileSync(path.join(d, file), 'utf8').split(/\r?\n/).filter(Boolean);
      return { ok: true, file, lines: lines.slice(-Math.max(1, Math.min(n | 0 || 200, 1000))) };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err), lines: [] };
    }
  });

  /* ---- hotkey ---- */
  guardHandle('hotkey:set', (ev, spec) => {
    const prev = store.get();
    const res = deps.registerHotkey(spec, { persist: false });
    if (!res.ok) return { ok: false, error: res.error };
    try {
      store.set({ ...JSON.parse(JSON.stringify(prev)), hotkey: spec });
    } catch (err) {
      // registered but not persisted — roll the registration back to the
      // saved hotkey so what works matches what survives a restart.
      const back = deps.registerHotkey(prev.hotkey, { persist: false });
      return { ok: false, error: String(err && err.message || err) + (back.ok ? '' : ' (and the previous hotkey could not be restored)') };
    }
    return { ok: true, accel: res.accel };
  });

  /* ---- autostart ---- */
  guardHandle('autostart:get', () => ({
    enabled: store.get().behavior.autostart,
    registered: autostart.get(),
    allowed: autostart.allowed()
  }));
  guardHandle('autostart:set', (ev, on) => {
    const r = autostart.set(on);
    if (!r.ok) return { ok: false, error: r.error };
    try {
      // Persist the NEW flag — re-saving the old clone left config.json
      // contradicting the registry until the renderer's debounced save caught
      // up, and if that save never ran (renderer died) the drift was permanent.
      const cur = JSON.parse(JSON.stringify(store.get()));
      cur.behavior.autostart = !!on;
      store.set(cur);
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
    // skipped ('foreign'/'absent'/'unverified'): the disable left a value it
    // does not own (or could not read) — report ok; config stays the truth.
    return { ok: true, verified: r.verified, skipped: r.skipped || null };
  });

  /* ---- icon images (logos + custom artwork for wheel items) ----
     item.iconImage is either a dashboardicons slug or a `custom:<hash>.<kind>`
     key. Both families resolve through ONE channel so the overlay, the Settings
     rows and the live preview share a single lookup. */
  dashboardIcons.configure(path.join(app.getPath('userData'), 'icons', 'dashboard'));
  customIcons.configure(path.join(app.getPath('userData'), 'icons', 'custom'));
  const ringItems = (cfg) => {
    const out = [];
    walkItems(cfg, (it) => { out.push(it); });
    return out;
  };
  /* `builtin:app` (icon-gen's APP_ICON_KEY) is the app's own wheel artwork:
     served here so the overlay, the Settings rows and the live preview all
     resolve art through this one lookup. A render failure (unwritable
     userData) answers null like a cache miss — the segment then falls back to
     its glyph instead of breaking. */
  const appIconsDir = path.join(app.getPath('userData'), 'icons');
  const resolveIconImage = (key) => {
    if (key === iconGen.APP_ICON_KEY) {
      try { return { ok: true, dataUrl: iconGen.appIconDataUrl(appIconsDir) }; }
      catch { return null; }
    }
    return customIcons.isCustomKey(key)
      ? customIcons.dataUrlFor(key)
      : dashboardIcons.dataUrlFor(key);
  };

  guardHandle('icons:search', (ev, query) => dashboardIcons.searchIcons(query));
  guardHandle('icons:fetch', (ev, slug) => dashboardIcons.fetchIcon(slug));
  guardHandle('icons:data-url', (ev, key) => resolveIconImage(key));

  /* The dialog and the read are a single round trip: a renderer can never name
     a path for main to read, only accept or cancel what this window shows. */
  guardHandle('icons:pick-image', async () => {
    const r = await dialog.showOpenDialog(settings.win, {
      title: 'Choose an icon image',
      properties: ['openFile'],
      filters: [
        { name: 'Images', extensions: customIcons.PICK_EXTENSIONS },
        { name: 'All files', extensions: ['*'] }
      ]
    });
    if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
    const got = customIcons.addFile(r.filePaths[0]);
    if (!got.ok) log.warn('custom icon rejected:', got.error);
    return got;
  });

  guardHandle('icons:add-url', async (ev, url) => {
    const got = await customIcons.addUrl(url);
    if (!got.ok) log.warn('custom icon URL rejected:', got.error);
    return got;
  });

  /* Wear a program's own icon (exe-icon.js): the Settings app picker calls
     this right after a target is set, and the icon modal exposes it as a
     button for hand-typed paths. Answers the same {ok,key,dataUrl} shape as
     a picked image; every rejection is a clean {ok:false,error} the caller
     may fold into a glyph fallback. */
  guardHandle('icons:from-program', async (ev, p) => {
    const got = await exeIcon.fromPath(p);
    if (!got.ok) log.warn('program icon rejected:', got.error);
    return got;
  });

  // Prime both disk caches so the wheel never has to wait on a download. Each
  // module ignores keys outside its own family, so one list serves both. The
  // built-in app icon is local — filtering it out keeps anything from trying
  // to "prefetch" it as a dashboard slug.
  const warmIcons = (cfg) => {
    const keys = ringItems(cfg).map((it) => it.iconImage).filter((k) => k && k !== iconGen.APP_ICON_KEY);
    dashboardIcons.warm(keys);
    customIcons.warm(keys);
  };
  warmIcons(store.get());
  store.on('changed', ({ config }) => warmIcons(config));

  /* ---- misc ---- */
  guardHandle('dialog:pick-file', async (ev, opts) => {
    // opts.directory: folder picker (the sys explorer action's start folder);
    // file filters are meaningless there, so they are skipped.
    if (opts && opts.directory) {
      const r = await dialog.showOpenDialog(settings.win, {
        title: opts.title || 'Choose a folder',
        properties: ['openDirectory', 'createDirectory']
      });
      return r.canceled ? null : r.filePaths[0];
    }
    const r = await dialog.showOpenDialog(settings.win, {
      title: (opts && opts.title) || 'Choose a file',
      properties: ['openFile'],
      filters: opts && opts.extensions && opts.extensions.length
        ? [{ name: opts.filterName || 'Programs', extensions: opts.extensions }, { name: 'All files', extensions: ['*'] }]
        : undefined
    });
    return r.canceled ? null : r.filePaths[0];
  });

  guardHandle('action:preview', async (ev, raw) => {
    // Run the SANITIZED item — the same discipline wheel:segment-click applies
    // against the live config. Without it a bugged or compromised settings
    // page could hand executeAction (and through it the SendInput macro
    // engine) an unbounded, unvalidated payload. validate() only enforces the
    // bounds a saved config already obeys, so legitimate previews are
    // untouched.
    const item = sanitizeItem(raw);
    try {
      await actions.executeAction(item, actionCtx());   // same ctx as a real click — preview behaves like the wheel
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err && err.message || err) };
    }
  });

  guardHandle('overlay:show', () => { deps.toggleWheel(true); return { ok: true }; });

  /* ---- welcome (FTU) ---- */
  guardHandle('welcome:info', () => {
    const cfg = store.get();
    const rings = cfg.rings || {};
    const hasWheel = Object.values(rings).some((a) => Array.isArray(a) && a.length);
    return {
      hotkey: cfg.hotkey,
      hotkeyError: store.hotkeyError || null,
      version: displayVersion(),
      importedFrom: store.importedFrom || null,
      hasWheel,
      ftuSeen: !!deps.getState('ftuSeen', false),
      autostartAllowed: autostart.allowed()
    };
  });
  guardOn('welcome:done', (_e, payload) => {
    // Every exit path lands here — so this handler owns the consequences:
    // put the guide away, remember it was seen, hand off to Settings on request.
    // A boolean payload is the older "open Settings?" signal and does not touch
    // startup. An object may also carry applyAutostart, honored only the first
    // time and only for an installed copy (portable must not rewrite the shared
    // config flag).
    const openSettings = payload === true || !!(payload && typeof payload === 'object' && payload.openSettings);
    const first = !deps.getState('ftuSeen', false);
    const apply = payload && typeof payload === 'object' && typeof payload.applyAutostart === 'boolean'
      ? payload.applyAutostart : null;
    welcome.close();
    if (first && apply !== null && autostart.allowed()) {
      try {
        const r = autostart.set(apply);
        if (r && !r.ok) log.warn('autostart from welcome failed:', r.error);
        else if (r && r.ok && r.enabled) log.info(r.verified ? 'login item registered from welcome (verified)' : 'login item written from welcome (verification fell back)');
      }
      catch (err) { log.warn('autostart from welcome failed:', err && err.message); }
      try {
        const cur = JSON.parse(JSON.stringify(store.get()));
        if (!!cur.behavior.autostart !== apply) {
          cur.behavior.autostart = apply;
          store.set(cur);
        }
      } catch (err) {
        log.warn('could not save welcome autostart choice:', err && err.message);
      }
    }
    deps.setState('ftuSeen', true);   // UI state, not config — rides in state.json
    if (openSettings) settings.open();
  });

  guardHandle('sys:catalog', () => sys.CATALOG);

  /* ---- updates (GitHub Releases; main/update.js owns all the logic) ----
     The renderer only ever sees sanitized strings and main's own rebuilt
     release URL; the fetch, the cache file, the installer download and the
     spawn of the downloaded file all live in main. Deps arrive through
     registerIpc so the channels stay callable without the update wiring
     (stub-safe for tests). */
  const uSnap = () => (deps.updateSnapshot ? deps.updateSnapshot()
    : { ok: true, status: 'none', kind: null, info: null, lastCheckMs: 0, error: null });
  guardHandle('update:state', () => uSnap());
  guardHandle('update:check', async () => {
    try { return deps.checkUpdate ? await deps.checkUpdate() : uSnap(); }
    catch (err) { return { ok: false, status: 'error', error: String((err && err.message) || err), info: null }; }
  });
  guardHandle('update:open-release', async (ev, url) => {
    try { return deps.openRelease ? await deps.openRelease(url) : { ok: false, error: 'updates unavailable' }; }
    catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
  });
  /* "Update available" in the page asks again: main shows the same dialog the
     tray/balloon path shows (download + run, or the release page). The page
     sends nothing but the channel name — no URL, no path, no version. */
  guardHandle('update:install', async () => {
    try { return deps.updateNow ? await deps.updateNow() : uSnap(); }
    catch (err) { return { ok: false, status: 'error', error: String((err && err.message) || err), info: null }; }
  });

  /* ---- audio (Core Audio control; every answer is {ok,…}|{ok:false,error}) --
     Reads are ungated like sys:catalog — endpoint ids, display names, and
     volume levels are exactly what the on-screen UI shows. The writers
     (set-default / set-volume / set-session) flip real system state and are
     PRIVILEGED-gated to the two pages that own audio UI — Settings and the
     wheel's mixer card (the PRIVILEGED map records why the wheel holds all
     three writers); argument shapes are clamped in main/audio.js before
     anything reaches COM. */
  guardHandle('audio:available', () => audio.available());
  guardHandle('audio:devices', (ev, flow, includeHidden) => {
    const r = audio.listDevices(flow);
    /* The app-level hidden list (behavior.audioHidden) applies HERE — every
       surface (Settings tab, wheel card, editor picker) reads through this
       channel, so none can disagree about what is "in the list", and a
       renderer can't opt out of the filter. The one legitimate exception is
       the Settings Audio tab's hidden-device manager, which passes
       includeHidden === true (strict) to see the whole picture; anything else
       — absent, junk, a truthy string — stays filtered. The current default
       is exempt inside filterHiddenDevices, and audio:set-default is
       deliberately unfiltered: a device hidden after being bound to a segment
       must still be switchable. */
    if (r.ok && includeHidden !== true) {
      const hidden = (store.get().behavior || {}).audioHidden || {};
      r.devices = audio._filterHiddenDevices(r.devices,
        audio._parseFlow(flow) === 1 ? hidden.capture : hidden.render);
    }
    return r;
  });
  guardHandle('audio:levels', (ev, flow) => audio.getLevels(flow));
  guardHandle('audio:sessions', () => audio.listSessions());
  guardHandle('audio:set-default', (ev, flow, deviceId) => audio.setDefaultDevice(flow, deviceId));
  guardHandle('audio:set-volume', (ev, flow, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const vol = +p.volume;
    return audio.setLevels(flow, {
      volume: Number.isFinite(vol) ? vol : null,
      muted: typeof p.muted === 'boolean' ? p.muted : null
    });
  });
  guardHandle('audio:set-session', (ev, pid, payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const vol = +p.volume;
    return audio.setSession(pid, {
      volume: Number.isFinite(vol) ? vol : null,
      muted: typeof p.muted === 'boolean' ? p.muted : null
    });
  });
  // Read-only, like sys:catalog: the app-setting dropdown data (labels/groups
  // only — execution stays id-gated inside appsettings.apply).
  guardHandle('appsettings:catalog', () => appsettings.CATALOG);
  guardHandle('apps:list', (ev, force) => apps.listApps(!!force));
  guardHandle('app:version', () => displayVersion());
  guardHandle('env:get', () => ({ vibrant: supportsVibrancy() }));
  guardOn('settings:close', () => settings.close());
  guardOn('app:quit', () => deps.quitApp());
}

module.exports = { registerIpc };

