'use strict';
/* Unit tests for scripts/start-agent.js — the confined-shell launcher.
   Covers the two walls it exists to clear: the inherited ELECTRON_RUN_AS_NODE
   variable, and the missing sandbox/profile flags. Pure functions only: no
   Electron, no spawning, no writes outside a temp dir. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildLaunch, seedProfile } = require('../../scripts/start-agent');

test('buildLaunch: strips an inherited ELECTRON_RUN_AS_NODE from the child env', () => {
  const { env, stripped } = buildLaunch({ ELECTRON_RUN_AS_NODE: '1', PATH: 'x' }, []);
  assert.equal(stripped, true);
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
  assert.equal(env.PATH, 'x', 'other variables survive');
});

test('buildLaunch: absence is reported, not invented', () => {
  const { env, stripped } = buildLaunch({ PATH: 'x' }, []);
  assert.equal(stripped, false);
  assert.equal('ELECTRON_RUN_AS_NODE' in env, false);
});

test('buildLaunch: adds the sandbox escape and an isolated profile by default', () => {
  const { args, notes } = buildLaunch({}, [], { userDataDir: 'C:\\repo\\.dev-userdata' });
  assert.equal(args[0], '.', 'app path leads');
  assert.ok(args.includes('--no-sandbox'));
  assert.ok(args.includes('--user-data-dir=C:\\repo\\.dev-userdata'));
  assert.equal(notes.length, 2);
});

test('buildLaunch: extra app args are kept and precede the injected switches', () => {
  const { args } = buildLaunch({}, ['--show-wheel', '--hidden'], {});
  assert.deepEqual(args, ['.', '--show-wheel', '--hidden', '--no-sandbox', `--user-data-dir=${path.join(__dirname, '..', '..', '.dev-userdata')}`]);
});

test('buildLaunch: a caller-supplied flag wins — never doubled', () => {
  const own = buildLaunch({}, ['--no-sandbox', '--user-data-dir=D:\\other'], {});
  assert.equal(own.args.filter((a) => a === '--no-sandbox').length, 1);
  assert.equal(own.args.filter((a) => a.startsWith('--user-data-dir')).length, 1);
  assert.ok(own.args.includes('--user-data-dir=D:\\other'));
  assert.deepEqual(own.notes, []);
});

test('buildLaunch: does not mutate the caller env object', () => {
  const env = { ELECTRON_RUN_AS_NODE: '1' };
  buildLaunch(env, [], {});
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1');
});

test('seedProfile: copies the live config with autostart forced off', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-agent-'));
  try {
    const agent = path.join(dir, 'agent');
    const real = path.join(dir, 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'config.json'),
      JSON.stringify({ version: 2, hotkey: 'ctrl+alt+space', behavior: { autostart: true }, rings: { 1: [{ label: 'x' }], 2: [] } }));

    const how = seedProfile(agent, real);
    assert.match(how, /copied/);
    const cfg = JSON.parse(fs.readFileSync(path.join(agent, 'config.json'), 'utf8'));
    assert.equal(cfg.behavior.autostart, false, 'a dev run must not register a node_modules login item');
    assert.equal(cfg.hotkey, 'ctrl+alt+space');
    assert.equal(cfg.rings['1'].length, 1, 'the wheel comes along for the ride');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seedProfile: falls back to a minimal autostart-off seed without a live config', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-agent-'));
  try {
    const agent = path.join(dir, 'agent');
    const how = seedProfile(agent, path.join(dir, 'missing'), path.join(dir, 'missing-legacy'));
    assert.match(how, /seeded/);
    const cfg = JSON.parse(fs.readFileSync(path.join(agent, 'config.json'), 'utf8'));
    assert.equal(cfg.behavior.autostart, false);
    assert.equal(cfg.version, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seedProfile: an existing dev config is left alone', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-agent-'));
  try {
    const agent = path.join(dir, 'agent');
    fs.mkdirSync(agent, { recursive: true });
    fs.writeFileSync(path.join(agent, 'config.json'), '{"keep":"me"}');
    assert.equal(seedProfile(agent, null), 'kept');
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent, 'config.json'), 'utf8')).keep, 'me');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('seedProfile: a corrupt live config degrades to the minimal seed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rw-agent-'));
  try {
    const agent = path.join(dir, 'agent');
    const real = path.join(dir, 'real');
    fs.mkdirSync(real, { recursive: true });
    fs.writeFileSync(path.join(real, 'config.json'), '{not json');
    assert.match(seedProfile(agent, real), /seeded/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent, 'config.json'), 'utf8')).behavior.autostart, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
