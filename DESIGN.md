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
typography:
  headline:
    fontFamily: "'Segoe UI', system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 700
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
---

# Design System: Radial Wheel

## Overview

**Creative North Star: "The Machined Object"** — an Apple-inspired physical system. Every surface reads as real material on a dark desk: machined edges lit from above, controls that press, a dial that springs under the finger. Depth comes from light and shadow on solid matter, never from glow.

Machined midnight hardware. The Settings window is a well-built instrument panel — three deliberate columns, dense but breathable rows, hairline seams instead of decoration. The wheel itself is the product's hero object: a two-ring dial of tinted metal plates at the cursor, popping in with weight and springing under hover. Color is nearly absent from the chrome and precisely present where it means something — Pilot Blue for the thing you're about to act on.

**Key Characteristics:**
- One family, five weights: Segoe UI carries everything; Segoe Fluent Icons is the only pictographic voice; Consolas marks machine truth (paths, values, code).
- Tonal midnight ramp (bg → panel → card → field) with hairline borders; shadows reserved exclusively for floating objects.
- A single accent — Pilot Blue — speaking for selection, focus, and primary action.
- Motion with physics: the wheel's 160 ms pop and spring-hover overshoot are the system's signature; everything else stays under 200 ms.
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

### Wheel plates (config-owned)
The overlay's ring fills (**Ring Inner**, **Ring Outer**, **Wheel Center**) are user-configurable at runtime and follow the same tonal logic: darker toward the hub, lighter per ring step, 1px white-at-6% edge strokes, hub ring stroked in the accent at 22% opacity.

### Runtime theme presets
Five complete color sets ship in Settings → Appearance (`settings.js` `PRESETS`; the source of truth, not duplicated in tokens): **Midnight** (default, blue-black + Pilot Blue), **Ocean** (deep teal + cyan), **Grape** (violet), **Graphite** (near-neutral light-on-dark inversion), **Ember** (warm rust + amber). All follow the same role map: bg, ring1, ring2, hover, accent, text, center.

**The Pilot Blue Rule.** The accent appears only where a user action is being invited, taken, or focused — primary buttons, active tab, focus rings, hover fills, slider outputs. It never decorates inactive content. Its rarity is what makes it read as "live."

**The No-Glow Rule.** The only permitted glow in the system is the 10px brand dot beside the sidebar title. Neon halos, acrylic blur frames, and illuminated edges — the gamer-HUD reflex — are banned outright.

## Typography

**Body/UI Font:** Segoe UI (system-ui fallback) — the Windows-native voice, one family across every role, weights 400/600/700 doing the hierarchy work.
**Icon Font:** Segoe Fluent Icons (Segoe MDL2 Assets fallback) — segment icons, hub icon, picker glyphs.
**Label/Mono Font:** Consolas — segment target values, inline code, file paths; anything that is machine truth renders in mono.

**Character:** engineered and legible, never expressive. Segoe UI at home on Windows is the point: the tool speaks the OS's language, and mono marks the seams where the machine shows through.

### Hierarchy
- **Headline** (700, 20px): tab titles in the content header only.
- **Title** (700, 17px, +0.3px tracking): the sidebar brand wordmark; ring section headers step down at 15px/700.
- **Body** (400, 13.5px): the base UI voice, buttons inherit it; 14px on tab buttons.
- **Label** (400–600, 12–12.5px): form labels, hints, tags, muted metadata at 11–12px; the one uppercase-tracked label (11px, +1.2px) is reserved for the preview pane title alone.
- **Data/Mono** (400, 10.5–12px): segment paths, combo rows, code chips.

**The One Family Rule.** Segoe UI carries every text role; no second UI typeface enters Settings. Hierarchy is weight and size only, at a tight 1.12–1.2 step ratio — no display posturing inside a tool.

## Layout

Settings is a fixed three-column instrument: 210px navigation rail, 1fr content field (26px × 30px padding), 460px live-preview bay, separated by 1px hairline seams — sized for the desktop window it ships in, not fluid. Inside content, cards stack on a 14px gutter with 16px internal padding; rows within cards ride an 8px rhythm and use flexbox, reserving grid for true 2D cases (the four-column segment editor, two-column slider pairs, auto-fill color grid at 150px minimum). The wheel owns a polar layout: concentric rings on a 26px pad, gaps between segments at 3° default, labels capped to the arc length they fit.

Density is deliberate: list rows are 9px × 12px, icon buttons stay mini (2px × 7px), and nothing gets a card nested in a card.

## Elevation & Depth

Hybrid, tonal-first. Surfaces at rest are flat: depth between regions is communicated by the midnight → panel → card → field ramp plus hairline borders — never shadows. Shadows exist only for objects that float above their context, and they say "this is closer to you," nothing else.

### Shadow Vocabulary
- **Wheel drop** (`feDropShadow dy 6, stdDeviation 14, rgba(0,0,0,0.55)`): the entire wheel sits on this one deep diffuse drop; it is what makes the dial feel like an object over the desktop rather than a drawn overlay.
- **Float high** (`0 12px 32px rgba(0,0,0,0.55)`): dropdown/combo lists and the icon picker modal — the highest layer.
- **Float low** (`0 6px 20px rgba(0,0,0,0.4)`): toasts and ephemeral notices.
- **Pilot glow** (`0 0 10px` accent): the brand dot only.

The modal scrim (`rgba(5,8,11,.65)`) is the only full-viewport tint; everything else avoids translucency.

**The Float-Only Shadow Rule.** If a surface can be scrolled behind, hovered over, or dismissed, it may have a shadow. Static cards, rows, and panels are flat and carry a hairline instead. No element ships with both a 1px border and a wide soft drop shadow as decoration.

## Shapes

The form language is machined rectangles with small, disciplined corner radii: cards settle at 10px (the `--radius` invariant), modals at 12px, buttons and tabs at 8px, inputs at 7px, chips and type-tags as full pills (20px), mini controls at 6px. Nothing rounds past 12px except true pills — oversized 24–32px cards are AI chrome, not this system. The signature silhouette is the circle: the hub is a stroked disc, segments are true annular sectors separated by angular gaps, and the empty-state affordance is a dashed hairline outline — the one place a border becomes a shape statement.

## Components

### Buttons
- **Shape:** lightly rounded rectangles (8px, 6px at mini scale).
- **Primary:** Accent Deep fill (`{colors.accent-deep}`), white text, 7px × 13px padding; hover lifts to Accent Deep Hi — never to full Pilot Blue under white text, which fails AA.
- **Hover / Focus:** border steps to accent on secondary buttons; focus stays visible via the same accent border used on inputs.
- **Secondary:** Button Slate fill, hairline border, ink text. **Danger:** text-only red on the default secondary body — destructive actions recede, they don't shout. **Undo** reads as accent-colored text inside toasts.

### Chips / Tags
- **Style:** Button Slate background, muted text, 1px hairline, full-pill radius (20px); used for action-type tags on segment rows.

### Cards / Containers
- **Corner Style:** 10px throughout.
- **Background:** Card on the content field, Panel for chrome regions.
- **Shadow Strategy:** flat at rest (see Float-Only Shadow Rule); hairline seam only.
- **Internal Padding:** 16px; section heads sit 10px above content.

### Inputs / Fields
- **Style:** Field-well background, hairline border, 7px radius, 7px × 9px padding; checkbox and range controls carry `accent-color` in Pilot Blue.
- **Focus:** border color steps to accent — a quiet, single-property change.
- **Error:** dedicated red banner block (`#3a1d1d` well, Signal Red border, light-red text) rather than per-field tinting.

### Navigation
- Sidebar rail of tab buttons: muted ink at rest, hover steps to a slate wash with full ink, active flips to Accent Deep with white — selection is unmistakable and the accent appears in exactly one nav item at a time.

### Signature: The Radial Wheel
The hero component, shared renderer between overlay and Settings preview (`wheel-core.js`). Annular segments on two tinted plates with 1px white-at-6% strokes; hover dims all other segments to 55% and nudges the active one outward along its radius with spring overshoot (`cubic-bezier(.34,1.56,.64,1)`, 120ms), while the hub reports its icon and label. Summon runs a scale 0.82→1 pop (default 160ms, user-tunable 0–400ms). Per-item color overrides recolor a single segment. The preview pane reproduces the real renderer inside a radial-gradient well so configuration is exactly what ships.

**The Snap-Back Rule.** Spring overshoot belongs to the wheel alone — its hover nudge and its summon pop, which DESIGN's Overview names as the system's signature motion. Every other transition in the system is an ease or ease-out under 200 ms; a button that bounces is a button that lies about what it is.

## Do's and Don'ts

### Do:
- **Do** keep the tonal ramp honest: canvas → panel → card → field must each stay distinguishable from its neighbor, and muted text must clear 4.5:1 on its actual background — verify, don't assume.
- **Do** keep the deeper→lighter order for accent surfaces, and always put white text on the Accent Deep pair for action fills — full Pilot Blue under white text fails AA and is for focus, outputs, and links only.
- **Do** give every interactive control the full state set: default, hover, focus, active, disabled — the toast-with-undo pattern is the model for forgiving, one-step-back feedback.
- **Do** route all icons through Segoe Fluent Icons with the MDL2 fallback, sized to their surface (22px picker / 19px rows / scaled hub).
- **Do** let the wheel preview and the real wheel share one renderer, always.
- **Do** honor `prefers-reduced-motion`: the pop and spring degrade to instant or crossfade without losing the affordance.

### Don't:
- **Don't** add glow, neon, or acrylic/HUD chrome anywhere the brand dot isn't — the confirmed anti-reference.
- **Don't** put a drop shadow on static surfaces; borders belong to static cards, shadows to floating layers — not both on one element.
- **Don't** exceed 12px radius on cards, modals, or panels (pills exempt).
- **Don't** introduce a second UI typeface or a display font in any label, button, or data row.
- **Don't** paint empty states or hints in gray so light it drops below AA contrast on the midnight ramp; `#8fa3b5` on `#161f29` is already the floor.
- **Don't** decorate the wheel — its expression budget is motion and material, not texture or imagery.
