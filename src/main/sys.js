'use strict';
/* Built-in Windows actions. `run(id)` executes; the CATALOG drives the settings dropdown. */
const { shell } = require('electron');
const { spawn } = require('child_process');
const macro = require('./macro');

const ALIAS = {
  volup: 'volume_up', voldown: 'volume_down', taskmgr: 'task_manager',
  showdesktop: 'show_desktop', clipboard: 'clipboard_history', emoji: 'emoji_picker',
  quit: 'exit_app'
};

const CATALOG = [
  { id: 'lock', label: 'Lock workstation', icon: '\uE72E', group: 'System' },
  { id: 'sleep', label: 'Sleep', icon: '\uE7E8', group: 'System' },
  { id: 'screenshot', label: 'Snip / screenshot', icon: '\uE7B5', group: 'System' },
  { id: 'show_desktop', label: 'Show desktop', icon: '\uE7F4', group: 'System' },
  { id: 'task_manager', label: 'Task Manager', icon: '\uE9D9', group: 'System' },
  { id: 'exit_app', label: 'Quit Radial Wheel', icon: '\uE711', group: 'System' },
  { id: 'mute', label: 'Mute audio', icon: '\uE74E', group: 'Audio' },
  { id: 'volume_up', label: 'Volume up', icon: '\uE995', group: 'Audio' },
  { id: 'volume_down', label: 'Volume down', icon: '\uE993', group: 'Audio' },
  { id: 'sound', label: 'Sound settings', icon: '\uE767', group: 'Audio' },
  /* hasDir: the action accepts an optional folder in the item's `dir` field
     (surfaced as a Folder input + Browse… in the settings editor). */
  { id: 'explorer', label: 'File Explorer', icon: '\uE8B7', group: 'Files', hasDir: true },
  { id: 'recycle_bin', label: 'Recycle Bin', icon: '\uE74D', group: 'Files' },
  { id: 'settings', label: 'Windows Settings', icon: '\uE713', group: 'Settings' },
  { id: 'wifi', label: 'Wi-Fi settings', icon: '\uE701', group: 'Settings' },
  { id: 'bluetooth', label: 'Bluetooth settings', icon: '\uE702', group: 'Settings' },
  { id: 'notifications', label: 'Notifications / focus', icon: '\uE91C', group: 'Settings' },
  { id: 'night_light', label: 'Night light', icon: '\uE708', group: 'Settings' },
  { id: 'display', label: 'Display settings', icon: '\uE7F4', group: 'Settings' },
  { id: 'power', label: 'Power settings', icon: '\uE850', group: 'Settings' },
  { id: 'clipboard_history', label: 'Clipboard history', icon: '\uF0E3', group: 'Input' },
  { id: 'emoji_picker', label: 'Emoji picker', icon: '\uE740', group: 'Input' }
];

const IDS = new Set(CATALOG.map(c => c.id));

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

async function run(id, ctx = {}, opts = {}) {
  const key = ALIAS[String(id || '').toLowerCase()] || String(id || '').toLowerCase();
  switch (key) {
    case 'lock': return spawnDetached('rundll32.exe', ['user32.dll,LockWorkStation']);
    case 'sleep': return spawnDetached('rundll32.exe', ['powrprof.dll,SetSuspendState', '0,1,0']);
    case 'screenshot': return macro.sendChord(['win', 'shift', 's']);
    case 'show_desktop': return macro.sendChord(['win', 'd']);
    case 'clipboard_history': return macro.sendChord(['win', 'v']);
    case 'emoji_picker': return macro.sendChord(['win', 'period']);
    case 'mute': return macro.sendVk(0xAD);
    case 'volume_up': return macro.sendVk(0xAF);
    case 'volume_down': return macro.sendVk(0xAE);
    case 'task_manager': return spawnDetached('taskmgr.exe', []);
    // A user-picked folder opens directly; empty dir keeps the default view.
    case 'explorer': return spawnDetached('explorer.exe', opts.dir ? [opts.dir] : []);
    case 'recycle_bin': {
      const err = await shell.openPath('shell:RecycleBinFolder');
      if (err) throw new Error(err);
      return;
    }
    case 'settings': return openSettingsUri('ms-settings:');
    case 'wifi': return openSettingsUri('ms-settings:network-wifi');
    case 'bluetooth': return openSettingsUri('ms-settings:bluetooth');
    case 'notifications': return openSettingsUri('ms-settings:notifications');
    case 'night_light': return openSettingsUri('ms-settings:nightlight');
    case 'display': return openSettingsUri('ms-settings:display');
    case 'sound': return openSettingsUri('ms-settings:sound');
    case 'power': return openSettingsUri('ms-settings:power');
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

module.exports = { CATALOG, IDS, ALIAS, run };
