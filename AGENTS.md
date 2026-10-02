# Project agent instructions — radial-wheel

## Mouse/keyboard take-over: always prompt first

Never run anything that physically takes control of the user's mouse or
keyboard without asking for explicit confirmation first. State the exact
command and what it will do to the cursor/keyboard, then wait for the user's
go-ahead.

This covers, at minimum:

- Any `SetCursorPos`, `mouse_event`, or mouse `SendInput` call — including the
  test harnesses that use them:
  - `tests/click-at.js` (koffi `SendInput`)
  - `tests/click-e2e.ps1`, `tests/click-e2e-app.ps1`, `tests/pixel-check.ps1` (`SetCursorPos` + clicks)
- Any ad-hoc PowerShell/Node snippet that injects input via `user32.dll`.
- Driving the app's own input injection end-to-end, e.g. launching radial-wheel
  and triggering a `macro` action (`src/main/macro.js`, `SendInput` via koffi).
- Keyboard injection falls under the same rule — it can steal focus from
  whatever window the user is working in.

Read-only inspection, unit tests with stubbed SendInput (e.g.
`tests/unit/sys-actions.test.js`), builds, lint, and app launch *without*
triggering injection do not require the prompt.

The guard is the agent asking first — there is no built-in confirmation gate in
the code itself. If a hard gate is ever wanted, it would need to be implemented
(e.g. a confirmation dialog before macro injection in `src/main/macro.js`).
