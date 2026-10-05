# Product

## Register

product

## Platform

web

## Users

General Windows users — including people who are not comfortable editing config files. They keep Radial Wheel running in the tray all day and summon the wheel at their cursor with a global hotkey from inside whatever they're already doing: writing, browsing, building. The context is interruption-free access — they don't want to leave their task to configure or fire an action. Secondary context: the same person, minutes later, in the Settings window, deliberately shaping the wheel to their workflow.

## Product Purpose

An always-running radial launcher for Windows: one hotkey pops a two-ring wheel at the mouse cursor; clicking a segment launches apps, opens URLs or files, runs commands, replays keystroke and mouse macros, or triggers built-in Windows actions. It exists to compress repetitive desktop choreography into muscle memory — **and** to make that compression genuinely satisfying to use. Speed and delight are both success criteria: the wheel must be faster than Alt+Tab or the Start Menu, and it must feel like a rewarding object at the cursor rather than a menu. The Settings window (Segments, Appearance, Hotkey & Behavior, Advanced) is where that muscle memory gets built, per-user, with live preview and autosave.

## Positioning

The all-in-one action hub: launcher, macro engine, and Windows-actions panel unified in one radial surface at your cursor — nothing else bundles all three into a single configurable wheel.

## Brand Personality

Playful, tactile, fast. The wheel is a physical object: it pops in, segments respond under the cursor with weight and snap-back, the hub reports what's hovered, and it vanishes the moment its job is done. Voice is direct and confident — a tool talking, not a marketing page. Micro-rewards (the pop animation, hover lift, toasts with undo) carry the personality; chrome never does.

## Anti-references

**Gamer-HUD overlays.** No neon glows, no translucent-acrylic HUD frames, no sci-fi chrome dressed up as "immersive." Tactile playfulness comes from motion physics and material depth, not from decorative glow. (Related standing constraints from the codebase's own notes: no backdrop blur is possible on the transparent overlay anyway; depth is shadows + tuned fills.)

## Design Principles

1. **Cursor-first, zero-friction** — the wheel appears exactly where the hand already is; every interaction path (hover, select, dismiss) must be shorter than the equivalent keyboard trip.
2. **It has to feel touched** — motion, hover response, and snap-back are core function, not decoration; a wheel that summons dead is a failed feature even if it launches perfectly.
3. **One hub, every action type** — apps, URLs, files, commands, macros, and system actions configure and fire through one consistent model, so mastery of one segment type transfers to all.
4. **Configure live, not blind** — Settings edits preview instantly through the same renderer as the real wheel; autosave and undo mean experimenting is safe.
5. **Quiet when absent, sharp when present** — tray-resident and invisible between summons; when shown, high-contrast and instantly legible at a glance.

## Accessibility & Inclusion

WCAG 2.1 AA: body text ≥4.5:1, large text ≥3:1 against tinted dark surfaces. Full keyboard operability in the Settings window (tab order, focus rings, Enter/Esc on dialogs; the hotkey recorder works without a mouse). The wheel honors `prefers-reduced-motion` — the pop animation degrades to an instant/crossfade appearance without losing affordance. Dark theme is the default; contrast of muted grays (`--dim`) against panel backgrounds must be verified, not assumed.
