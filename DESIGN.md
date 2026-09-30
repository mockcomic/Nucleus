---
name: Radial Wheel
description: A machined midnight action hub for Windows — launcher, macro recorder, and system-actions panel at the cursor.
colors:
  pilot-blue: "#4c9ff0"
  pilot-blue-deep: "#2e7dd1"
  accent-deep: "#2768b5"
  accent-deep-hi: "#2b73c6"
  midnight: "#0f1419"
  panel: "#131a22"
  card: "#161f29"
  hairline: "#21303e"
  ink: "#e8eef4"
  ink-muted: "#8fa3b5"
  danger: "#e56b6b"
  err-bg: "#3a1d1d"
  err-ink: "#ffb3b3"
  code-ink: "#a8d0f0"
  on-accent: "#ffffff"
  wheel-stroke: "rgba(255,255,255,0.06)"
  ring-inner: "#1b2733"
  ring-outer: "#16202b"
  wheel-center: "#0a0e12"
  field-bg: "#0d141b"
  btn-bg: "#1d2a37"
  hover-well: "#182330"
  edit-well: "#121a23"
  tab-hover-well: "#1a2430"
  scroll-thumb: "#24303d"
  preview-well-hi: "#17202a"
  preview-well-lo: "#0b1015"
  panel-vibrant: "rgba(19,26,34,0.68)"
  content-vibrant: "rgba(15,20,25,0.94)"
  focus-halo: "rgba(76,159,240,0.16)"
  rim-highlight: "rgba(255,255,255,0.08)"
typography:
  headline:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 700
    letterSpacing: "-0.4px"
    lineHeight: 1.2
  title:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 700
    letterSpacing: "0.3px"
  body:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
  label:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
  caption:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 400
  section-head:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
  micro-mono:
    fontFamily: "Consolas, monospace"
    fontSize: "10.5px"
    fontWeight: 400
  mono:
    fontFamily: "Consolas, monospace"
    fontSize: "12px"
    fontWeight: 400
  icon-row:
    fontFamily: "'Segoe Fluent Icons','Segoe MDL2 Assets',sans-serif"
    fontSize: "19px"
  icon-picker:
    fontFamily: "'Segoe Fluent Icons','Segoe MDL2 Assets',sans-serif"
    fontSize: "22px"
rounded:
  xxs: "4px"
  xs: "6px"
  sm: "7px"
  md: "8px"
  lg: "10px"
  xl: "12px"
  pill: "20px"
  full: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "22px"
components:
  button-primary:
    backgroundColor: "{colors.accent-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "7px 13px"
  button-primary-hover:
    backgroundColor: "{colors.accent-deep-hi}"
  button:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "7px 13px"
  input:
    backgroundColor: "{colors.field-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.sm}"
    padding: "7px 9px"
  tab-active:
    backgroundColor: "{colors.accent-deep}"
    textColor: "#ffffff"
    rounded: "{rounded.md}"
    padding: "10px 12px"
  alert-error:
    backgroundColor: "{colors.err-bg}"
    borderColor: "{colors.danger}"
    textColor: "{colors.err-ink}"
    rounded: "{rounded.md}"
    padding: "8px 12px"
  card:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.lg}"
    padding: "16px"
  chip:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "1px 7px"
  toast:
    backgroundColor: "{colors.btn-bg}"
    textColor: "{colors.ink}"
    rounded: "{rounded.lg}"
    padding: "9px 13px"
  switch:
    backgroundColor: "#24303d"
    checkedColor: "{colors.pilot-blue}"
    knobColor: "#ffffff"
    size: "28px 16px"
  slider:
    trackColor: "#24303d"
    fillColor: "{colors.pilot-blue}"
    thumbColor: "#ffffff"
  segmented-list:
    backgroundColor: "{colors.card}"
    separatorColor: "{colors.hairline}"
    rounded: "{rounded.lg}"
  preset-chip:
    backgroundColor: "{colors.card}"
    activeBorderColor: "{colors.pilot-blue}"
    rounded: "{rounded.full}"
    padding: "5px 11px"
---

# Design System: Radial Wheel

## Overview

**Creative North Star: "The Machined Object"** — an Apple-inspired physical system. Every surface reads as real material on a dark desk: machined edges lit from above, controls that press, a dial that springs under the finger. Depth comes from light and shadow on solid matter, never from glow.

Machined midnight hardware. The Settings window is a well-built instrument panel — three deliberate columns, dense but breathable rows, hairline seams instead of decoration. The wheel itself is the product's hero object: a two-ring dial of tinted metal plates at the cursor, popping in with weight and springing under hover. Color is nearly absent from the chrome and precisely present where it means something — Pilot Blue for the thing you're about to act on.

**Key Characteristics:**
- One family, five weights: Segoe UI carries everything; Segoe Fluent Icons is the only pictographic voice; Consolas marks machine truth (paths, values, code).
- Tonal midnight ramp (bg → panel → card → field) with hairline borders; shadows reserved exclusively for floating objects.
- On Windows 11 the sidebar and preview bay float on real DWM acrylic (see Vibrant chrome); everywhere else they keep the solid Panel step.
- Machined light discipline: buttons and cards carry a whisper of top-down sheen, inputs are carved with an inner shadow, and the wheel gets an off-center specular wash, a lit rim, and a crowned hub — Apple hardware lighting, never glow.
- A single accent — Pilot Blue — speaking for selection, focus, and primary action.
- Motion with physics: the wheel's 160 ms pop and spring-hover overshoot are the system's signature; everything else is ease-out under 200 ms, and press feedback is a quiet sink, never a bounce.
- Radius and padding steps are small and consistent; nothing is more decorative than its function.

## Colors

Near-black blue-tinted neutrals with one engineered accent; color is information, not atmosphere.

### Primary
- **Pilot Blue** (`{colors.pilot-blue}`): focus borders, active slider outputs, undo links, the brand dot's pilot glow — the only saturated color in the system.
- **Pilot Blue Deep** (`{colors.pilot-blue-deep}`): the working end of the accent — dropdown borders, wheel-segment hover fill, hotkey chip border, selection tint under non-text UI.
- **Accent Deep pair** (`{colors.accent-deep}` / `{colors.accent-deep-hi}`): the AA-compliant action surfaces — primary button fill and its hover step, active tab, hovered combo row, hovered icon cell. White text clears 4.5:1 on both; the deeper→lighter hover order is preserved.

### Neutral
- **Midnight** (`{colors.midnight}`): app canvas behind everything.
- **Panel** (`{colors.panel}`): sidebar and preview-pane chrome — one step up from canvas.
- **Card** (`{colors.card}`): content containers and segment rows.
- **Field** (`{colors.field-bg}`): inputs, selects, dropdown body, inline code — the deepest interactive well.
- **Button Slate** (`{colors.btn-bg}`): secondary button and chip/toast fill.
- **Hairline** (`{colors.hairline}`): every 1px border, divider, and seam.
- **Ink** (`{colors.ink}`): body and heading text; **Ink Muted** (`{colors.ink-muted}`): labels, hints, secondary values.
- **Signal Red** (`{colors.danger}`): destructive buttons, error banners and toast borders.

### Vibrant chrome (Windows 11 only)
On Windows 11 22H2+ with the OS transparency toggle on, the Settings window is created with DWM acrylic (`backgroundMaterial: 'acrylic'`) and `<html data-vibrant>` activates: sidebar and preview bay become translucent **Panel Vibrant** (`{colors.panel-vibrant}`) over the desktop, the content field stays near-opaque **Content Vibrant** (`{colors.content-vibrant}`), and every floating layer — cards, modals, dropdowns, toasts, inputs — keeps its solid token. The main process fail-sorts to the solid look (old OS, transparency off, reg-read failure) and `prefers-reduced-transparency` opts out entirely. Translucency is chrome-only and never appears on the wheel.

### Wheel plates (config-owned)
The overlay's ring fills (**Ring Inner**, **Ring Outer**, **Wheel Center**) are user-configurable at runtime and follow the same tonal logic: darker toward the hub, lighter per ring step, 1px white-at-6% edge strokes, hub ring stroked in the accent at 22% opacity.

### Runtime theme presets
The catalog ships in `src/main/themes.mjs` (single source of truth; the main
process loads the same literal through `themes.js`). Twelve curated themes in
families — **dark**: Midnight (default, blue-black + Pilot Blue), Ocean (deep
teal + cyan), Grape (violet), Graphite (light plates, dark chrome), Ember (rust
+ amber), Solar (sienna + gold), Meadow (forest + mint); **light**: Porcelain
(cool grey plates), Linen (warm cream + terracotta), Paper (white dial, electric
blue); **high-contrast**: HC Black (black/yellow/white) and HC White. Every
theme carries the same 7-role map (bg, ring1, ring2, hover, accent, text,
center) plus persona fields (`mode`, `stroke`, `edge`, `shadow`, `sheen`) and an
optional hand-tuned `chrome` block. Settings → Appearance renders the gallery
as mini wheels through the shared `buildWheel` renderer.

**Chrome derivation.** The Settings window skin is *derived* from the active
palette by `computeChrome` and injected as inline CSS vars on `<html>` with
`data-mode` (light/dark): the tonal ramp stacks up from `bg` toward `text` in
dark themes and down toward ink in light themes. Two derivations are sacred and
not overridable by any theme: the accent-deep pair is deepened until white text
clears 4.5:1, and `--dim` always clears 4.5:1 on the card step. Hand-tuned
`chrome` entries may only override surface/well tokens. The five original
presets keep the incumbent machined-midnight chrome verbatim.

**User themes** persist in `config.json` (`userThemes[]`, max 24) with an
`appearance.theme` reference `{id, customized, colors}`; editing a swatch flips
`customized` and the chip shows a modified dot with a one-click Reset.

**The Pilot Blue Rule.** The accent appears only where a user action is being invited, taken, or focused — primary buttons, active tab, focus rings, hover fills, slider outputs. It never decorates inactive content. Its rarity is what makes it read as "live."

**The No-Glow Rule.** The only permitted glow in the system is the 10px brand dot beside the sidebar title. Neon halos, acrylic blur frames, and illuminated edges — the gamer-HUD reflex — are banned outright.

## Typography

**Body/UI Font:** Segoe UI (system-ui fallback) — the Windows-native voice, one family across every role, weights 400/600/700 doing the hierarchy work.
**Icon Font:** Segoe Fluent Icons (Segoe MDL2 Assets fallback) — segment icons, hub icon, picker glyphs.
**Label/Mono Font:** Consolas — segment target values, inline code, file paths; anything that is machine truth renders in mono.

**Character:** engineered and legible, never expressive. Segoe UI at home on Windows is the point: the tool speaks the OS's language, and mono marks the seams where the machine shows through.

### Hierarchy
- **Headline** (700, 22px, −0.4px tracking): tab titles in the content header only — the iOS large-title cadence, at the edge of the −0.04em tracking floor.
- **Title** (700, 17px, +0.3px tracking): the sidebar brand wordmark; ring section headers step down at 15px/700 with −0.2px tracking.
- **Body** (400, 13.5px): the base UI voice, buttons inherit it; 14px on tab buttons (500 at rest, 600 when active).
- **Label** (400–600, 12–12.5px): form labels, hints, tags, muted metadata at 11–12px; the one uppercase-tracked label (11px, +1.2px) is reserved for the preview pane title alone.
- **Data/Mono** (400, 10.5–12px): segment paths, combo rows, code chips; slider outputs render with `tabular-nums`.

**The One Family Rule.** Segoe UI carries every text role; no second UI typeface enters Settings. Hierarchy is weight and size only, at a tight 1.12–1.2 step ratio — no display posturing inside a tool.

## Layout

Settings is a fixed three-column instrument: 210px navigation rail, 1fr content field (28px × 32px padding), 460px live-preview bay, separated by 1px hairline seams — sized for the desktop window it ships in, not fluid. Inside content, cards stack on a 14px gutter with 16px internal padding; rows within cards ride an 8px rhythm and use flexbox, reserving grid for true 2D cases (the four-column segment editor, two-column slider pairs, auto-fill color grid at 150px minimum). The wheel owns a polar layout: concentric rings on a 26px pad, gaps between segments at 3° default, labels capped to the arc length they fit.

Density is deliberate: grouped list rows are 10px × 12px, icon buttons stay mini (2px × 7px), and nothing gets a card nested in a card.

## Elevation & Depth

Hybrid, tonal-first. Surfaces at rest are flat: depth between regions is communicated by the midnight → panel → card → field ramp plus hairline borders — never shadows. Shadows exist only for objects that float above their context, and they say "this is closer to you," nothing else. On Windows 11 the sidebar/preview chrome adds a fourth depth tier underneath everything: real DWM acrylic behind translucent tint, never a self-drawn blur box.

### Shadow Vocabulary
- **Wheel drop** (`feDropShadow dy 6, stdDeviation 14, rgba(0,0,0,0.55)`): the entire wheel sits on this one deep diffuse drop; it is what makes the dial feel like an object over the desktop rather than a drawn overlay.
- **Float high** (`0 12px 32px rgba(0,0,0,0.55)`): dropdown/combo lists, the icon picker modal, and modal cards — the highest layer.
- **Float low** (`0 6px 20px rgba(0,0,0,0.4)`): toasts and ephemeral notices.
- **Pilot glow** (`0 0 10px` accent): the brand dot only.
- **Carved well** (`inset 0 1px 2px rgba(0,0,0,.35)`): inputs, selects, and the hotkey chip read as pressed into their surface.
- **Machined sheen** (`linear-gradient(180deg, rgba(255,255,255,.07), transparent 45%)` on buttons, `.022` on cards): the top-down light on solid matter; depth from light, never from glow.

The modal scrim (`rgba(5,8,11,.65)`) is the only full-viewport tint; everything else avoids translucency.

**The Float-Only Shadow Rule.** If a surface can be scrolled behind, hovered over, or dismissed, it may have a shadow. Static cards, rows, and panels are flat and carry a hairline instead. No element ships with both a 1px border and a wide soft drop shadow as decoration.

## Shapes

The form language is machined rectangles with small, disciplined corner radii: cards settle at 10px (the `--radius` invariant), modals at 12px, buttons and tabs at 8px, inputs at 7px, chips and type-tags as full pills (20px), mini controls at 6px. Nothing rounds past 12px except true pills — oversized 24–32px cards are AI chrome, not this system. The signature silhouette is the circle: the hub is a stroked disc, segments are true annular sectors separated by angular gaps, and the empty-state affordance is a dashed hairline outline — the one place a border becomes a shape statement.

## Components

### Buttons
- **Shape:** lightly rounded rectangles (8px, 6px at mini scale).
- **Material:** every fill carries the machined sheen — a top-down white-at-7% gradient over the solid color, lit from above.
- **Primary:** Accent Deep fill (`{colors.accent-deep}`), white text, 7px × 13px padding; hover lifts to Accent Deep Hi — never to full Pilot Blue under white text, which fails AA.
- **Hover / Press / Focus:** border steps to accent on secondary buttons with a 5% brightness lift; press is a quiet sink (`scale(.985)` + brightness .94, ≤100 ms ease-out, no bounce); focus stays visible via the same accent border used on inputs.
- **Secondary:** Button Slate fill, hairline border, ink text. **Danger:** text-only red on the default secondary body — destructive actions recede, they don't shout; hover steps the border to red. **Undo** reads as accent-colored text inside toasts.

### Switch (restyled checkbox)
- The native `input[type=checkbox]` keeps its semantics, keyboard behavior, and label association; only its skin is Apple: a 28×16 full-pill track (`scroll-thumb` slate at rest, Pilot Blue when checked, hairline border) with a 12px white knob that slides 12px on a 150 ms ease-out, knob shadow `0 1px 2px rgba(0,0,0,.35)`. Disabled at 45%.

### Slider
- 3px full-pill trough filled Pilot Blue to the thumb (`--fill` percentage stop, updated in JS), slate beyond it; 14px pure-white circular thumb with `0 1px 4px rgba(0,0,0,.45)`, scaling 1.08→1.14 on hover/press; keyboard focus paints an accent outline on the knob.

### Chips / Tags
- **Style:** Button Slate background, muted text, 1px hairline, full-pill radius (20px); used for action-type tags on segment rows.
- **Preset chips:** full pill (999px) with the quiet card sheen; the live palette's matching preset is `.active` — accent border, hover-well fill, inner accent ring at 25%, semibold label.

### Cards / Containers
- **Corner Style:** 10px throughout.
- **Background:** Card on the content field, Panel for chrome regions; both carry the quiet card sheen (white at 2.2% fading by 60%).
- **Shadow Strategy:** flat at rest (see Float-Only Shadow Rule); hairline seam only.
- **Internal Padding:** 16px; section heads sit 10px above content.

### Grouped inset list (segment rows)
The iOS grouped-list pattern, CSS-only: one `.seg-list` container owns the card surface (1px hairline, 10px radius, `overflow: clip`); `.seg-row`s are borderless flush siblings separated by 1px hairline `border-top`s — never nested cards, never gapped rounded rows. Hover washes the row to `hover-well`; the expanded editor hangs below its row on the Edit Well fill behind its own hairline.

### Inputs / Fields
- **Style:** Field-well background, hairline border, 7px radius, 7px × 9px padding, carved with an inner top shadow; checkboxes render as the Switch above and ranges as the Slider above.
- **Focus:** border steps to accent and a 3px **Focus Halo** (`{colors.focus-halo}`) rings the field — one state, both properties.
- **Error:** dedicated red banner block (`#3a1d1d` well, Signal Red border, light-red text) rather than per-field tinting.

### Navigation
- Sidebar rail of tab buttons: muted ink at rest, hover steps to a slate wash with full ink, active flips to Accent Deep with white — selection is unmistakable and the accent appears in exactly one nav item at a time.

### Signature: The Radial Wheel
The hero component, shared renderer between overlay and Settings preview (`wheel-core.js`). Annular segments on two tinted plates with 1px white-at-6% strokes, unified under one machined-light pass: an off-center radial specular wash (white at 6% at the upper-left, fading by the 100% stop) over the whole dial, a 1px white-at-8% rim on the outer edge, and a lit crown on the hub — three decorative SVG discs (`top-light`, `rim`, `hub-top`), pointer-transparent, never per-segment gradients. Hover dims all other segments to 55% and nudges the active one outward along its radius with spring overshoot (`cubic-bezier(.34,1.56,.64,1)`, 120ms) while its icon brightens 18% — no glow — and the hub reports its icon and label. Summon runs a scale 0.86→1 pop (default 160ms, user-tunable 0–400ms). Hub and center labels carry +0.4/+0.8px tracking at 600 weight. Per-item color overrides recolor a single segment. The preview pane reproduces the real renderer inside a radial-gradient well with a lit inner lip so configuration is exactly what ships.

**The Snap-Back Rule.** Spring overshoot belongs to the wheel alone — its hover nudge and its summon pop, which DESIGN's Overview names as the system's signature motion. Every other transition in the system is an ease or ease-out under 200 ms; a button that bounces is a button that lies about what it is.

## Do's and Don'ts

### Do:
- **Do** keep the tonal ramp honest: canvas → panel → card → field must each stay distinguishable from its neighbor, and muted text must clear 4.5:1 on its actual background — verify, don't assume.
- **Do** keep the deeper→lighter order for accent surfaces, and always put white text on the Accent Deep pair for action fills — full Pilot Blue under white text fails AA and is for focus, outputs, and links only.
- **Do** give every interactive control the full state set: default, hover, focus, active, disabled — the toast-with-undo pattern is the model for forgiving, one-step-back feedback.
- **Do** route all icons through Segoe Fluent Icons with the MDL2 fallback, sized to their surface (22px picker / 19px rows / scaled hub).
- **Do** let the wheel preview and the real wheel share one renderer, always.
- **Do** gate every translucent chrome layer on the main-process vibrancy check (`<html data-vibrant>`) and honor `prefers-reduced-transparency` by staying solid; verify muted text contrast over the rendered tint, not the token.
- **Do** honor `prefers-reduced-motion`: the pop and spring degrade to instant or crossfade without losing the affordance.

### Don't:
- **Don't** add glow, neon, or self-drawn acrylic/HUD blur frames anywhere the brand dot isn't — the confirmed anti-reference. The only permitted translucency is the gated DWM acrylic chrome above.
- **Don't** let translucency touch content, floating layers, or the wheel plates — acrylic is chrome, everything the user acts on is solid.
- **Don't** put a drop shadow on static surfaces; borders belong to static cards, shadows to floating layers — not both on one element.
- **Don't** exceed 12px radius on cards, modals, or panels (pills exempt).
- **Don't** introduce a second UI typeface or a display font in any label, button, or data row.
- **Don't** paint empty states or hints in gray so light it drops below AA contrast on the midnight ramp; `#8fa3b5` on `#161f29` is already the floor.
- **Don't** decorate the wheel — its expression budget is motion and material, not texture or imagery.
