---
target: settings
total_score: 26
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
target_identity: "file:C:\\Users\\mockcomic\\Desktop\\radial-wheel\\src\\renderer\\settings\\settings.js"
target_fingerprint: "sha256:0722588f57151bb08a3f4aa11878052e1182c9d517068e8c3eb9653ab5aae4ba"
target_path: "C:\\Users\\mockcomic\\Desktop\\radial-wheel\\src\\renderer\\settings\\settings.js"
timestamp: 2026-09-30T17-48-31Z
slug: src-renderer-settings-settings-js
---
# Design Critique — Radial Wheel · Settings window (src/renderer/settings/)

Method: dual-agent (A: 1433e8c4 unanchored design review · B: 4c145e42 deterministic detector + triage). Mode: Operate.

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live preview, slider outputs, hotkey chip, toasts — but autosave is silent (dirty flag never surfaced); hotkey chip lies after Import |
| 2 | Match System / Real World | 3 | Plain tool voice, human glossary, format-teaching placeholders; minor jargon defined in Advanced |
| 3 | User Control and Freedom | 2 | Delete has snapshot-undo; Import has neither confirm nor undo; Reset uses native confirm() with no undo; reorder/move-ring none |
| 4 | Consistency and Standards | 3 | Three destructive-action contracts (toast-undo / native confirm() / nothing); chrome glyphs unicode, not Segoe Fluent |
| 5 | Error Prevention | 3 | Excellent config validation and hotkey fallback; but ▶ runs arbitrary commands/lock/sleep unguarded; Import unconfirmed |
| 6 | Recognition Rather Than Recall | 3 | Live preview exemplary; 5 icon-only minis hover-to-decode; modal close not AT-discoverable |
| 7 | Flexibility and Efficiency | 2 | Core loop mouse-gated (non-focusable rows); typing broken (P0); no tab accelerators, duplicate, or bulk actions |
| 8 | Aesthetic and Minimalist Design | 3 | Disciplined and on-system; always-accent .seg-ico dilutes the Pilot Blue Rule; 5-mini cluster |
| 9 | Error Recovery | 3 | Hotkey banner/toasts good; corrupt config.json silently defaults with no pointer to the .bad copy |
| 10 | Help and Documentation | 2 | Contextual hints only (hotkey/action-types/preview); no macro-syntax help, no docs/About |
| **Total** | | **26/40** | **Acceptable — authored foundation, significant execution gaps** |

All ten heuristics scored; none n/a (Operate surface with explicit keyboard expectations).

## Design Specificity Verdict

**LLM assessment: strongly authored.** Instrument-panel three-column grid (210/1fr/460, settings.css:9) with a live-preview bay rendering the shipping wheel through the same buildWheel as the overlay (settings.js:1,476-482 → wheel-core.js). Domain geometry exposed 1:1 (Hub size / Ring split / Gap° / Pop duration, settings.js:321-329); action model (app/url/file/command/macro/sys, macro syntax, sys catalog, Try-this-action, installed-programs scanner settings.js:228-292) tailored to this product. Density tokens followed literally (9×12 rows, 2×7 minis, 4-col editor, 150px color grid, uppercase-tracked preview title). Problems are execution craft, not category sameness.

**Deterministic scan:** detector ran on src/renderer/settings — 30 findings (9 warning, 21 advisory; exit 0, no error-severity). low-contrast 4, gray-on-color 1, dark-glow 2, design-system-color 6, design-system-font-size 8, design-system-radius 6, design-system-font 2, em-dash 1.

Agreement: #5f7488 combo paths (~3.8:1, settings.css:132) and danger red #e05656 on #1d2a37 (3.9:1) found independently by both. Detector caught what the LLM missed: .btn.primary never sets color:#fff (settings.css:52), so ink #e8eef4 on --accent-dim = 3.6:1, hover #4c9ff0 = 2.4:1 — contradicting DESIGN.md's own button-primary white-text spec; active-tab white on #2e7dd1 = 4.2:1. False positives (verified): dark-glow ×2 = the sanctioned brand-dot glow (settings.css:18; no focus-visible box-shadow exists anywhere); Segoe Fluent Icons font/19px/22px findings = glyph sizing sanctioned in DESIGN.md prose but absent from the token block; #fff/#3a1d1d/#ffb3b3 = documented-in-prose colors missing from the colors: token map; em-dash counted code comments. Real advisory findings: #a8d0f0 off-token code tint, #5f7488, 9px radius ×4 off the 6/7/8/10/12/20 scale (settings.css:62,73,103,127), 9.5px icon-name captions (settings.css:118).

Browser overlays: skipped — no browser automation in session; Electron app not launched; no servers started.

## Overall Impression

A settings window with a real point of view: honest shared-renderer preview, brand-voiced copy. It scores 26/40 because the core loop is broken and mouse-only — typing one character into a segment field destroys the field mid-keystroke, and opening an existing segment requires a mouse, against PRODUCT.md's own keyboard-operability clause. Biggest opportunity: fix the editing loop, then make destructive operations honor the forgiveness model the delete toast already proves.

## What's Working

1. Single-source-of-truth preview — Settings bay and overlay share buildWheel; "configure live, not blind" is architectural, and it is the surface's best feedback/recognition tool.
2. Token-faithful quiet instrument — midnight ramp, hairline seams, float-only shadows, density steps, mono-for-machine-truth followed to the letter; reads as authored hardware.
3. Reassuring microcopy + real validation — index.html:55's hotkey hint teaches, de-risks, and states the fallback in one breath; delete→toast→Undo is the brand's forgiveness model complete.

## Priority Issues

1. [P0] Typing into a segment editor breaks after one keystroke — bind('input') → touch() (rerender=true) → renderSegments() tears down host.innerHTML and destroys the focused input (settings.js:41-46,76-77,153-156,173). Naming an item is one char per click. Fix: touch(false) for text inputs (pattern exists at settings.js:180,263) + sync cached row text, or restore focus/caret. Command: $impeccable harden
2. [P1] Core editing loop is mouse- and vision-gated — non-focusable div rows (settings.js:99-100,133); grep-verified the only tabindex in the renderer is the combo row: no ARIA, no :focus-visible anywhere, icon modal has no focus trap/Esc (settings.js:316-317), outline:none on combo rows (settings.css:128), sliders/editor labels unassociated (settings.js:335-339,155-173). Fix: role=button rows with Enter/Space, ARIA tablist, label for/id everywhere, focus rings, modal Esc+trap. Commands: $impeccable audit + $impeccable harden
3. [P1] Accent surfaces — the ones inviting action — fail AA — primary CTA 3.6:1→2.4:1 hover (violating DESIGN.md's white-text spec), active tab 4.2:1, danger 3.9:1, combo paths ~3.8:1. Fix: .btn.primary color:#fff (darken --accent-dim past 4.5:1 with white if needed), raise danger/#5f7488 to AA on real backgrounds. Command: $impeccable polish
4. [P1] Bulk destructive ops break the brand contract — Import replaces the whole config with no confirm/undo (settings.js:461-465) and skips showHkError so the chip lies; Reset uses native confirm() with no undo (settings.js:466-470); ▶ can fire sys:sleep/taskkill from a 2×7px mini beside ✕ (settings.css:56,69). Fix: snapshot-undo toasts for Import/Reset (delete flow proves the pattern), in-app confirm, space/guard ▶. Command: $impeccable harden
5. [P2] Highest-stakes moments are silent — corrupt config.json silently defaults, .bad unmentioned (config.js:189); importedFrom dropped by boot() (config.js:179 vs settings.js:494-501); autosave gives no Saved/Pending; renderAll() re-adds #btn-test/#ap-centerlabel listeners (settings.js:451-454) so Test pops the wheel N× after imports. Fix: general banner reusing #hk-error styling with Restore action, quiet Saved state, move bindings out of renderAll(). Commands: $impeccable harden + $impeccable clarify

## Persona Red Flags

Sam (keyboard-only/SR): cannot open an existing segment without a mouse (non-focusable div, settings.js:99,133); editor/slider inputs have no accessible name (settings.js:335-339,155-173); buttons/combo rows have no visible focus; icon modal traps nothing, answers no Esc. Violates PRODUCT.md's WCAG/keyboard clause outright.

Alex (impatient power user): recorder is great kbd-only; everything else friction — one char per click (P0), five hover-to-decode minis, no duplicate/bulk reorder/tab accelerators. Fixes the wheel once, never opens Settings again.

Riley (stress tester): (a) fields collapse mid-word; (b) Import with an occupied hotkey → tray says failed while the chip displays the new combo (settings.js:461-465 skips showHkError); (c) after Import/Reset one Test click pops the wheel multiple times (settings.js:451-454); (d) hand-corrupt config.json → defaults, no trace (config.js:189); (e) a 2px-target slip on ▶ runs taskkill live. All reproducible from source.

## Minor Observations

- Chrome glyphs ▶ ✕ ↑ ↓ ⇄ ▾ ↻ are unicode, not Segoe Fluent codepoints — breaks the one-pictographic-voice rule.
- .seg-ico forces --accent on every row icon (settings.css:65): accent decorates inactive content, violating the Pilot Blue Rule.
- 9px radius at settings.css:62,73,103,127 is off the 6/7/8/10/12/20 scale — pick 8 or 10.
- 9.5px muted icon-name captions (settings.css:118) are effectively invisible; ≥11px or drop labels.
- #a8d0f0 code tint (settings.css:92) is off-token — mint a --code-ink token or map to --accent.
- DESIGN.md prose documents error-banner colors, tab-active white, and icon font/glyph sizes, but the colors:/typography: token block omits them — ~12 of the detector's 30 findings are this prose↔token drift, closable with $impeccable document.
- Dead code: recordingHotkey (settings.js:14) unused; slider drags rebuild all segment rows per frame (settings.js:340) though they sit on another tab.
- No prefers-reduced-motion anywhere in the renderer (grep-verified) despite PRODUCT.md/DESIGN.md mandating it; pop duration is user-tunable but toast/hover motion never auto-honors the OS setting.

## Questions to Consider

1. If the live preview is the promise, why is it pointer-events:none (settings.css:99)? Making the signature hover-dim + hub-report feelable in Settings would turn the window into the muscle-memory builder the product claims to be.
2. Delete proves the forgiveness model (toast + Undo). Why do Import and Reset — the ops that erase the entire configuration — use the opposite contract?
3. The 460px bay renders a static wheel and one CTA. Should the preview become the primary editor (drag ring split, click a segment) with fields demoted to a contextual inspector?
