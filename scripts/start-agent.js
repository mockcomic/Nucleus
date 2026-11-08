#!/usr/bin/env node
'use strict';

/* Launcher for shells where plain `npm start` cannot boot Electron.
   ----------------------------------------------------------------
   Two separate walls, both from the calling shell's environment, not from
   this app:

   1. ELECTRON_RUN_AS_NODE=1 in the shell env makes electron.exe behave as
      plain Node, so `require('electron')` hands back the binary *path string*
      instead of the API and main.js dies at the single-instance call with
      "Cannot read properties of undefined (reading 'requestSingleInstanceLock')".
      -> the variable is deleted from the child env here.

   2. A confined/restricted shell token cannot open Chromium's sandbox, so the
      browser process aborts with STATUS_BREAKPOINT (0x80000003) before the app
      entry file ever runs, and it cannot write the singleton lock + caches
      outside the workspace, so requestSingleInstanceLock() returns false and
      the app quits silently (exit 0, no "ready" marker).
      -> --no-sandbox, plus an isolated --user-data-dir inside the repo.

   The isolated profile also keeps a dev run off the real
   %APPDATA%\Nucleus\ files. First-run seeding forces
   behavior.autostart=false so the dev profile does not record a startup
   preference. An unpackaged exe is not an installed copy, so main.js will
   not register a login item for electron.exe either.

   Usage: npm run start:agent [-- --show-wheel]
   Normal desktop runs still use `npm start`.
*/

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const AGENT_PROFILE = path.join(ROOT, '.dev-userdata');
const REAL_PROFILE = process.env.APPDATA ? path.join(process.env.APPDATA, 'Nucleus') : null;
/* Pre-rename profile (the product was "Radial Wheel") — a dev seed falls back
   to it when the new profile has no config yet, mirroring src/main/migrate.js. */
const LEGACY_PROFILE = process.env.APPDATA ? path.join(process.env.APPDATA, 'Radial Wheel') : null;
const RUN_AS_NODE = 'ELECTRON_RUN_AS_NODE';

function hasFlag(argv, flag) {
  return argv.some((a) => a === flag || a.startsWith(flag + '=') || a.startsWith(flag + ':'));
}

/* Pure: builds the child env + argv so the two walls stay covered by a test. */
function buildLaunch(env, extraArgs = [], opts = {}) {
  const childEnv = { ...env };
  const stripped = Object.prototype.hasOwnProperty.call(childEnv, RUN_AS_NODE);
  delete childEnv[RUN_AS_NODE];

  const extra = [...extraArgs];
  const args = [opts.appPath || '.', ...extra];
  const notes = [];
  if (stripped) notes.push(`stripped ${RUN_AS_NODE}`);

  if (!hasFlag(extra, '--no-sandbox')) {
    args.push('--no-sandbox');
    notes.push('--no-sandbox added');
  }
  const userDataDir = opts.userDataDir || AGENT_PROFILE;
  if (!hasFlag(extra, '--user-data-dir')) {
    args.push(`--user-data-dir=${userDataDir}`);
    notes.push(`profile ${userDataDir}`);
  }
  /* Visible launch: main.js opens the wheel shortly after boot when the argv
     carries --show-wheel (first- AND second-instance), so a dev run shows
     itself instead of quietly joining the tray. A caller asking for --hidden
     (or passing --show-wheel themselves) opts out of the default. Without
     this, a dev instance whose hotkey lost to an installed copy looks
     exactly like a launch that never happened. */
  if (!hasFlag(extra, '--show-wheel') && !hasFlag(extra, '--hidden')) {
    args.push('--show-wheel');
    notes.push('--show-wheel added (visible launch)');
  }
  return { env: childEnv, args, stripped, notes };
}

/* Creates the isolated profile's config.json so Electron's first-run path does
   not register a dev-tree login item. Existing files are left untouched — the
   config watcher hot-reloads them, so dev edits persist across runs. */
function seedProfile(agentDir = AGENT_PROFILE, realDir = REAL_PROFILE, legacyDir = LEGACY_PROFILE) {
  const cfg = path.join(agentDir, 'config.json');
  if (fs.existsSync(cfg)) return 'kept';
  fs.mkdirSync(agentDir, { recursive: true });

  const dirs = [realDir, legacyDir].filter(Boolean);
  const src = dirs.map((d) => path.join(d, 'config.json')).find((p) => fs.existsSync(p)) || null;
  if (src && fs.existsSync(src)) {
    try {
      const copied = JSON.parse(fs.readFileSync(src, 'utf8'));
      copied.behavior = { ...(copied.behavior || {}), autostart: false };
      fs.writeFileSync(cfg, JSON.stringify(copied, null, 2));
      return 'copied from live config (autostart off)';
    } catch { /* unreadable live config -> fall back to a minimal seed */ }
  }
  fs.writeFileSync(cfg, JSON.stringify({ version: 2, behavior: { autostart: false } }, null, 2));
  return 'seeded defaults (autostart off)';
}

/* Advisory, best-effort: an installed Nucleus running side by side owns the
   wheel hotkey and shows an identical tray icon — the classic reason a dev
   run "doesn't appear". Read-only tasklist probe; silence on any failure. */
function warnInstalledCopy() {
  try {
    const { execFileSync } = require('child_process');
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Nucleus.exe', '/NH'],
      { encoding: 'utf8', windowsHide: true });
    if (/Nucleus\.exe/i.test(out)) {
      console.log('[start-agent] note: an installed Nucleus is running — it owns the wheel hotkey');
      console.log('[start-agent]   and its tray icon is identical. Quit it to feel the dev build');
      console.log('[start-agent]   (the dev wheel opens on start anyway, via --show-wheel).');
    }
  } catch { /* advisory only */ }
}

/* Last lines of the dev-profile log — what a fast death actually said. */
function devLogTail(lines = 8) {
  try {
    const dir = path.join(AGENT_PROFILE, 'logs');
    const names = fs.readdirSync(dir).filter((n) => /^(?:nucleus|radial-wheel)-\d{4}-\d{2}-\d{2}\.log$/.test(n)).sort();
    const last = names[names.length - 1];
    if (!last) return '';
    return fs.readFileSync(path.join(dir, last), 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch { return ''; }
}

function main() {
  const { spawn } = require('child_process');
  const bin = require('electron');
  if (typeof bin !== 'string') {
    console.error('[start-agent] must run under plain node, not inside Electron.');
    process.exit(1);
  }
  if (!fs.existsSync(bin)) {
    console.error(`[start-agent] Electron binary not found at ${bin} — run npm install first.`);
    process.exit(1);
  }

  const { env, args, stripped, notes } = buildLaunch(process.env, process.argv.slice(2));
  const seed = seedProfile();
  warnInstalledCopy();
  console.log(`[start-agent] ${notes.join(' + ')}`);
  console.log(`[start-agent] profile config: ${seed}`);
  console.log(`[start-agent] ${path.basename(bin)} ${args.join(' ')}`);

  const t0 = Date.now();
  /* Ctrl+C (or a killed terminal) must not look like a failure: on Windows a
     signaled child reports exit code 1 via TerminateProcess, so record that
     the death was OUR doing — report success and skip the fast-death
     diagnostic for a deliberate early interrupt. */
  let shuttingDown = false;
  const child = spawn(bin, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (shuttingDown) process.exit(0);
    /* Anything that dies in under ~3s never became a real session: an app the
       user quit lives at least until they quit it. Show the log tail so a
       "didn't launch" is never a silent one (locked-out second instance,
       confined-shell wall, corrupted profile — they all read differently). */
    if (!signal && Date.now() - t0 < 3000) {
      console.error(`[start-agent] Electron exited after ${Date.now() - t0} ms (code ${code ?? 'null'}) — this was not a normal session.`);
      const tail = devLogTail();
      console.error(tail ? `[start-agent] last dev-profile log lines:\n${tail}` :
        '[start-agent] no dev-profile log line was written — the process died before app logging started (confined shell? see the two walls at the top of this file).');
      console.error(`[start-agent] dev profile: ${AGENT_PROFILE} — an earlier dev instance may already own its lock.`);
    }
    process.exit(signal ? 1 : (code ?? 0));
  });
  child.on('error', (e) => {
    console.error(`[start-agent] failed to launch Electron: ${e.message}`);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { shuttingDown = true; try { child.kill(sig); } catch { /* already gone */ } });
  }
  if (stripped) console.log('[start-agent] note: this shell injects ELECTRON_RUN_AS_NODE; plain `electron .` here runs as Node.');
}

module.exports = { buildLaunch, seedProfile, AGENT_PROFILE, RUN_AS_NODE };

if (require.main === module) main();
