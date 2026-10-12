'use strict';
/* Welcome (FTU) window controller. Four steps, live hotkey recording through
   the existing hotkey:set IPC, and a real-wheel test through overlay:show —
   every exit path calls welcome:done so the first-run guide never haunts
   anyone twice, while tray → "Show welcome…" remains the replay door.
   The chrome (window skin) is derived from the ACTIVE THEME, mirroring
   settings.js applyChrome so both windows always look like the same product. */
import { computeChrome, chromeVarMap, paletteMode, themeById, themeBySignature, signature }
  from '../../main/themes.mjs';
import { keyEventToSpec, mouseEventToSpec, formatSpec, nextStep } from './welcome-core.mjs';

const api = window.welcomeAPI;
const $ = (id) => document.getElementById(id);
const STEPS = ['step-0', 'step-1', 'step-2', 'step-3'];
const LAST = STEPS.length - 1;

let cfg = null;      // last full config we saw
let info = null;     // welcome:info payload
let step = 0;
let recording = false;

/* ── chrome: same merge settings.js does (theme palette + live swatches) ── */
function activeTheme(c) {
  const id = c.theme && c.theme.id;
  if (id) {
    const user = (c.userThemes || []).find((t) => t.id === id);
    if (user) return { id: user.id, colors: user.colors };
    const cat = themeById(id);
    if (cat) return { id: cat.id, colors: cat.colors };
  }
  const bySig = themeBySignature(signature(c.appearance.colors));
  return bySig ? { id: bySig.id, colors: bySig.colors } : { id: null, colors: c.appearance.colors };
}

function applyChrome() {
  if (!cfg) return;
  const a = activeTheme(cfg);
  const pal = a.id
    ? Object.assign({}, a.colors, cfg.appearance.colors,
      { mode: cfg.appearance.colors.mode || a.colors.mode })
    : cfg.appearance.colors;
  const root = document.documentElement;
  root.dataset.mode = paletteMode(pal);
  root.style.colorScheme = root.dataset.mode;
  for (const [k, v] of Object.entries(chromeVarMap(computeChrome(pal)))) root.style.setProperty(k, v);
}

/* ── hotkey display ── */
function setHotkeyChips(spec) {
  $('hk-hero').textContent = formatSpec(spec);
  $('hk-display').textContent = formatSpec(spec);
}
function setHotkeyError(msg) {
  const e = $('hk-error');
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}
function setStatus(msg, kind) {
  const s = $('hk-status');
  s.textContent = msg || '';
  s.className = 'status muted' + (kind ? ' ' + kind : '');
}

/* ── recorder ── */
function startCapture() {
  recording = true;
  $('rec-btn').textContent = 'Listening…';
  $('hk-display').classList.add('recording');
  setHotkeyError(null);
  setStatus('Press Ctrl, Alt, Shift, or Win plus a key. Or click Middle, Back, or Forward. Esc cancels.', '');
}
function stopCapture() {
  recording = false;
  $('rec-btn').textContent = 'Change…';
  $('hk-display').classList.remove('recording');
}

async function commitSpec(spec) {
  stopCapture();
  const res = await api.setHotkey(spec);   // registers + persists + restores old on failure, main-side
  if (res && res.ok) {
    if (cfg) cfg.hotkey = spec;
    setHotkeyChips(spec);
    setHotkeyError(null);
    setStatus('Registered — press it now, then hit “Try the wheel”.', 'ok');
  } else {
    setStatus('', '');
    setHotkeyError((res && res.error) || 'Could not register that combo — your old hotkey is still active.');
  }
}

/* ── steps ── */
function render() {
  STEPS.forEach((id, i) => $(id).classList.toggle('hidden', i !== step));
  $('back-btn').disabled = step === 0;
  $('next-btn').classList.toggle('hidden', step === LAST);
  for (const d of $('dots').children) {
    const i = Number(d.dataset.i);
    d.setAttribute('aria-selected', String(i === step));
    d.tabIndex = i === step ? 0 : -1;
  }
  const focusTarget = step === LAST ? $('go-settings') : $('next-btn');
  if (focusTarget) focusTarget.focus();
}
function go(next) {
  step = nextStep(next, step, STEPS.length);
  render();
}

/* ── keyboard ── */
window.addEventListener('keydown', async (e) => {
  if (recording) {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { stopCapture(); setStatus('', ''); return; }
    const spec = keyEventToSpec(e);
    if (!spec) {
      const bare = /^(control|alt|shift|meta|os)$/i.test(e.key);
      setStatus(bare ? '…plus a key.' : 'That key can\u2019t start a combo — try letters, digits, F-keys.', '');
      return;
    }
    await commitSpec(spec);
    return;
  }
  if (e.key === 'Escape') { finish(false); return; }
  // Enter finishes on the last step, unless a button has focus (it handles its own Enter)
  if (e.key === 'Enter' && step === LAST && !(document.activeElement instanceof HTMLButtonElement)) {
    finish(true);
  }
}, true);

/* ── mouse ──
   Middle / Back / Forward (alone or with modifiers) while listening. Left and
   right presses are ignored, so the "Change…" button still cancels. */
window.addEventListener('mousedown', async (e) => {
  if (!recording) return;
  const t = e.target;
  if (t && t.closest && t.closest('#rec-btn')) return;
  e.preventDefault(); e.stopPropagation();
  if (e.button === 0 || e.button === 2) return;
  const spec = mouseEventToSpec(e);
  if (!spec) { setStatus('Use the Middle, Back or Forward button.', ''); return; }
  await commitSpec(spec);
}, true);

window.addEventListener('contextmenu', (e) => {
  if (!recording) return;
  e.preventDefault(); e.stopPropagation();
}, true);

/* ── wiring ── */
function buildDots() {
  const dots = $('dots');
  STEPS.forEach((_, i) => {
    const d = document.createElement('button');
    d.className = 'dot'; d.dataset.i = String(i);
    d.setAttribute('role', 'tab');
    d.setAttribute('aria-label', `Step ${i + 1} of ${STEPS.length}`);
    d.addEventListener('click', () => go(i - step));
    dots.appendChild(d);
  });
}

/* Arrow keys move through the step dots like the settings tablist does.
   render() hands focus to the primary button after any step change — we take
   it back to the newly selected dot so the user can keep walking. */
$('dots').addEventListener('keydown', (e) => {
  const t = e.target;
  if (!t.classList || !t.classList.contains('dot')) return;
  const i = Number(t.dataset.i);
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); go(i + 1 - step); }
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); go(i - 1 - step); }
  else return;
  const kids = $('dots').children;
  if (kids[step]) kids[step].focus();
});

$('rec-btn').addEventListener('click', () => { recording ? stopCapture() : startCapture(); });
$('test-btn').addEventListener('click', () => api.testWheel());
$('back-btn').addEventListener('click', () => go(-1));
$('next-btn').addEventListener('click', () => go(1));
/* First completion only. The last step's checkbox is the opt-in; leaving
   earlier (Esc, close, or Done from a previous step) writes startup off so a
   dismissed guide never registers a login item the user did not see. Replays
   send null and main leaves the registry alone. */
function finish(openSettings) {
  const first = !info || !info.ftuSeen;
  let applyAutostart = null;
  if (first) {
    const row = $('autostart-row');
    const box = $('welcome-autostart');
    const onLast = step === LAST && info.autostartAllowed && row && !row.classList.contains('hidden');
    applyAutostart = onLast && box ? !!box.checked : false;
  }
  api.finish({ openSettings: !!openSettings, applyAutostart });
}

$('go-settings').addEventListener('click', () => finish(true));
$('go-done').addEventListener('click', () => finish(false));
$('tb-close').addEventListener('click', () => finish(false));

/* Tray → “Show welcome…” reuses this page without reloading it, so main asks us
   to walk back before showing — a finished guide must not replay on step 4. */
if (api.onReset) api.onReset(() => {
  stopCapture();
  setHotkeyError(null);
  setStatus('', '');
  step = 0;
  // Replays are never the first completion — hide the startup opt-in so Done
  // cannot send a new choice. main also ignores it once ftuSeen is set.
  if (info) info.ftuSeen = true;
  const row = $('autostart-row');
  if (row) row.classList.add('hidden');
  render();
  if (cfg) setHotkeyChips(cfg.hotkey);
});

api.onConfigChanged((payload) => {
  if (!payload || !payload.config) return;
  cfg = payload.config;
  applyChrome();
  if (!recording) setHotkeyChips(cfg.hotkey);
});

/* ── boot ── */
(async function init() {
  buildDots();
  const [g, i] = await Promise.all([api.getConfig(), api.info()]);
  cfg = g.config;
  info = i;
  applyChrome();
  setHotkeyChips(info.hotkey);
  $('ver').textContent = 'v' + info.version;
  if (info.importedFrom) {
    const n = $('import-note');
    n.textContent = 'Your segments were imported from an older config — open Settings → Segments to see what came over.';
    n.classList.remove('hidden');
  }
  if (info.hotkeyError) setHotkeyError(info.hotkeyError);
  const row = $('autostart-row');
  if (row) row.classList.toggle('hidden', !(info && !info.ftuSeen && info.autostartAllowed));
  const box = $('welcome-autostart');
  if (box) box.checked = true;
  render();
})();
