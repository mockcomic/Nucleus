---
target: settings
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:C:\\Users\\mockcomic\\Desktop\\radial-wheel\\src\\renderer\\settings\\settings.js"
target_fingerprint: "sha256:c5864e2287d9afdec43fabfb95fef1141875bc6ebbc7e070f3eb00a812d0c4e4"
target_path: "C:\\Users\\mockcomic\\Desktop\\radial-wheel\\src\\renderer\\settings\\settings.js"
timestamp: 2026-09-30T18-41-31Z
slug: src-renderer-settings-settings-js
---
# Design Critique — Radial Wheel · Settings window (src/renderer/settings/)

Method: dual-agent (A: 1f9ce1e3 unanchored source review · B: 2e06c5f4 deterministic detector + triage). Mode: Operate. Surface: Settings window + shared wheel renderer.

> Post-assessment note: between Assessment A's review and this snapshot, seven defects were fixed in-run (marked ✅ below) — two of them regressions introduced by the same session's harden+polish pass (centerLabel persistence, mouse-only toast Undo span). The heuristic table reflects the code **as assessed**; the ✅ marks show the shipped state.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Save-state chip, toasts, banners — but ✅ centerLabel previewed as saved while silently never persisting |
| 2 | Match System / Real World | 3 | OS-native voice, WYSIWYG glyph preview — jargon leaks ("Pop duration ms", raw macro syntax) onto the primary surface |
| 3 | User Control and Freedom | 2 | Undo was a mouse-only 6s whole-config snapshot; ✅ Undo now focusable, ✅ last-segment delete blocked; Reset still unconfirmed, no .bak |
| 4 | Consistency and Standards | 3 | ✅ nested role=button removed, ✅ Mic-glyph-as-Play fixed (E9A1), ✅ Delete vs Clear glyph split; ring-move still has two mechanisms |
| 5 | Error Prevention | 3 | Try-arm is textbook — but Reset overwrites everything with zero confirm while the milder Quit confirms |
| 6 | Recognition Rather Than Recall | 3 | Rows carry name/type/value; ✅ mini buttons now aria-labeled (were title-only PUA glyphs); macro syntax lives in the disconnected Advanced tab |
| 7 | Flexibility and Efficiency | 3 | Tab arrow-nav, Enter/Space disclosure ✅; no Duplicate, no drag reorder (±1 per click), no bulk path |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined, flat-at-rest, one accent; dense editor (6 fields at once) + inline style= one-offs keep it from 4 |
| 9 | Error Recovery | 3 | hk-error banner, Not-saved state, corrupt-config banner with Restore path, combo empty guidance — strong |
| 10 | Help and Documentation | 2 | Type semantics explained only in Advanced, not at the type select; %APPDATA% hint assumes the config-comfort the product exists to remove |
| **Total** | | **27/40** | **Acceptable (high end) — a well-built instrument with sharp trust/click hazards** |

All ten heuristics scored; none n/a (Operate surface with keyboard expectations).

## Design Specificity Verdict

**LLM assessment: strongly authored.** The 210px/1fr/460px three-column instrument matches DESIGN.md literally; the token block is honored verbatim (verified: zero hardcoded colors outside tokens); mono marks machine truth; Fluent glyphs are the sole pictographic voice; and the shared `buildWheel` renderer makes "configure live, not blind" structurally true, not a slogan. Generic lapses are secondary-surface only: the ~60-glyph icon picker is a bare ungrouped grid despite the sys catalog carrying `group` metadata the UI never uses, and the toast layer is generic.

**Deterministic scan (Assessment B):** 5 findings (4 unique), exit 0-equivalent — dark-glow ×2 (duplicate report of the sanctioned brand-dot pilot glow, DESIGN.md's only permitted glow), bounce-easing ×2 (the sanctioned Snap-Back spring: `.seg.hovered` transition + `wheelpop`; the pop-vs-"hover only" letter conflict was resolved in-run by amending the DESIGN.md rule to "the wheel alone — hover nudge and summon pop"), em-dash ×1 (false positive: 5 of 9 hits are glossary definition delimiters + title; real body count 4, under threshold).

**Detector miss (real, found by manual scan):** ✅ `.toast .undo` was a mouse-only `<span onclick>` — the brand's own model for forgiving feedback failed DESIGN.md's full-state-set mandate. Now a real `<button>`.

**Browser overlays:** skipped — no browser automation in session; overlay injection not applicable to Electron windows.

## Overall Impression

The settings window finally does its core job honestly — typing edits in real time, keyboard paths exist, destructive row ops confirm, and the instrument voice is consistent from the sidebar to the mono path columns. The remaining risk concentrates in one inversion: **the most destructive actions (Reset, Import) have the thinnest safety net** (6-second toast, whole-config snapshot), while milder ones (Quit, Try-command) get confirms. Fix that inversion and this is a Good-tier surface.

## What's Working

1. Shared renderer as truth: one `buildWheel` feeds overlay and preview — the WYSIWYG promise cannot drift from the product.
2. Risk-aware Try-arm: two-step with red armed state and 3s window for command/macro/sys only; safe types stay one-click. Keyboard-reachable.
3. In-place typing fix: `syncRowText()` + `touch(false)` preserves caret/focus while keeping row captions live — verified working, not just claimed.

## Priority Issues

1. [P1] **Reset/Import safety net is inverted vs. risk** — Reset wipes the whole config with zero confirm (Quit confirms!), undo is a 6s whole-config snapshot that clobbers post-toast edits. Fix: hold-to-confirm or Try-arm-style two-step on Reset; write `config.json.bak` before import/reset and offer persistent "Restore previous" in Advanced; make delete-undo granular (re-insert the one item at its index). ✅ Partially closed in-run: Undo is now keyboard-focusable and last-segment delete is blocked. — Command: `$impeccable harden`
2. [P1] **Icon-only mini actions were unlabeled and the row was invalid ARIA** — title-only Private-Use-Area glyphs announced as garbage; combo was div-soup invisible to NVDA. ✅ Closed in-run: disclosure `<button aria-expanded>`, `aria-label` on every mini, `role=listbox`/`option` + `aria-activedescendant` on the installed-programs picker. Residual: `title` tooltips still never appear on keyboard focus — surface hints as visible affordance or tooltip-on-focus. — Command: `$impeccable audit`
3. [P1] ✅ **Center text (hub label) silently never saved** — previewed live, persisted never; caught by Assessment A as a same-session regression, fixed in-run (`touch(false)` restored) + verified clean boot.
4. [P2] **No efficiency path for building a wheel** — no Duplicate, reorder is ±1 per click, no keyboard accelerators on Add/Delete; a full wheel is N manual add→expand→type loops. Fix: row Duplicate action, pointer drag reorder (keep ±1 for keyboard). — Command: `$impeccable optimize`
5. [P2] **The icon picker is category-interchangeable** — bare 60-glyph grid, no search, no groups despite catalog metadata; and initial modal focus sat on "None" (✅ moved to Close). — Command: `$impeccable polish`

## Persona Red Flags

**Sam (keyboard-only/SR):** ✅ Undo now a real button; ✅ disclosure replaces invalid nested role=button; ✅ combo now listbox/option with activedescendant; ✅ minis have accessible names. Residual: title-only hints invisible to keyboard; tabpanels unscrollable by keyboard (no tabindex).

**Alex (impatient power user):** ±1-per-click reorder and zero Duplicate remain the abandonment risk; the inert preview (`pointer-events:none`) still forbids rehearsing a config before committing to the Test-the-real-wheel hop.

**Riley (stress tester):** ✅ last-segment delete guarded; two-delete stacked toasts still each carry whole-config snapshots (older Undo clobbers newer edits — see Priority 1); sub-450ms pre-quit edits can be lost (debounce timer not flushed on quit — report-only).

## Minor Observations

- Inline `style=` one-offs in segEditor/appCombo bypass the token system.
- Tabpanels get role/labelledby imperatively but no `tabindex` for keyboard scrolling.
- `valueHint` placeholders render `taskkill /f /im foo.exe` — power-user-helpful, first-timer-intimidating.
- `#save-state` renders in --dim low in the sidebar foot; reliable but quiet.
- Ring-move has two mechanisms (row ⇄ and editor radios) — same verb, two UIs.

## Questions to Consider

1. The preview mirrors the renderer but deliberately not the experience (no hover-lift, no hub report). If "it has to feel touched" is the product's identity, why is the configuring surface the one place it's switched off — and what would it cost to let the preview hover-and-report without executing?
2. Reset destroys more than Quit, yet Quit asks and Reset does not. Why not give every irreversible action the deliberate two-step guard the Try-arm already proves?
3. Where else is a generic control (ungrouped grid, inert dial, unlabeled glyph buttons) quietly spending down the specificity the shared renderer earned?
