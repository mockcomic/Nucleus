'use strict';
/* Built-in Windows actions. `run(id)` executes; the CATALOG drives the settings dropdown. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shell } = require('electron');
const { spawn } = require('child_process');
const macro = require('./macro');
const audio = require('./audio');

const ALIAS = {
  volup: 'volume_up', voldown: 'volume_down', taskmgr: 'task_manager',
  showdesktop: 'show_desktop', clipboard: 'clipboard_history', emoji: 'emoji_picker',
  quit: 'exit_app',
  volmixer: 'volume_mixer', playpause: 'play_pause', nexttrack: 'next_track',
  prevtrack: 'prev_track', actioncenter: 'action_center', taskview: 'task_view',
  snaplayouts: 'snap_layouts', rundialog: 'run_dialog', thispc: 'this_pc',
  controlpanel: 'control_panel', devicemgr: 'device_manager',
  windowsupdate: 'windows_update', installedapps: 'installed_apps',
  defaultapps: 'default_apps', osk: 'screen_keyboard', signout: 'sign_out',
  setout: 'set_output_device', setin: 'set_input_device'
};

const CATALOG = [
  { id: 'lock', label: 'Lock workstation', icon: '\uE72E', group: 'System' },
  { id: 'sleep', label: 'Sleep', icon: '\uE7E8', group: 'System' },
  { id: 'screenshot', label: 'Snip / screenshot', icon: '\uE7B5', group: 'System' },
  { id: 'show_desktop', label: 'Show desktop', icon: '\uE7F4', group: 'System' },
  { id: 'task_manager', label: 'Task Manager', icon: '\uE9D9', group: 'System' },
  { id: 'action_center', label: 'Action Center', icon: '\uE81E', group: 'System' },
  { id: 'run_dialog', label: 'Run dialog', icon: '\uE756', group: 'System' },
  { id: 'exit_app', label: 'Quit Radial Wheel', icon: '\uE711', group: 'System' },
  { id: 'mute', label: 'Mute audio', icon: '\uE74E', group: 'Audio' },
  { id: 'volume_up', label: 'Volume up', icon: '\uE995', group: 'Audio' },
  { id: 'volume_down', label: 'Volume down', icon: '\uE993', group: 'Audio' },
  { id: 'volume_mixer', label: 'Volume Mixer', icon: '\uE767', group: 'Audio' },
  /* Device-bound actions: like `explorer`'s hasDir Folder box, the editor
     surfaces a picker — here it lists the live audio endpoints of the given
     flow and stores the chosen endpoint id in the item's `dir` field. */
  { id: 'set_output_device', label: 'Set audio output device', icon: '\uE995', group: 'Audio', hasDevice: 'render' },
  { id: 'set_input_device', label: 'Set audio input device', icon: '\uE720', group: 'Audio', hasDevice: 'capture' },
  { id: 'play_pause', label: 'Play / Pause', icon: '\uE9A1', group: 'Audio' },
  { id: 'next_track', label: 'Next track', icon: '\uE950', group: 'Audio' },
  { id: 'prev_track', label: 'Previous track', icon: '\uE950', group: 'Audio' },
  { id: 'sound', label: 'Sound settings', icon: '\uE767', group: 'Audio' },
  { id: 'task_view', label: 'Task View', icon: '\uE9D9', group: 'Windows' },
  { id: 'snap_layouts', label: 'Snap layouts', icon: '\uE8F1', group: 'Windows' },
  { id: 'minimize_windows', label: 'Minimize all windows', icon: '\uE838', group: 'Windows' },
  { id: 'project', label: 'Project screen', icon: '\uE7F4', group: 'Windows' },
  { id: 'desktop_left', label: 'Switch desktop ←', icon: '\uE7F4', group: 'Windows' },
  { id: 'desktop_right', label: 'Switch desktop →', icon: '\uE7F4', group: 'Windows' },
  /* hasDir: the action accepts an optional folder in the item's `dir` field
     (surfaced as a Folder input + Browse… in the settings editor). Anything
     Explorer's address bar takes works — absolute paths, `%VAR%\…`, `~/Downloads`,
     a bare known-folder name, and `shell:` / `::{CLSID}` verbs. */
  { id: 'explorer', label: 'File Explorer', icon: '\uE8B7', group: 'Files', hasDir: true },
  { id: 'recycle_bin', label: 'Recycle Bin', icon: '\uE74D', group: 'Files' },
  { id: 'this_pc', label: 'This PC', icon: '\uE9DB', group: 'Files' },
  { id: 'settings', label: 'Windows Settings', icon: '\uE713', group: 'Settings' },
  { id: 'control_panel', label: 'Control Panel', icon: '\uE8F1', group: 'Settings' },
  { id: 'device_manager', label: 'Device Manager', icon: '\uE713', group: 'Settings' },
  { id: 'services', label: 'Services', icon: '\uE8CC', group: 'Settings' },
  { id: 'wifi', label: 'Wi-Fi settings', icon: '\uE701', group: 'Settings' },
  { id: 'bluetooth', label: 'Bluetooth settings', icon: '\uE702', group: 'Settings' },
  { id: 'notifications', label: 'Notifications / focus', icon: '\uE91C', group: 'Settings' },
  { id: 'night_light', label: 'Night light', icon: '\uE708', group: 'Settings' },
  { id: 'display', label: 'Display settings', icon: '\uE7F4', group: 'Settings' },
  { id: 'game_bar', label: 'Xbox Game Bar', icon: '\uE9AC', group: 'Settings' },
  { id: 'windows_update', label: 'Windows Update', icon: '\uE71D', group: 'Settings' },
  { id: 'installed_apps', label: 'Installed apps', icon: '\uE734', group: 'Settings' },
  { id: 'default_apps', label: 'Default apps', icon: '\uE70F', group: 'Settings' },
  { id: 'storage', label: 'Storage settings', icon: '\uE825', group: 'Settings' },
  { id: 'privacy', label: 'Privacy settings', icon: '\uE721', group: 'Settings' },
  { id: 'power', label: 'Power settings', icon: '\uE850', group: 'Settings' },
  { id: 'clipboard_history', label: 'Clipboard history', icon: '\uF0E3', group: 'Input' },
  { id: 'emoji_picker', label: 'Emoji picker', icon: '\uE740', group: 'Input' },
  { id: 'screen_keyboard', label: 'On-Screen Keyboard', icon: '\uE8A1', group: 'Input' },
  { id: 'magnifier', label: 'Magnifier', icon: '\uE754', group: 'Input' },
  { id: 'hibernate', label: 'Hibernate', icon: '\uE709', group: 'Power' },
  /* Shutdown / restart get a 15 s grace window (visible countdown + cancel
     note in the Windows shutdown dialog) — a mis-clicked wheel segment must
     not vaporise an unsaved document. `shutdown /a` also aborts within it. */
  { id: 'restart', label: 'Restart', icon: '\uE72C', group: 'Power' },
  { id: 'shutdown', label: 'Shut down', icon: '\uE850', group: 'Power' },
  { id: 'sign_out', label: 'Sign out', icon: '\uE711', group: 'Power' }
];

const IDS = new Set(CATALOG.map(c => c.id));

/* Shown in the Windows shutdown dialog during the grace window. */
const CANCEL_NOTE = 'Radial Wheel: cancel with "shutdown /a" (Task Manager → Run)';

/* Ids whose action injects keystrokes (SendInput) rather than spawning a
   process. ipc.js waits for the pre-wheel window to regain focus before
   firing these — keep in sync with the macro.sendChord/sendVk cases below. */
const KEY_ACTIONS = new Set([
  'screenshot', 'show_desktop', 'action_center', 'run_dialog', 'task_view',
  'snap_layouts', 'minimize_windows', 'project', 'desktop_left', 'desktop_right',
  'clipboard_history', 'emoji_picker', 'mute', 'volume_up', 'volume_down',
  'play_pause', 'next_track', 'prev_track'
]);

/* Fire-and-forget launch, but startup failures surface honestly: the 'error'
   event (ENOENT, AV-blocked binary, …) arrives asynchronously — long after
   run() would otherwise resolve — so throwing from that handler would be an
   uncaughtException killing the resident process. Resolve on 'spawn' (or a
   1.5 s grace window), reject on 'error'; callers already await run(). */
function spawnDetached(cmd, args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    const timer = setTimeout(() => done(resolve), 1500);
    child.once('error', (e) => done(reject, new Error(`failed to start ${cmd}: ${e.message}`)));
    child.once('spawn', () => done(resolve));
  });
}

/* The sys `explorer` action's optional folder parameter.
   Launching it as `explorer.exe <path>` does NOT work: Node quotes any argument
   containing a space for CreateProcess, and explorer.exe's hand-rolled
   command-line parser drops such a path (and any path written with forward
   slashes) back to its default view — the Folder box silently did nothing.
   ShellExecute via shell.openPath is the double-click semantics: spaces, UNC
   paths and long paths all resolve the way Explorer itself resolves them. */
async function openExplorer(dir) {
  const target = normalizeFolder(dir);
  if (!target) return spawnDetached('explorer.exe', []);          // default view
  if (isShellVerb(target)) {                                       // shell:…, ::{CLSID}
    const err = await shell.openPath(target);
    if (err) throw new Error(`${target}: ${err}`);
    return;
  }
  let st = null;
  try { st = fs.statSync(target); } catch { /* reported below */ }
  if (!st) throw new Error(`folder not found: ${target}`);
  if (!st.isDirectory()) {                     // a file was typed in — reveal it instead
    shell.showItemInFolder(target);
    return;
  }
  const err = await shell.openPath(target);
  if (err) throw new Error(`${target}: ${err}`);
}

/* Accept what Explorer's own address bar accepts: surrounding quotes (pasted
   out of a shell), %VARIABLES%, `~/…` and a bare `Downloads`-style name
   (resolved against the profile), forward slashes, trailing separators. */
function normalizeFolder(dir) {
  let s = String(dir || '').trim().replace(/^["']+|["']+$/g, '').trim();
  if (!s) return '';
  s = s.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (m, k) => {
    const v = process.env[k];
    return v === undefined ? m : v;
  });
  s = s.trim();
  if (isShellVerb(s)) return s;
  s = s.replace(/\//g, '\\');                                // pasted with forward slashes
  s = s.replace(/\\+$/, '');                                 // trailing separator trips ShellExecute
  if (/^[A-Za-z]:$/.test(s)) s += '\\';                      // drive root needs its slash back
  if (/^~(?:\\|$)/.test(s)) s = path.win32.join(os.homedir(), s.slice(1).replace(/^\\+/, ''));
  else if (!path.win32.isAbsolute(s)) s = path.win32.resolve(os.homedir(), s);
  return s;
}

function isShellVerb(s) {
  const t = String(s).replace(/^["']+|["']+$/g, '');
  return /^shell:/i.test(t) || /^::\{[0-9a-f-]+\}/i.test(t);
}

/* A device-bound segment carries the endpoint id in `dir` (the same field the
   explorer action uses for its folder — generic per-item payload). Throwing
   routes the failure into the wheel's existing balloon path. */
async function applyDefaultDevice(flow, dir) {
  const got = audio.setDefaultDevice(flow, dir);
  if (!got.ok) throw new Error(got.error || 'could not change the default audio device');
}

async function run(id, ctx = {}, opts = {}) {
  const key = ALIAS[String(id || '').toLowerCase()] || String(id || '').toLowerCase();
  switch (key) {
    case 'lock': return spawnDetached('rundll32.exe', ['user32.dll,LockWorkStation']);
    case 'sleep': return spawnDetached('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    case 'screenshot': return macro.sendChord(['win', 'shift', 's']);
    case 'show_desktop': return macro.sendChord(['win', 'd']);
    case 'clipboard_history': return macro.sendChord(['win', 'v']);
    case 'emoji_picker': return macro.sendChord(['win', 'period']);
    case 'action_center': return macro.sendChord(['win', 'a']);
    case 'run_dialog': return macro.sendChord(['win', 'r']);
    case 'task_view': return macro.sendChord(['win', 'tab']);
    case 'snap_layouts': return macro.sendChord(['win', 'z']);
    case 'minimize_windows': return macro.sendChord(['win', 'm']);
    case 'project': return macro.sendChord(['win', 'p']);
    case 'desktop_left': return macro.sendChord(['ctrl', 'win', 'left']);
    case 'desktop_right': return macro.sendChord(['ctrl', 'win', 'right']);
    case 'mute': return macro.sendVk(0xAD);
    case 'volume_up': return macro.sendVk(0xAF);
    case 'volume_down': return macro.sendVk(0xAE);
    case 'play_pause': return macro.sendVk(0xB3);
    case 'next_track': return macro.sendVk(0xB0);
    case 'prev_track': return macro.sendVk(0xB1);
    case 'volume_mixer': return spawnDetached('sndvol.exe', []);
    /* Device switches run in-process over COM (no SendInput, no spawned
       child), so they stay out of KEY_ACTIONS — the overlay-hide focus wait
       exists for injected keystrokes only. */
    case 'set_output_device': return applyDefaultDevice('render', opts.dir);
    case 'set_input_device': return applyDefaultDevice('capture', opts.dir);
    case 'task_manager': return spawnDetached('taskmgr.exe', []);
    // A user-picked folder opens directly; empty dir keeps the default view.
    case 'explorer': return openExplorer(opts.dir);
    case 'recycle_bin': {
      const err = await shell.openPath('shell:RecycleBinFolder');
      if (err) throw new Error(err);
      return;
    }
    case 'this_pc': {
      const err = await shell.openPath('shell:MyComputerFolder');
      if (err) throw new Error(err);
      return;
    }
    case 'control_panel': return spawnDetached('control.exe', []);
    // .msc snap-ins are not executables — spawn() (no shell) can only reach
    // them through mmc.exe, which resolves them from System32.
    case 'device_manager': return spawnDetached('mmc.exe', ['devmgmt.msc']);
    case 'services': return spawnDetached('mmc.exe', ['services.msc']);
    case 'settings': return openSettingsUri('ms-settings:');
    case 'wifi': return openSettingsUri('ms-settings:network-wifi');
    case 'bluetooth': return openSettingsUri('ms-settings:bluetooth');
    case 'notifications': return openSettingsUri('ms-settings:notifications');
    case 'night_light': return openSettingsUri('ms-settings:nightlight');
    case 'display': return openSettingsUri('ms-settings:display');
    case 'sound': return openSettingsUri('ms-settings:sound');
    case 'power': return openSettingsUri('ms-settings:power');
    case 'game_bar': return openSettingsUri('ms-settings:gaming-gamebar');
    case 'windows_update': return openSettingsUri('ms-settings:windowsupdate');
    case 'installed_apps': return openSettingsUri('ms-settings:appsfeatures');
    case 'default_apps': return openSettingsUri('ms-settings:defaultapps');
    case 'storage': return openSettingsUri('ms-settings:storagesense');
    case 'privacy': return openSettingsUri('ms-settings:privacy');
    case 'screen_keyboard': return spawnDetached('osk.exe', []);
    case 'magnifier': return spawnDetached('magnify.exe', []);
    case 'hibernate': return spawnDetached('shutdown.exe', ['/h']);
    case 'restart': return spawnDetached('shutdown.exe', ['/r', '/t', '15', '/c', CANCEL_NOTE]);
    case 'shutdown': return spawnDetached('shutdown.exe', ['/s', '/t', '15', '/c', CANCEL_NOTE]);
    case 'sign_out': return spawnDetached('shutdown.exe', ['/l']);
    case 'exit_app':
      if (ctx.quit) ctx.quit();
      return;
    default: throw new Error(`unknown system action '${id}'`);
  }
}

async function openSettingsUri(uri) {
  const err = await shell.openExternal(uri);
  if (err) throw new Error(`${uri}: ${err}`);
}

module.exports = { CATALOG, IDS, ALIAS, KEY_ACTIONS, run, normalizeFolder, openExplorer };
