/* Injects a deterministic 'command' test item into the live config (the app's
   file-watch hot-reload picks it up), so a pixel-precise click can prove the
   click -> IPC -> execute chain. Usage: node tests/click-at.js prepare|click */
const fs = require('fs');
const path = require('path');
const os = require('os');

// Which profile to inject into: the running app must be reading this file.
// Default is the real app profile (falls back to the pre-rename Radial Wheel
// profile when Nucleus has no config yet); set NUCLEUS_CONFIG (or the legacy
// RADIAL_WHEEL_CONFIG) to point at an isolated dev profile
// (e.g. .dev-userdata/config.json for start:agent runs).
const CFG = process.env.NUCLEUS_CONFIG || process.env.RADIAL_WHEEL_CONFIG
  ? path.resolve(process.env.NUCLEUS_CONFIG || process.env.RADIAL_WHEEL_CONFIG)
  : pickProfile();
const PROOF = path.join(__dirname, '..', '.cache', 'click-proof.txt');

function pickProfile() {
  const now = path.join(process.env.APPDATA, 'Nucleus', 'config.json');
  if (fs.existsSync(now)) return now;
  return path.join(process.env.APPDATA, 'Radial Wheel', 'config.json');
}

if (process.argv[2] === 'prepare') {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cfg.rings['1'] = (cfg.rings['1'] || []).filter((it) => it.label !== 'ZZTEST');
  cfg.rings['1'].push({
    id: 'zz-test', label: 'ZZTEST', icon: '', type: 'command',
    value: `cmd /c echo proofed > "${PROOF}"`, color: null
  });
  try { fs.unlinkSync(PROOF); } catch {}
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  const n = cfg.rings['1'].length;
  // with n items the new (last) item is centred at startAngle + (n-1)*step
  const step = 360 / n;
  const center = (cfg.appearance.startAngle + (n - 1) * step + 360) % 360;
  const mid = cfg.appearance.innerRadius + (cfg.appearance.outerRadius - cfg.appearance.innerRadius) * (cfg.rings['2'] && cfg.rings['2'].length ? cfg.appearance.ringSplit : 1);
  const rm = (cfg.appearance.innerRadius + mid) / 2;
  const a = (center - 90) * Math.PI / 180;
  console.log(JSON.stringify({ n, clickAngleDeg: center, r: rm, dx: Math.cos(a) * rm, dy: Math.sin(a) * rm, proof: PROOF }));
} else if (process.argv[2] === 'click') {
  const koffi = require('koffi');
  const u = koffi.load('user32.dll');
  const SI = u.func('uint32 __stdcall SendInput(uint32 n, void* p, int32 cb)');
  const mk = (flags) => { const b = Buffer.alloc(40); b.writeUInt32LE(0, 0); b.writeUInt32LE(flags, 20); return b; };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  (async () => {
    if (SI(1, mk(0x0002), 40) !== 1) throw new Error('mouse down rejected');
    await sleep(60);
    if (SI(1, mk(0x0004), 40) !== 1) throw new Error('mouse up rejected');
    console.log('clicked at current cursor position');
  })().catch((e) => { console.error(e.message); process.exit(1); });
} else if (process.argv[2] === 'prepare-app') {
  const { listApps } = require('../src/main/apps.js');
  listApps().then((items) => {
    const want = (process.argv[3] || 'notepad').toLowerCase();
    const pick = items.find((i) => i.name.toLowerCase() === want)
      || items.find((i) => i.name.toLowerCase().includes(want)) || items[0];
    if (!pick) { console.error('no installed apps found'); process.exit(1); }
    const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    cfg.rings['1'] = (cfg.rings['1'] || []).filter((it) => it.label !== 'ZZTEST');
    cfg.rings['1'].push({ id: 'zz-test', label: 'ZZTEST', icon: '', type: 'app', value: pick.path, color: null });
    fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
    const n = cfg.rings['1'].length;
    const step = 360 / n;
    const center = (cfg.appearance.startAngle + (n - 1) * step + 360) % 360;
    const mid = cfg.appearance.innerRadius + (cfg.appearance.outerRadius - cfg.appearance.innerRadius) * (cfg.rings['2'] && cfg.rings['2'].length ? cfg.appearance.ringSplit : 1);
    const rm = (cfg.appearance.innerRadius + mid) / 2;
    const a = (center - 90) * Math.PI / 180;
    console.log(JSON.stringify({ n, picked: pick.name, path: pick.path, clickAngleDeg: center, r: rm, dx: Math.cos(a) * rm, dy: Math.sin(a) * rm }));
  });
} else if (process.argv[2] === 'cleanup') {
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  cfg.rings['1'] = (cfg.rings['1'] || []).filter((it) => it.label !== 'ZZTEST');
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  try { fs.unlinkSync(PROOF); } catch {}
  console.log('cleaned');
}
