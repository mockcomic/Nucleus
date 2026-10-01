---
name: apple-ui-design
description: "Apple-inspired UI/UX discipline: clarity, deference, depth, hierarchy, design tokens, interaction states, accessibility, and premium design-review tests for any interface work."
whenToUse: "When creating or modifying any UI (screens, components, HTML/CSS), when reviewing a screenshot or mockup, when no design is provided, or when asked for premium/Apple-quality polish."
---

# Apple-inspired UI/UX design

Design and implement polished, intuitive, premium interfaces. The goal is not to clone Apple applications pixel-for-pixel — create interfaces that feel intentional, elegant, calm, responsive, and immediately understandable. The user should notice the product, not the UI framework used to build it.

## Start from intent, not style

Never begin with cards, sidebars, dashboards, gradients, toolbars, or a component library. Those are implementation decisions, not the design. Begin with the user's intent: the interface exists to make the user's task feel obvious, direct, and effortless.

Every interface must answer:

1. What is the primary thing the user wants to do?
2. What information deserves the most attention?
3. What can be removed?
4. What can be progressively disclosed instead of shown immediately?
5. Can a first-time user understand the interface without instructions?
6. Does every visual element serve a purpose?
7. Does the interface feel cohesive as a complete product?

Preferences: simplicity over feature density; obvious interactions over clever interactions; hierarchy over decoration; whitespace over unnecessary borders; fewer high-quality elements over many mediocre ones.

When no design is provided, build in this order: user goal → information architecture → layout → interaction model → component hierarchy → typography → spacing → color → motion → polish. Do not begin by choosing colors or adding decoration.

## Core principles

- **Clarity.** The user immediately understands where they are, what they can do, what is selected, what changed, what requires attention. Use hierarchy before decoration: clear labels, recognizable controls, readable typography, consistent alignment, strong grouping.
- **Deference.** Content receives more visual emphasis than chrome. Controls are prominent only when needed. Remove unnecessary borders, containers, toolbars, labels, icons, backgrounds, ornamentation. A successful interface can feel sophisticated while remaining visually quiet.
- **Depth.** Use layering, scale, movement, translucency, elevation, spatial transitions to explain relationships — never as decoration. A popover feels above content because it temporarily sits above the content hierarchy; a sheet feels connected to the workflow that produced it.
- **Direct manipulation.** Let users manipulate the object they care about: drag to reorder, click to edit in place, resize panels directly, preview changes immediately. Avoid configuration screens when interaction can occur in context.
- **Familiarity.** Buttons behave like buttons, fields like text fields, menus like menus. Do not redesign standard controls to appear unique; innovate on the user's task, not on basic interactions.
- **Consistency.** Similar things look and behave alike across spacing, typography, control sizes, icons, states, menus, navigation, terminology, animation. Two elements with the same function share the same component. No one-off visual patterns without a strong UX reason.
- **Progressive disclosure.** Present the simplest useful interface first; reveal advanced controls contextually (Basic → More Options → Advanced). Rare actions live in context menus, overflow menus, inspectors, advanced panels. The primary interface stays calm.
- **Content first.** Identify what the user came to see and do; build the screen around those answers.
- **Reduce cognitive load.** Recognition over recall. Expose relevant actions near the object they affect, use sensible defaults, preserve state, never re-ask for information the system already knows.
- **Hierarchy.** Visually distinguish primary content, primary action, secondary information, secondary actions, tertiary controls, destructive actions. Not everything has equal weight. Use typography, spacing, position, contrast before any decorative styling.
- **Restraint.** Before adding something, ask whether removing something solves the same problem. Premium design comes from careful proportions and restraint, not more effects.
- **Spatial consistency.** Treat the interface as physical space: objects emerge from logical locations, transitions preserve spatial relationships, a detail panel stays visually connected to the selected item, a sidebar collapse preserves the user's sense of where navigation went.
- **Motion explains change.** Animate appearance/disappearance, hierarchy, navigation, selection, expansion, success/error — subtly and responsively. Never make the user wait for decorative animation; the interface stays usable immediately. Respect reduced-motion.
- **Immediate feedback.** Every interaction acknowledges the user: button press changes state instantly, dragged objects follow the pointer, saving confirms visibly, selection is visible, invalid inputs explain the problem. Users never wonder whether input was received.
- **Forgiveness.** Prefer reversible actions, provide undo where practical, confirm only when consequences are hard to reverse, avoid confirmations for harmless actions, preserve work after errors.
- **Platform respect.** Do not force one platform's interaction model onto another (see Accessibility & responsive section).

When several designs are possible, prefer the one that requires the least explanation, exposes the least unnecessary complexity, preserves familiar behavior, emphasizes content, gives immediate feedback, minimizes cognitive load, remains accessible, and feels natural for the platform. Never choose a design simply because it looks more impressive.

## Visual hierarchy budget

Every screen must have a clear hierarchy — the user understands its purpose within ~2 seconds:

- 1 primary screen title
- 1 primary action where appropriate
- 2–4 secondary actions maximum
- clearly grouped supporting information
- low-emphasis tertiary controls

Do not make every element visually important. Communicate importance with size, weight, spacing, contrast, position. Avoid excessive borders, separators, shadows, gradients, badges, colors, icons, competing buttons.

## Scales & values

**Spacing — 8-point system.** 4px extremely tight · 8px related elements · 12px compact controls · 16px standard · 24px group separation · 32px section separation · 48px major separation · 64px+ page structure. Never place elements arbitrarily; align to consistent visual anchors.

**Content widths (desktop).** Forms 480–640px · Settings 640–800px · Standard app content 900–1200px · Dashboards up to 1440px only when necessary. Cap readable width; never stretch content across very wide screens.

**Typography.** Clean system stack, e.g. `-apple-system, BlinkMacSystemFont, "SF Pro Text", "SF Pro Display", "Segoe UI", sans-serif` — do not require proprietary Apple fonts. Typography creates hierarchy before color or decoration. Limit to ~4–6 styles app-wide:

- Large Title 32–40px / 600–700
- Title 24–28px / 600–700
- Section Heading 18–22px / 600
- Body 14–17px / 400
- Secondary 13–15px / 400
- Caption 11–13px / 400–500

Line height ~1.25–1.4 for UI text, ~1.45–1.65 for longer prose.

**Color.** Start with neutrals; color communicates action, status, selection, hierarchy, feedback — never merely makes the UI look interesting. Use semantic tokens, support light and dark themes, never hardcode dozens of unrelated colors: `--background`, `--surface`, `--surface-elevated`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--separator`, `--accent`, `--success`, `--warning`, `--danger`. Establish tokens before substantial implementation and extend them rather than introducing arbitrary values:

```css
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-6: 24px;
  --space-8: 32px;

  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;

  --control-height: 40px;

  --font-body: 15px;
  --font-caption: 13px;
  --font-heading: 20px;
  --font-title: 28px;
}
```

**Surfaces.** Subtle hierarchy between surfaces: Application Background → Sidebar/Navigation → Content Surface → Elevated Card/Popover → Modal. Avoid card-based-everything: cards only when information genuinely represents a distinct object or group.

**Corner radius.** Small controls 6–8px · buttons/inputs 8–10px · cards 12–16px · large panels/modals 16–24px. Nested elements get smaller radii than their containers; never one large radius on everything.

**Shadows.** Sparingly, for layering only: popovers, menus, floating panels, modals, draggable objects. Static content relies on spacing, contrast, surface color — not dramatic drop shadows.

**Motion.** Fast feedback 100–150ms · standard transitions 180–250ms · large transitions 250–400ms · never >~500ms for routine interactions. Natural easing. No bouncing everything, gratuitous scale, excessive parallax, dramatic page transitions, or animation that delays interaction.

**Control sizes.** Desktop control height 36–44px; touch 44px+; touch targets at least 44×44px.

## Component & screen patterns

- **Buttons.** One obvious primary action per screen. Hierarchy: primary (accent color) → secondary (subdued surface) → tertiary/text or icon → destructive (must not compete with normal primaries unless the screen's explicit purpose). Never several equally emphasized primaries side by side.
- **Icons.** Simple, recognizable, one coherent library (Lucide, Heroicons, restrained Material Symbols). Shared stroke weight and proportions, aligned to a grid, labeled when meaning isn't obvious. Don't invent obscure icons when text is clearer; don't mix styles; no emoji as primary UI icons unless the product deliberately uses that language.
- **Navigation.** Reflect the user's mental model, not internal architecture. Desktop: Sidebar → Section → Content → Inspector when necessary. Keep ≤5–7 top-level destinations, avoid deep nesting; selected items clearly visible without excessive contrast.
- **Sidebars.** Lightweight: restrained contrast, simple iconography, concise labels, clear selected state, generous vertical spacing, grouped where helpful. Never a dense control panel.
- **Toolbars.** Frequent actions only, grouped by relation; rare actions go to overflow menus, context menus, settings, inspectors. Separate destructive from routine.
- **Forms.** Effortless to scan: Label / Input / Supporting text-or-error, not complicated arrangements. Comfortable hit targets. Avoid placeholder-only labels. Clear validation messages, shown only after meaningful interaction unless necessary.
- **Settings.** Grouped, not a wall of controls: section title, short explanation, setting rows; separate groups with whitespace. Toggles only for immediate binary changes; buttons when an action must occur; selects for choosing among several values.
- **Modals.** Only when the user must focus on a decision or contained task: confirmation, focused creation, destructive actions, authentication, short configuration. Bad for large information, navigation, long workflows, hiding ordinary content. One clear primary action.
- **Progressive disclosure examples.** "Advanced Settings", "Show Details", "More Options", expandable inspector panels, contextual controls.
- **Component architecture.** Build reusable primitives — Button, IconButton, Input, Textarea, Select, Checkbox, Radio, Toggle, SegmentedControl, Slider, Card, List, ListRow, Sidebar, Toolbar, Tabs, Popover, Menu, Modal, Sheet, Tooltip, Toast, Progress, Skeleton, EmptyState — and assemble screens from them instead of styling every screen independently.

## States & feedback

Every significant control and screen considers: default · hover · active/pressed · focus · selected · loading · empty · error · disabled · success. An interface never makes the user wonder whether their interaction worked — include drag and drop-target feedback too.

- **Empty states.** Never blank screens. Explain: 1) what belongs here, 2) why it is currently empty, 3) what the user can do next. Concise. Example: "No projects yet — Projects you create will appear here. [Create Project]".
- **Loading.** Prefer skeleton UI or localized progress indicators over blocking the whole application. No full-screen spinner unless absolutely necessary. Preserve existing content while refreshing whenever possible.
- **Errors.** Explain what happened, what the user can do, whether their data is safe. Bad: "Error 1024". Good: "Project couldn't be saved. Your changes are still available. Try saving again." Technical details behind an expandable section.

## Accessibility & responsive

Accessibility is mandatory: keyboard navigation, visible focus states, screen readers, sufficient contrast, scalable typography, reduced motion, meaningful labels, logical tab order. Never rely solely on color to communicate state.

Responsive behavior is re-deciding essentials, not shrinking: Desktop = full navigation + content + optional inspector · Tablet = condensed navigation + content · Mobile = single primary content flow with navigation in mobile patterns. Prioritize content over controls.

Platform checklists — desktop apps support keyboard shortcuts, context menus, drag & drop, resizable panes, persistent navigation, appropriate information density, multi-selection, undo/redo, predictable menus (and must not feel like enlarged mobile apps). Touch prioritizes large targets, direct gestures, simple navigation, thumb-friendly controls. Web preserves back/forward navigation, URL-addressable screens where appropriate, keyboard navigation, responsive layouts, sensible loading states, browser zoom, accessibility semantics — and does not disable expected browser behavior without a strong reason.

## Process — before implementing a screen

1. **Identify the goal** in one sentence ("The user needs to choose a project and resume working.").
2. **Identify hierarchy**: primary information, secondary information, primary action, secondary actions, rare actions.
3. **Remove unnecessary elements**: can this control be eliminated? be automatic? move into a context menu? appear only when relevant?
4. **Design states** (see States & feedback).
5. **Implement** — only after the basic hierarchy is clear.

## Review — before declaring UI done

**UI review checklist.** Hierarchy: is the primary purpose identified immediately? Spacing: are related elements closer than unrelated ones? Alignment: consistent anchors? Typography: too many sizes/weights? Color: meaning rather than decoration? Components: are repeated elements consistent? Interaction: hover/focus/pressed/loading/disabled implemented? Accessibility: usable without a mouse? Complexity: can anything be removed? Polish: does it feel finished rather than merely functional?

**AI Dashboard Test.** Does it look like a generic AI-generated UI? Warning signs: every element is a card · every card has a border · every card has a shadow · everything has 16–24px radius · large gradient header · glowing purple/blue accent · arbitrary analytics charts · excessive badges · excessive pill-shaped buttons · three-column dashboard without a UX reason. If these appear without justification, redesign.

**Apple-quality test.** Would a professional product team ship this? Does every element feel intentional? Is anything visually noisy? Can anything be removed? Is the main action obvious? Are spacing and typography consistent? Does interaction feel immediate? Does the interface respect the platform? Does it still look good with all decorative effects removed? If any answer is no, refine.

## Anti-patterns

Do NOT automatically create: gradients everywhere · glassmorphism everywhere · glowing borders · giant hero sections inside applications · excessive cards · excessive pills · oversized rounded corners · floating containers inside floating containers · dozens of accent colors · unnecessary dashboards · unnecessary charts · icon-only controls with unclear meaning · animations purely for decoration · excessive shadows · excessive blur · random spacing values · tiny text · placeholder-only forms.

## Agent behavior

When asked to create or modify UI:

1. Inspect the existing application's visual language.
2. Preserve good existing patterns.
3. Identify UX problems before changing styling.
4. Establish the screen's hierarchy.
5. Reuse existing components whenever possible.
6. Introduce design tokens instead of arbitrary CSS values.
7. Implement responsive behavior.
8. Implement interaction states.
9. Implement accessibility.
10. Review the finished UI against this skill.

Do not perform a complete visual rewrite when a smaller improvement solves the problem. Do not sacrifice usability for an aesthetic.

**Given a screenshot or mockup:** analyze layout, hierarchy, spacing, typography, color, grouping, alignment, interaction model, responsiveness. Reproduce the intent and structure rather than blindly tracing pixels. If the reference has usability problems, improve them while maintaining the intended aesthetic.

## Project note — radial-wheel

In this repo, `DESIGN.md` is the source of truth for palette and typography tokens (machined-midnight theme, `pilot-blue` accent, Segoe UI stack, vibrancy/hairline conventions). Apply this skill's hierarchy, restraint, state, and review discipline on top of those tokens. Do not import a generic light-theme token block or an alien accent color that contradicts `DESIGN.md`; extend its existing tokens instead.
