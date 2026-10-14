'use strict';
/* Action dispatch: runs wheel items of every type and reports failures. */
const fs = require('fs');
const { shell } = require('electron');
const { spawn } = require('child_process');
const macro = require('./macro');
const sys = require('./sys');
const winplace = require('./winplace');
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
 *
 * shell:true is DELIBERATE here and only here: a `command` segment's value is
 * the user's own command line (Run-dialog semantics — pipes, &&, redirection
 * are the point of the type). Every other exec path in this file goes through
 * launchDetached. Paths that need ShellExecute go through startViaCmd, which
 * quotes each token so cmd cannot re-parse `&` or `%`. Do NOT route anything
 * into this function that the user did not type themselves (config import
 * passes it through the same string, exactly like editing config.json by
 * hand — the trusted-input contract of the store).
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
 * Scheme guard for the `url` action: anything that is not an explicitly
 * allowed scheme gets `https://` prepended — so a bare host still works, and
 * hostile shapes (`file://C:\evil\path.exe`, custom protocol handlers) can
 * never reach shell.openExternal as written. The old filter accepted any
 * RFC-shaped scheme; this is a real allowlist. mailto: is listed because it
 * lacks the `://` form and would otherwise be mangled by the default — pages
 * opened by other schemes belong to the sys action's ms-settings targets.
 */
/* One argv element for `cmd /c`. Node only quotes space and `"`, so a raw
   `C:\A&B\app.exe` is pasted into the command line and cmd splits on `&`.
   Always wrap. Internal quotes are doubled (cmd's own escape). Each `%` is
   a quote-break `"%"`: percent-expansion runs even inside quotes and could
   otherwise insert a `"` that ends the token early. CR/LF would open a
   second command on the same `/c` line. */
function quoteCmdArg(arg) {
  const s = String(arg);
  if (/[\r\n]/.test(s)) throw new Error('launch argument contains a newline');
  let out = '"';
  for (const ch of s) {
    if (ch === '"') out += '""';
    else if (ch === '%') out += '"%"';
    else out += ch;
  }
  return out + '"';
}

/* `start "" <file> <args…>` as a single `/c` string. windowsVerbatimArguments
   is required: Node would otherwise wrap this string in another pair of
   quotes and undo the escaping. The command does not itself start with a
   quote, so cmd's `/s` will not strip the token quotes. */
function startCommand(target, tokens) {
  return ['start', '""', quoteCmdArg(target), ...(tokens || []).map(quoteCmdArg)].join(' ');
}

function startViaCmd(target, tokens, label) {
  return launchDetached(
    'cmd.exe',
    ['/d', '/s', '/c', startCommand(target, tokens)],
    label || target,
    { windowsVerbatimArguments: true }
  );
}

function safeExternalUrl(value) {
  const raw = String(value).trim();
  /* `https?:` alone is not enough: `https:file://…` matches that prefix and
     ShellExecute does not parse it the way the WHATWG URL parser does.
     Require `://` (mailto has none) and confirm the parsed protocol. */
  const candidate = /^(https?:\/\/|mailto:)/i.test(raw) ? raw : 'https://' + raw;
  try {
    const u = new URL(candidate);
    if (u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'mailto:') return candidate;
  } catch { /* not a URL we will hand to the shell */ }
  return 'https://invalid.invalid/';
}

/**
 * Pure basename extraction for the focus-existing-app check: which running
 * program (if any) an `app` item's value actually names. Only a `.exe`
 * basename can be matched against a window's process, so everything else
 * answers null and launches exactly as before — .lnk/.bat/.cmd (ShellExecute
 * targets whose real exe is one step away), ms-settings:/store links, bare
 * shell words without an extension, and URLs.
 * Handles all three shapes the app branch accepts: `C:\dir\app.exe`,
 * `C:\dir\app.exe /flag`, and `"C:\Program Files\app.exe" --flag args`.
 */
function exeBaseForAppValue(value) {
  const s = String(value || '').trim();
  if (!s) return null;
  let exe = null;
  const q = s.match(/^"([^"]+)"/);                                   // quoted exe first (may contain spaces)
  if (q) exe = q[1];
  else {
    const m = s.match(/^(.+?\.(?:exe))(?:\s|$)/i);                   // unquoted exe, optional inline args
    if (m) exe = m[1];
  }
  if (!exe) return null;
  const base = exe.split(/[\\/]/).pop().toLowerCase();
  return base.endsWith('.exe') && base.length > 4 ? base : null;
}

/**
 * Execute one configured item. Throws Error with a user-readable message on failure.
 * ctx: { quit?: () => void, focusExistingApp?: boolean }
 */
async function executeAction(item, ctx = {}) {
  if (!item || typeof item !== 'object') throw new Error('invalid item');
  const type = String(item.type || 'app').toLowerCase();
  const value = String(item.value || '').trim();

  switch (type) {
    case 'url': {
      if (!value) throw new Error('no URL configured');
      winplace.beginWatch(ctx);   // no-op unless behavior.appOpenPosition says otherwise
      const err = await shell.openExternal(safeExternalUrl(value));
      if (err) throw new Error(err);
      return;
    }
    case 'file': {
      if (!value) throw new Error('no file configured');
      winplace.beginWatch(ctx);
      const err = await shell.openPath(value);
      if (err) throw new Error(err === '' ? 'could not open file' : err);
      return;
    }
    case 'app': {
      if (!value) throw new Error('no program configured');
      /* Focus-existing-app (behavior.focusExistingApp, opt-in): when the named
         program already owns a visible window, raise it instead of spawning a
         second instance. false covers every "not open / can't tell" case —
         not running, running windowless, FFI absent, focus refused — and the
         launch below then proceeds exactly as it always did. */
      if (ctx.focusExistingApp === true) {
        const base = exeBaseForAppValue(value);
        if (base && macro.focusAppWindowByExe(base)) return;
      }
      // Arm AFTER the focus-existing check: raising a window that already
      // exists is not an "opening", so placement never chases it.
      winplace.beginWatch(ctx);
      const target = value.replace(/^"|"$/g, '');
      const rawArgs = String(item.args || '').trim();
      const tokens = splitArgs(rawArgs);
      let exists = false;
      try { exists = fs.existsSync(target); } catch {}
      if (exists && (tokens.length || /\.(lnk|bat|cmd)$/i.test(target))) {
        // Start-Menu shortcuts, batch files, and any program taking launch
        // parameters need ShellExecute semantics: cmd's `start ""` resolves
        // them exactly like a double-click and forwards the arguments.
        return startViaCmd(target, tokens, target);
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
      // Not a file on disk (notepad, ms-settings, a store link). `start` resolves
      // PATH, App Paths, and protocol handlers. This stays off Node's shell:true;
      // a free-form shell line belongs to a command segment.
      return startViaCmd(target, tokens, target);
    }
    case 'command': {
      if (!value) throw new Error('no command configured');
      // A value that is actually a script file needs double-click semantics, not
      // a raw cmd /c of the path — cmd's quote handling breaks paths with spaces.
      const script = value.replace(/^"(.+)"$/g, '$1');
      let exists = false;
      try { exists = fs.existsSync(script); } catch {}
      if (exists && /\.(bat|cmd)$/i.test(script)) {
        return startViaCmd(script, [], script);
      }
      if (exists && /\.ps1$/i.test(script)) {
        // Same `start ""` route as the batch files: powershell.exe spawned
        // directly with detached:true silently never runs (verified on real
        // machines); through cmd's ShellExecute it launches reliably.
        // No -ExecutionPolicy Bypass — the script runs under the machine policy.
        return startViaCmd('powershell.exe', ['-NoProfile', '-File', script], script);
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
    case 'setting': {
      // App-setting toggle (src/main/appsettings.js owns the catalog). The
      // mutator rides on ctx so this module never touches the config store
      // directly — ipc.js hands it the live store plus the Settings-window
      // echo, and a call path without that hook fails closed.
      if (!value) throw new Error('no setting configured');
      if (typeof ctx.applySetting !== 'function') throw new Error('app settings are unavailable here');
      await ctx.applySetting(value);
      return;
    }
    case 'folder':
      // Folder segments are sub-menu containers, never executable — and the
      // wheel renderer shouldn't send them either. Loudly refuse (defense in
      // depth behind the recursive live-config match in ipc.js).
      throw new Error('a folder segment cannot be launched');
    case 'recent':
      // Same discipline: a recent segment's fan is resolved in main from
      // usage data at summon time; the container itself executes nothing
      // (clicks on its children carry the real items' ids).
      throw new Error('a recent segment cannot be launched');
    case 'mixer':
      // The volume-mixer segment never executes: the overlay intercepts its
      // click locally and opens the in-wheel volume panel (wheel.js). Loudly
      // refuse anything that still routes here (defense in depth).
      throw new Error('a volume mixer segment cannot be launched');
    default:
      throw new Error(`unknown action type '${type}'`);
  }
}

module.exports = { executeAction, safeExternalUrl, exeBaseForAppValue, quoteCmdArg, startCommand };
