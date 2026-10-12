---
name: security-audit
description: "Whole-tree vulnerability audit of radial-wheel: webPreferences/CSP baseline on every window, IPC PRIVILEGED-map contract diff, spawn/shell discipline, config-import and icon-URL validation, autostart/SendInput invariants, dependency freshness."
whenToUse: "When asked for a security or vulnerability check of the project, before shipping a release, or after touching ipc.js, preload/index.js, actions.js, sys.js, config.js, custom-icons.js, macro.js, autostart.js, or any BrowserWindow site. For a pre-completion diff review use the review skill; for the packaging ritual use release-check."
---

# Security audit

Read-only passes over the whole tree. Report findings with `file:line`, ranked Critical / High / Low, plus an explicit list of what was checked and found clean. No silent fixes — propose and wait.

## Threat model (what makes this app unusual)

- The app is always-on and launches actions assembled from `%APPDATA%\Nucleus\config.json` — any medium-integrity process can edit that file, so the entire config is semi-trusted input at read time; `validate()` and the launch-side restrictions in actions.js are the actual security boundary.
- Renderer pages are assumed compromised: every IPC payload, item shape, and URL arriving from a window is hostile. The sender-frame gate in ipc.js is the first line of defense.
- The koffi FFI layer can inject keystrokes machine-wide (SendInput). Unvalidated input injection is automatically Critical.

## Pass 1 — Electron baseline on every window

1. Grep `new BrowserWindow` (path `src`). Every site must carry `preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: true` — today that is the overlay/settings windows in `src/main/windows.js` and the welcome window in `src/main/welcome.js`. A window added without the full set: High.
2. `devTools` must stay `!app.isPackaged`. Grep `webSecurity|allowRunningInsecureContent` — any override: Critical.
3. Every `src/renderer/**/index.html` must have the CSP meta (`default-src 'none'; script-src 'self'; …`). Settings additionally allows `img-src … https:` — flag any *new* relaxation (or a missing tag), not the existing three known shapes.

## Pass 2 — IPC contract diff (the classic drift bug)

1. Enumerate every `ipcMain.handle(` / `ipcMain.on(` in `src/main/ipc.js`, and read the `PRIVILEGED` map + `SEND_CHANNELS` set at the top of `registerIpc`.
2. Every channel that mutates state (config, hotkey, autostart, dialogs, fs access, network, quit) must appear in `PRIVILEGED` with the owning page list. Ungated write-capable channel: Critical.
3. Cross-reference `src/preload/index.js` surfaces (`wheelSurface`, `settingsSurface`, `welcomeAPI`): every bridged channel has a handler, and every privileged bridge sits on the surface whose page legitimately needs it. A capability bridged to the overlay/welcome world: High.
4. Confirm the gate itself is intact: `frameOn` matches `/renderer/<page>/` in `ev.senderFrame.url`, and `refused()` still returns an `{ok:false}` shape on gated invoke channels (not `undefined` masquerading as success).

## Pass 3 — Spawn and shell discipline

1. Enumerate process usage: grep `child_process|spawn\(|exec\(` (path `src`). Known-good inventory: `actions.js` (`launchDetached`, `runShellCommand`, the cmd.exe `start ""` paths), `sys.js` (`spawnDetached`), `windows.js` and `apps.js` (fixed-arg `reg`/`reg.exe` queries).
2. `shell: true` is sanctioned in exactly one place — `runShellCommand` in actions.js, reached only by the `command` action type after the `.bat`/`.cmd`/`.ps1` branches. Any new `shell:true`: Critical unless justified in writing.
3. Every `cmd.exe` invocation keeps the `/d /s /c` flags and `start ""` with the target as a *separate argv element* — string-concatenating user text into a command line: Critical. `.ps1` launches must not add `-ExecutionPolicy Bypass` (running under machine policy is a deliberate security property).
4. `shell.openExternal` sites: the `url` action sanitizes the scheme via regex and defaults to `https://`; `sys.js` must stay allowlist-only — new `sys.run` cases may only spawn fixed system binaries with argv built from the `CATALOG`/`ALIAS`/`IDS` sets, and the `KEY_ACTIONS` set must stay in sync with the `sendChord`/`sendVk` cases in the switch.

## Pass 4 — Untrusted-data ingestion

1. Every path into config (`config:set`, `config:import`, `config:reset`, `welcome:done` payload, external-edit watcher, `importLegacy`) must funnel through `validate()` in `src/main/config.js`. A new direct `JSON.parse` write, or a field reaching actions.js without validation: High. Confirm `MAX_RINGS`/`MAX_CHILDREN`/`MAX_FOLDER_DEPTH` caps still apply (DoS guard), and that folder segments stay non-executable in actions.js.
2. Icon URL fetch (`src/main/custom-icons.js`): `validateUrl` must stay http(s)-only and reject embedded credentials; `fetchImage` must cap response size; the cache key must pass `KEY_RE` (no path traversal into the icons dir). Any weakening: High.
3. Macro parser (`sendMacro` in `src/main/macro.js`): steps, typed text, chords, and sleeps must stay bounded — the `Math.min(5, …)` sleep clamp is the model. A new step type with unbounded loop count or text size: High.

## Pass 5 — Registry, hooks, FFI invariants

1. autostart.js deletes an HKCU Run value only when `runEntryBelongsToExe` proves it points at this exe. Any loosening of that ownership check (or a delete-by-name-only path): High — it could remove another app's entry.
2. Global hotkey / mouse hook registration in `hotkeys.js` and `mousehook.js` needs matching teardown; koffi stays fail-soft (`available === false` ⇒ clear error, never a crash) and is loaded only in `macro.js` (see the win32-koffi skill).
3. Trace every route from IPC/config to `sendChord`/`sendVk`/type: it must cross either the sys allowlist or the macro parser's bounds. Renderer-supplied text reaching SendInput unbounded: Critical.

## Pass 6 — Dependencies and hygiene

1. `npm audit` (runtime surface is only koffi; electron/electron-builder are dev-only).
2. Compare the pinned `electron` major in package.json against currently supported releases (web_search for Electron security releases). Electron backports CVE fixes to only the newest three majors — outside that window: High.
3. Grep `secret|token|api[_-]?key` under `src/` and `assets/` — no credentials belong in a bundled tree. Unsigned builds are expected here (see release-check); never describe one as signed.

## Report

- Findings table: rank, `file:line`, why it matters, proposed fix (do not apply).
- State clean passes quantitatively ("Pass 2: N channels enumerated, all either gated or read-only by design") — absence of findings must be provable, not assumed.
- If any Critical/High is open, say the build should not ship; re-run this audit after fixes and before `release-check`.
