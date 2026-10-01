'use strict';
/* Action dispatch: runs wheel items of every type and reports failures. */
const fs = require('fs');
const { shell } = require('electron');
const { spawn } = require('child_process');
const macro = require('./macro');
const sys = require('./sys');
const { splitArgs } = require('./args');

/* Fire-and-forget launch that still surfaces STARTUP failures: 'error'
   (ENOENT, AV block, …) fires asynchronously, after executeAction would
   otherwise have resolved — throwing from that handler is an uncaughtException
   that kills the resident app. Resolve on 'spawn' (or a 1.5 s grace window),
   reject on 'error'; every caller awaits executeAction and shows the error. */
function launchDetached(cmd, args, label = cmd, opts = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, shell: false, ...opts });
    child.unref();
    const timer = setTimeout(() => done(resolve), 1500);
    child.once('error', (e) => done(reject, new Error(`could not launch '${label}': ${e.message}`)));
    child.once('spawn', () => done(resolve));
  });
}

/**
 * Run a cmd.exe command line, fire-and-forget but honest about immediate
 * failure: a bad command (typo, bad syntax) makes cmd exit non-zero almost
 * at once — reject with that code so the preview toast reports it instead of
 * claiming success. A command still running past the grace window counts as
 * launched (the child stays alive; it is detached + unref'd).
 */
function runShellCommand(value) {
  return new Promise((resolve, reject) => {
    const child = spawn(value, { detached: true, stdio: 'ignore', windowsHide: true, shell: true });
    child.unref();
    let settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; clearTimeout(timer); fn(arg); };
    const timer = setTimeout(() => done(resolve), 2000);
    child.once('error', (e) => done(reject, new Error(`command failed: ${e.message}`)));
    child.once('close', (code) => {
      if (code === 0 || code === null) done(resolve);
      else done(reject, new Error(`command exited with code ${code}`));
    });
  });
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
      const rawArgs = String(item.args || '').trim();
      const tokens = splitArgs(rawArgs);
      let exists = false;
      try { exists = fs.existsSync(target); } catch {}
      if (exists && (tokens.length || /\.(lnk|bat|cmd)$/i.test(target))) {
        // Start-Menu shortcuts, batch files, and any program taking launch
        // parameters need ShellExecute semantics: cmd's `start ""` resolves
        // them exactly like a double-click and forwards the arguments.
        return launchDetached('cmd.exe', ['/d', '/s', '/c', 'start', '""', target, ...tokens], target);
      }
      if (exists) {
        const err = await shell.openPath(target);
        if (err) throw new Error(err || `could not open '${target}'`);
        return;
      }
      const cmd = target.match(/^([^\s]+\.exe(?:\.com)?|"[^"]+")\s*(.*)$/i);
      if (cmd) {
        const exe = cmd[1].replace(/^"|"$/g, '');
        return launchDetached(exe, tokens.concat(splitArgs(cmd[2] || '')), value);
      }
      // last resort: shell resolution (e.g. "notepad", "ms-...", store links) —
      // the raw args string rides along so cmd.exe still sees the quotes as typed.
      return launchDetached(tokens.length ? target + ' ' + rawArgs : target, [], value, { shell: true });
    }
    case 'command': {
      if (!value) throw new Error('no command configured');
      // A value that is actually a script file needs double-click semantics, not
      // a raw cmd /c of the path — cmd's quote handling breaks paths with spaces.
      const script = value.replace(/^"(.+)"$/g, '$1');
      let exists = false;
      try { exists = fs.existsSync(script); } catch {}
      if (exists && /\.(bat|cmd)$/i.test(script)) {
        const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', script],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return;
      }
      if (exists && /\.ps1$/i.test(script)) {
        // Same `start ""` route as the batch files: powershell.exe spawned
        // directly with detached:true silently never runs (verified on real
        // machines); through cmd's ShellExecute it launches reliably.
        const child = spawn('cmd.exe',
          ['/d', '/s', '/c', 'start', '""', 'powershell.exe',
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script],
          { detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
        return;
      }
      await runShellCommand(value);
      return;
    }
    case 'macro': {
      await macro.sendMacro(value);
      return;
    }
    case 'sys': {
      await sys.run(value, ctx, { dir: String(item.dir || '').trim() });
      return;
    }
    default:
      throw new Error(`unknown action type '${type}'`);
  }
}

module.exports = { executeAction };
