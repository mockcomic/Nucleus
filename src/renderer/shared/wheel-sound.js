/* Sound feedback for the wheel overlay: soft synthesized ticks on hover and
   select, generated on the fly with Web Audio (no asset files, no network).

   DOM-free on purpose — createWheelSound takes the AudioContext constructor
   as an option so the unit tests run against a stub with no Web Audio at all.

   Fail-soft doctrine (same as the mouse hook): if the AudioContext cannot be
   created, is not allowed to start (autoplay policy), or throws mid-play,
   the tick is silently dropped — audio must NEVER break the wheel. */

/* One tick voice = oscillator shape + frequency (Hz) + envelope length (s)
   + peak gain. Kept deliberately quiet: this fires under the user's cursor
   while they work, not as an alert. */
export const TICKS = {
  hover: { type: 'sine', freq: 720, dur: 0.03, gain: 0.035 },
  fire:  { type: 'sine', freq: 1040, dur: 0.07, gain: 0.05 }
};

/* Schedule one tick on `ctx`; returns true when the voice was created.
   Any throw (disposed ctx, policy block) collapses to false. */
function playTick(ctx, name) {
  const spec = TICKS[name];
  if (!spec || !ctx) return false;
  try {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = spec.type;
    osc.frequency.value = spec.freq;
    const t = ctx.currentTime;
    // short attack, exponential decay to (near) silence: a "tick", not a beep
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(spec.gain, t + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + spec.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + spec.dur + 0.02);
    return true;
  } catch {
    return false;
  }
}

/* Factory used by the overlay.
   options.AudioContext — injectable constructor (tests pass a fake);
   defaults to the global Web Audio one, and stays silent where none exists
   (non-browser import, ancient runtime). */
export function createWheelSound(options = {}) {
  const opts = options || {};
  const Ctor = opts.AudioContext ||
    (typeof globalThis !== 'undefined' ? globalThis.AudioContext : null);

  let enabled = false;   // opt-in every summon: fed from behavior.wheelSound
  let ctx = null;        // created lazily on the first enabled play
  let heard = null;      // seg record the hover tick last fired for

  function ensureCtx() {
    if (!Ctor) return null;
    if (!ctx) { try { ctx = new Ctor(); } catch { return null; } }
    // Summon is programmatic, not a user gesture: the first (hover) attempt may
    // land while suspended and be dropped; mousedown/Enter unlock the context
    // and every later tick plays. resume() failures are expected — ignore.
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try { ctx.resume().catch(() => {}); } catch { /* fail-soft */ }
    }
    return ctx;
  }

  return {
    /* Called per summon with the fresh payload flag. Turning sound off also
       clears the hover memory so a later re-enable re-ticks the plate under
       the cursor. */
    setEnabled(on) {
      enabled = !!on;
      if (!enabled) heard = null;
      return enabled;
    },

    isEnabled() { return enabled; },

    /* Pointer/keyboard selection moved to `seg` (null = off the wheel).
       Returns true only when a tick actually played — repeated reports of
       the same segment (every mousemove frame) stay silent. */
    hoverSeg(seg) {
      if (!enabled) return false;
      if (!seg) { heard = null; return false; }
      if (seg === heard) return false;
      heard = seg;
      return playTick(ensureCtx(), 'hover');
    },

    /* A segment is about to fire. Always ticks (independent of hover state:
       keyboard Enter on a fresh pop may never have moved through hoverSeg). */
    fire() {
      if (!enabled) return false;
      return playTick(ensureCtx(), 'fire');
    },

    /* Wheel rebuilt mid-pop (silent icon refresh, fan open/close): segment
       records are new objects, so drop the identity memory instead of
       remapping — the next report re-ticks at worst one frame later. */
    reset() { heard = null; },

    /* Test seam / window-close hygiene: forget the context. */
    dispose() {
      heard = null;
      if (ctx && typeof ctx.close === 'function') { try { ctx.close(); } catch { /* fail-soft */ } }
      ctx = null;
    }
  };
}
