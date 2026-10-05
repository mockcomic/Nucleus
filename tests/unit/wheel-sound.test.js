/* Pure behavior of the wheel's sound feedback (shared/wheel-sound.js): the
   opt-in gate, the hover change-detection table, and fail-soft against a
   hostile AudioContext. No Web Audio exists in node — the factory takes the
   constructor as an option, so this runs against a recording stub (same
   DOM-free import style as mark-filter.test.js). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TICKS, createWheelSound } from '../../src/renderer/shared/wheel-sound.js';

/* A minimal AudioContext double: records every interaction, never plays. */
function makeEnv(opts = {}) {
  const calls = [];
  class FakeParam {
    setValueAtTime(v, t) { calls.push(['gain.setValueAtTime', v, t]); }
    linearRampToValueAtTime(v, t) { calls.push(['gain.linear', v, t]); }
    exponentialRampToValueAtTime(v, t) { calls.push(['gain.exp', v, t]); }
  }
  const makeOsc = () => {
    const osc = {
      _type: '',
      get type() { return this._type; },
      set type(v) { calls.push(['osc.type', v]); this._type = v; },
      frequency: { _v: 0, get value() { return this._v; }, set value(v) { calls.push(['osc.freq', v]); this._v = v; } },
      connect(n) { calls.push(['osc.connect', n]); return n; },
      start(t) { calls.push(['osc.start', t]); },
      stop(t) { calls.push(['osc.stop', t]); }
    };
    if (opts.throwOnStart) osc.start = () => { throw new Error('kaboom'); };
    return osc;
  };
  class FakeCtx {
    constructor() {
      calls.push(['ctor']);
      this.state = opts.state || 'running';
      this.currentTime = 1.5;
      this.destination = { dest: true };
      if (opts.throwOnCtor) throw new Error('no audio device');
    }
    createOscillator() { calls.push(['createOscillator']); return makeOsc(); }
    createGain() { calls.push(['createGain']); return { gain: new FakeParam(), connect(n) { calls.push(['gain.connect', n]); return n; } }; }
    resume() { calls.push(['resume']); return Promise.reject(new Error('needs gesture')); }
    close() { calls.push(['close']); }
  }
  return { FakeCtx, calls };
}

const seg = (id) => ({ item: { id } });

/* -------------------------------- the gate -------------------------------- */
test('disabled (the default): no AudioContext is ever created', () => {
  const { FakeCtx, calls } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  assert.equal(s.hoverSeg(seg('a')), false);
  assert.equal(s.fire(), false);
  assert.deepEqual(calls, []);                       // lazy: zero cost while off
});

test('setEnabled(true) allows ticks; setEnabled(false) gates them again', () => {
  const { FakeCtx } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  assert.equal(s.setEnabled(true), true);
  assert.equal(s.fire(), true);
  assert.equal(s.setEnabled(false), false);
  assert.equal(s.fire(), false);
});

/* --------------------------- hover change detection ------------------------ */
test('hover ticks once per NEW segment, not per mousemove report', () => {
  const { FakeCtx, calls } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  const a = seg('a');
  assert.equal(s.hoverSeg(a), true);
  assert.equal(s.hoverSeg(a), false);                // same seg — silent
  assert.equal(s.hoverSeg(seg('a')), true);          // identity, not content: a fresh record re-ticks
  assert.equal(s.hoverSeg(null), false);             // off the wheel: no tick...
  assert.equal(s.hoverSeg(a), true);                 // ...but returning re-ticks
  const oscFrequencies = calls.filter((c) => c[0] === 'osc.freq').map((c) => c[1]);
  assert.deepEqual(oscFrequencies, [TICKS.hover.freq, TICKS.hover.freq, TICKS.hover.freq]);   // a, fresh-record(a), a-after-off-wheel
});

test('hovering the SAME record again after reset() re-ticks', () => {
  const { FakeCtx } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  const a = seg('a');
  assert.equal(s.hoverSeg(a), true);
  s.reset();                                          // silent rebuild swaps records
  assert.equal(s.hoverSeg(a), true);
});

test('disabling and re-enabling clears the hover memory', () => {
  const { FakeCtx } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  const a = seg('a');
  s.setEnabled(true);
  s.hoverSeg(a);
  s.setEnabled(false);
  s.setEnabled(true);
  assert.equal(s.hoverSeg(a), true);                  // re-arm: plate under cursor ticks again
});

/* ------------------------------- tick voices ------------------------------ */
test('hover and fire use their own distinct voices from TICKS', () => {
  const { FakeCtx, calls } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  s.hoverSeg(seg('a'));
  s.fire();
  const got = calls.filter((c) => c[0] === 'osc.freq').map((c) => c[1]);
  assert.deepEqual(got, [TICKS.hover.freq, TICKS.fire.freq]);
  assert.notEqual(TICKS.hover.freq, TICKS.fire.freq);
  assert.ok(TICKS.hover.gain < 0.1 && TICKS.fire.gain < 0.1, 'ticks stay quiet');
});

test('the envelope attacks then decays — a tick, not a beep', () => {
  const { FakeCtx, calls } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  s.fire();
  const env = calls.filter((c) => ['gain.setValueAtTime', 'gain.linear', 'gain.exp'].includes(c[0]));
  assert.deepEqual(env.map((c) => c[0]), ['gain.setValueAtTime', 'gain.linear', 'gain.exp']);
  assert.equal(env[0][1], 0);
  assert.equal(env[1][1], TICKS.fire.gain);
  assert.ok(calls.some((c) => c[0] === 'osc.stop'), 'the voice is self-cleaning');
});

/* ------------------------------- fail-soft -------------------------------- */
test('an AudioContext that cannot be constructed never breaks the wheel', () => {
  const { FakeCtx } = makeEnv({ throwOnCtor: true });
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  assert.equal(s.fire(), false);
  assert.equal(s.hoverSeg(seg('a')), false);          // and hover state still tracks
});

test('a voice that throws mid-schedule is dropped, not propagated', () => {
  const { FakeCtx } = makeEnv({ throwOnStart: true });
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  assert.equal(s.fire(), false);
});

test('a suspended context is nudged with resume() (autoplay policy)', () => {
  const { FakeCtx, calls } = makeEnv({ state: 'suspended' });
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  s.fire();
  assert.ok(calls.some((c) => c[0] === 'resume'));
});

test('no constructor at all (headless import) is simply silent', () => {
  const s = createWheelSound({ AudioContext: null });
  s.setEnabled(true);
  assert.equal(s.fire(), false);
  assert.equal(s.hoverSeg(seg('a')), false);
});

test('dispose() closes the context and drops the hover memory', () => {
  const { FakeCtx, calls } = makeEnv();
  const s = createWheelSound({ AudioContext: FakeCtx });
  s.setEnabled(true);
  const a = seg('a');
  s.hoverSeg(a);
  s.dispose();
  assert.ok(calls.some((c) => c[0] === 'close'));
  s.setEnabled(true);
  assert.equal(s.hoverSeg(a), true);                  // fresh context, re-tick
});
