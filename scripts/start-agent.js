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
  console.log(`[start-agent] ${notes.join(' + ')}`);
  console.log(`[start-agent] profile config: ${seed}`);
  console.log(`[start-agent] ${path.basename(bin)} ${args.join(' ')}`);

  const child = spawn(bin, args, { cwd: ROOT, env, stdio: 'inherit' });
  child.on('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
  child.on('error', (e) => {
    console.error(`[start-agent] failed to launch Electron: ${e.message}`);
    process.exit(1);
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  if (stripped) console.log('[start-agent] note: this shell injects ELECTRON_RUN_AS_NODE; plain `electron .` here runs as Node.');
}

module.exports = { buildLaunch, seedProfile, AGENT_PROFILE, RUN_AS_NODE };

if (require.main === module) main();
