---
name: verify
description: "Launch Nucleus (formerly radial-wheel) and capture runtime evidence that a change actually works: process hygiene, log markers, config/state files, overlay and hotkey behavior checks."
whenToUse: "After any change to src/ in the Nucleus project, before declaring work done. For finding out why something breaks, use the debug skill instead."
---

# Verify mode

"Ran without an error" is not proof. Collect runtime evidence from the real app before calling a change good.

## 1. Clean process state

- The app holds a single-instance lock (`src/main/main.js:123`): with a live instance already running, a new launch quits silently and every later check is meaningless.
- Check first: `Get-Process -Name electron, Nucleus* -ErrorAction SilentlyContinue`.
- Kill stale dev instances (`Stop-Process`) — or exploit the second-instance behavior as a live probe: `electron . --show-wheel` against a running app makes the wheel pop (`main.js:128-131`).

## 2. Launch with logs

- `npm run start` — foreground terminal; watch for the ready marker
  `[nucleus] ready — hotkey '<spec>' registered` (or `FAILED: ...`) (`src/main/main.js:117`).
  No marker at all = startup crashed; capture the whole console output before touching anything.
- `npm run start:hidden` — realistic always-on launch (wscript, detached, stdio discarded); use it for UX checks, but prefer the foreground run when you need log evidence.

## 3. State locations (all under `%APPDATA%\Nucleus\`; the pre-rename `%APPDATA%\Radial Wheel\` is copied once on first launch by `src/main/migrate.js`)

- `config.json` — the config store; external edits are hot-reloaded through a debounced watcher (`src/main/config.js:232-243`), so test live reload by editing this file directly.
- `config.json.bad` — appears when config parsing failed and defaults were restored (`config.js:189`). Its presence after your change = regression.
- `state.json` — persisted settings-window bounds; `icons/` — runtime-generated icons.

## 4. Behavior checklist (exercise what your diff touches)

- Hotkey: try registering a key owned by another app — expect the tray balloon error and the previous hotkey restored (`main.js:26-39`, `hotkeys.js:59-61`).
- Overlay: shows at cursor, self-dismisses on blur except inside the 350 ms grace (`src/main/windows.js:34-38`), Escape dismisses (`windows.js:39-44`), re-trigger hides when `behavior.reTriggerToggles` is set (`main.js:41-45`).
- Actions: click one wheel item per touched type; key-synthesis actions (macro, sys volume/lock) must land in the formerly focused app — the 120 ms focus-regain delay lives in `src/main/ipc.js:25-27`.
- Renderer: `devTools: !app.isPackaged` — DevTools are available in overlay/settings windows in dev mode.

## 5. Evidence rules

- For each acceptance point, state the exact action and the observed output (log line, file diff, screenshot). Never claim fixed behavior from reading code alone.
- Teardown: quit via tray menu or settings quit; confirm no leftover electron processes; remove scratch files and restore any temporary `config.json` edits.
