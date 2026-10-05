'use strict';
/* The macro step grammar added for mouse input: parseStep / stepCostMs /
   parseSpec are pure (no FFI, no fs), so this file covers the whole new syntax
   — including the x64 MOUSEINPUT byte layout — WITHOUT injecting a single
   event. Nothing here may call sendMacro with an executable step: this suite
   runs on machines that own a real mouse (see AGENTS.md); only bounds-rejected
   specs are allowed to reach the runner. */
const test = require('node:test');
const assert = require('node:assert/strict');

const macro = require('../../src/main/macro.js');
const { _parseStep: parseStep, _stepCostMs: stepCostMs, _parseSpec: parseSpec, _mouseBuffer: mouseBuffer,
        MACRO_MAX_REPEAT, MACRO_MAX_HOLD_MS, MACRO_MIN_HOLD_MS, MACRO_DEFAULT_HOLD_MS,
        MACRO_MAX_SCROLL_NOTCHES, MACRO_MAX_TOTAL_WAIT_MS } = macro;

/* Partial deepEqual: assert.match is for regexes, and these records carry
   extra fields (or nested ones) we check separately. */
const like = (actual, expected, msg = '') => {
  assert.ok(actual && typeof actual === 'object', `${msg} expected an object, got ${actual}`);
  for (const [k, v] of Object.entries(expected)) assert.deepEqual(actual[k], v, `${msg} ${k}`);
};

/* ------------------------------ mouse buttons ------------------------------ */
test('mouse steps classify to the right button', () => {
  like(parseStep('click'), { kind: 'mouse', button: 'left', double: false });
  like(parseStep('rclick'), { kind: 'mouse', button: 'right', double: false });
  like(parseStep('mclick'), { kind: 'mouse', button: 'middle', double: false });
  like(parseStep('dblclick'), { kind: 'mouse', button: 'left', double: true });
  like(parseStep('back'), { kind: 'mouse', button: 'x1', double: false });
  like(parseStep('forward'), { kind: 'mouse', button: 'x2', double: false });
  // friendly spellings and case/whitespace tolerance
  assert.equal(parseStep('  RightClick ').button, 'right');
  assert.equal(parseStep('MiddleClick').button, 'middle');
  assert.equal(parseStep('DoubleClick').double, true);
  assert.equal(parseStep('xbutton1').button, 'x1');
  assert.equal(parseStep('XBUTTON2').button, 'x2');
});

test('a mouse word inside a chord stays a KEY token (mouse steps are their own steps)', () => {
  // 'ctrl+click' must not silently become a click: it falls through to the
  // chord path, where vkFor() reports it at execution time — same as any
  // unknown key, and exactly what the pre-mouse engine did.
  like(parseStep('ctrl+click'), { kind: 'chord', tokens: ['ctrl', 'click'] });
});

/* --------------------------------- wheel ---------------------------------- */
test('scroll notches: positive is down, negative up, bare token is one notch', () => {
  like(parseStep('scroll=3'), { kind: 'scroll', notches: 3 });
  like(parseStep('scroll=-3'), { kind: 'scroll', notches: -3 });
  like(parseStep('wheel=2'), { kind: 'scroll', notches: 2 });
  like(parseStep('scroll'), { kind: 'scroll', notches: 1 });
  like(parseStep('SCROLL=0'), { kind: 'scroll', notches: 0 });
  assert.equal(parseStep('scroll=3.6').notches, 4, 'fractional notches round');
});

test('scroll bounds: junk and over-cap are refused with a usable message', () => {
  assert.throws(() => parseStep('scroll=abc'), /notches/);
  assert.throws(() => parseStep('scroll='), /notches/);
  assert.throws(() => parseStep(`scroll=${MACRO_MAX_SCROLL_NOTCHES + 1}`), /exceed 25 notches/);
  assert.throws(() => parseStep('scroll=-999'), /exceed 25 notches/);
  assert.doesNotThrow(() => parseStep(`scroll=${MACRO_MAX_SCROLL_NOTCHES}`));
});

/* ---------------------------------- hold ---------------------------------- */
test('hold parses a chord and an optional duration', () => {
  assert.deepEqual(parseStep('hold=ctrl+c=1.5'), { kind: 'hold', tokens: ['ctrl', 'c'], ms: 1500 });
  assert.deepEqual(parseStep('hold=f15'), { kind: 'hold', tokens: ['f15'], ms: MACRO_DEFAULT_HOLD_MS });
  assert.deepEqual(parseStep('hold=a=0.05'), { kind: 'hold', tokens: ['a'], ms: 50 });
  assert.equal(parseStep('  HOLD = ctrl+alt+del = 2 ').ms, 2000);
  assert.deepEqual(parseStep('hold=ctrl+alt+del=2').tokens, ['ctrl', 'alt', 'del']);
});

test('hold duration is clamped both ways, and never exceeds the wait ceiling', () => {
  assert.equal(parseStep('hold=a=0').ms, MACRO_MIN_HOLD_MS);
  assert.equal(parseStep('hold=a=999').ms, MACRO_MAX_HOLD_MS);
  assert.equal(MACRO_MAX_HOLD_MS, 5000, 'a hold must be no longer than a wait=');
});

test('malformed holds throw instead of becoming a key named "hold=…"', () => {
  assert.throws(() => parseStep('hold='), /malformed|needs a key/);
  assert.throws(() => parseStep('hold=ctrl+c,x'), /malformed|commas/);
  assert.throws(() => parseStep('hold=a=b=c'), /malformed/);
});

/* --------------------------------- repeat --------------------------------- */
test('repeat wraps exactly one step, and nesting is refused', () => {
  assert.deepEqual(parseStep('repeat=3:ctrl+v'), { kind: 'repeat', n: 3, inner: { kind: 'chord', tokens: ['ctrl', 'v'] } });
  assert.equal(parseStep(`repeat=${MACRO_MAX_REPEAT}:click`).n, MACRO_MAX_REPEAT);
  assert.throws(() => parseStep('repeat=99:click'), /exceed 20/);
  assert.throws(() => parseStep('repeat=0:click'), /1 or more|malformed/);
  assert.throws(() => parseStep('repeat=abc:click'), /malformed/);
  assert.throws(() => parseStep('repeat=2:repeat=2:a'), /cannot wrap another repeat/);
  assert.throws(() => parseStep('repeat=3:wait=1'), /cannot wrap wait/);
  assert.throws(() => parseStep('repeat=3:type:hi'), /cannot wrap type/);
});

test('repeat multiplies its inner step into the wait budget', () => {
  const one = stepCostMs(parseStep('hold=a=1'));
  assert.equal(stepCostMs(parseStep('repeat=5:hold=a=1')), one * 5);
  assert.equal(stepCostMs(parseStep('type:hello')), 0, 'typed text is bounded by the spec length cap instead');
});

/* --------------------------- back-compat (no regressions) ------------------ */
test('the pre-mouse grammar parses exactly as before', () => {
  assert.deepEqual(parseStep('ctrl+c'), { kind: 'chord', tokens: ['ctrl', 'c'] });
  like(parseStep('wait=0.2'), { kind: 'wait', ms: 200 });
  like(parseStep('wait=0'), { kind: 'wait', ms: 0 }, 'wait=0 stays no-pause');
  like(parseStep('wait=999'), { kind: 'wait', ms: 5000 }, 'still clamped to 5 s');
  assert.deepEqual(parseStep('type:hello, world'), { kind: 'type', text: 'hello, world' });
  assert.equal(parseStep('   '), null, 'blank steps drop out');
  // a step that is neither a new form nor a known key stays a chord → vkFor owns the error
  like(parseStep('not-a-key'), { kind: 'chord', tokens: ['not-a-key'] });
});

test('a mixed keyboard + mouse spec parses end to end', () => {
  const steps = parseSpec('ctrl+c, wait=0.2, click, scroll=-2, rclick, hold=f15=1, repeat=2:ctrl+v');
  assert.deepEqual(steps.map((s) => s.kind),
    ['chord', 'wait', 'mouse', 'scroll', 'mouse', 'hold', 'repeat']);
});

/* --------------------------------- bounds ---------------------------------- */
test('parseSpec enforces the bounds BEFORE any injection', () => {
  assert.throws(() => parseSpec(Array(MACRO_MAX_TOTAL_WAIT_MS / 1000 + 1).fill('wait=999').join(', ')), /waits exceed/);
  // 20 × 5 s hold == 100 s of work: rejected even though no step is a wait=.
  assert.throws(() => parseSpec('repeat=20:hold=a=5, repeat=20:hold=a=5'), /waits exceed/);
  assert.throws(() => parseSpec('z'.repeat(2049)), /too long/);
  assert.throws(() => parseSpec(Array(129).fill('click').join(', ')), /too many steps/);
});

test('ordinary specs stay inside every budget', () => {
  assert.doesNotThrow(() => parseSpec('click, scroll=3, hold=a=1, repeat=3:ctrl+c, wait=1'));
  assert.doesNotThrow(() => parseSpec(Array(128).fill('ctrl+a').join(', ')));
});

/* --------------------- MOUSEINPUT layout (the FFI boundary) ---------------- */
test('mouse buffers carry the x64 INPUT layout at the documented offsets', () => {
  const SIZE = process.arch === 'ia32' ? 28 : 40;
  const b = mouseBuffer(0x0800, -360);           // WHEEL with three notches toward the user
  assert.equal(b.length, SIZE, 'INPUT size must match the arch');
  assert.equal(b.readUInt32LE(0), 0, 'INPUT_MOUSE');
  assert.equal(b.readInt32LE(8), 0, 'dx stays 0 (no absolute move)');
  assert.equal(b.readInt32LE(12), 0, 'dy stays 0');
  assert.equal(b.readUInt32LE(16), (-360) >>> 0, 'mouseData @16, unsigned as Win32 declares it');
  assert.equal(b.readUInt32LE(20), 0x0800, 'dwFlags @20');
  assert.ok(b.subarray(SIZE - 8).every((x) => x === 0), 'dwExtraInfo stays zero — never a stray pointer');
});
