'use strict';
/* Action dispatch: runs wheel items of every type and reports failures. */
const fs = require('fs');
const { shell } = require('electron');
const { spawn } = require('child_process');
const macro = require('./macro');
const sys = require('./sys');

function spawnDetached(cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false });
  child.unref();
  return child;
}

/**
 * Execute one configured item. Throws Error with a user-readable message on failure.
 * ctx: { quit?: () => void }
 */
async function executeAction(item, ctx = {}) {
  if (!item || typeof item !== 'object') throw new Error('invalid item');
  const type = String(item.type || 'app').toLowerCase();
  const value = String(item.value || '').trim();

  switch (type) {
    case 'url': {
      if (!value) throw new Error('no URL configured');
      const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'https://' + value;
      const err = await shell.openExternal(url);
      if (err) throw new Error(err);
      return;
    }
    case 'file': {
      if (!value) throw new Error('no file configured');
      const err = await shell.openPath(value);
      if (err) throw new Error(err === '' ? 'could not open file' : err);
      return;
    }
    case 'app': {
      if (!value) throw new Error('no program configured');
      const target = value.replace(/^"|"$/g, '');
      let exists = false;
      try { exists = fs.existsSync(target); } catch {}
      if (exists && /\.(lnk|bat|cmd)$/i.test(target)) {
        // Start-Menu shortcuts and batch files need ShellExecute semantics:
        // cmd's `start ""` resolves them exactly like a double-click.
        const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', target],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        child.on('error', (e) => { throw new Error(`could not launch '${target}': ${e.message}`); });
        return;
      }
      if (exists) {
        const err = await shell.openPath(target);
        if (err) throw new Error(err || `could not open '${target}'`);
        return;
      }
      const cmd = target.match(/^([^\s]+\.exe(?:\.com)?|"[^"]+")\s*(.*)$/i);
      if (cmd) {
        const child = spawnDetached(cmd[1], cmd[2] ? [cmd[2]] : []);
        child.on('error', () => { throw new Error(`could not launch '${value}'`); });
        return;
      }
      // last resort: shell resolution (e.g. "notepad", "ms-...", store links)
      const child = spawn(target, { detached: true, stdio: 'ignore', windowsHide: true, shell: true });
      child.unref();
      child.on('error', () => { throw new Error(`could not launch '${value}'`); });
      return;
    }
    case 'command': {
      if (!value) throw new Error('no command configured');
      const child = spawn(value, { detached: true, stdio: 'ignore', windowsHide: true, shell: true });
      child.unref();
      child.on('error', (e) => { throw new Error(`command failed: ${e.message}`); });
      return;
    }
    case 'macro': {
      await macro.sendMacro(value);
      return;
    }
    case 'sys': {
      await sys.run(value, ctx);
      return;
    }
    default:
      throw new Error(`unknown action type '${type}'`);
  }
}

module.exports = { executeAction };
