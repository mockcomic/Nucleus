# Radial Wheel

A polished, always-running radial launcher for Windows. Press a global hotkey and a
crisp, animated wheel pops up **at your mouse cursor** — click a segment to launch
apps, open URLs, run commands, replay keystroke macros, or trigger built-in Windows
actions. Everything is configurable from a real Settings window.

Built with Electron + vanilla web tech; keystroke synthesis and system actions go
straight to the Win32 API through `user32.dll` (via `koffi`).

## Quick start

```powershell
npm install          # first time only (downloads the Electron runtime)
npm start            # launches tray-resident Radial Wheel
```

Default hotkey: **Ctrl + Alt + Space** — or use a mouse button instead: **Middle**, **Back**
or **Forward**, on their own or with modifiers (`Ctrl + Middle`). Change it in
Settings → **Hotkey & behavior** → *Change…*: press a combo, or click the button.
First launch opens the **Welcome guide** — four steps: what the wheel is, re-record your
hotkey (with a live "try the wheel" test), what to know, hand-off to Settings — and
registers autostart (per-user Startup entry); both are changeable anytime. Replay the
guide anytime from tray → **Show welcome…**.

- The app lives in the system tray — no taskbar entry, no console.
- Tray menu: Show wheel · Open Settings · Show welcome… · Reload config · Pause hotkey · Quit.
- Second launch (or double-clicking the tray icon) focuses Settings instead of duplicating.

## Using the wheel

- Open: the hotkey (wheel appears centered on the cursor; on small/secondary displays
  it clamps into view and shrinks to fit).
- Hover: segment highlights, the hub shows its icon + label.
- Select: left-click a segment. Dismiss: right-click, Esc, click the hub, or re-press the shortcut.
- Mouse-button shortcut: by default the wheel **swallows** that click, so it behaves like a
  real hotkey and the app underneath never sees it (Middle click stops pasting while it is
  your summon key). Behavior → **Let the mouse button through to the app under the cursor**
  switches to detect-only: the wheel pops *and* the app gets its Back / Forward / paste.

### Action types
| type | `value` example | note |
|---|---|---|
| `app` | `notepad.exe`, `C:\\Tools\\foo.exe --flag`, or pick from the installed-programs dropdown | program / Start Menu shortcut (dropdown or Browse…). The **Arguments** box (`args`) passes launch parameters — quote values that contain spaces |
| `url` | `https://gmail.com` | default browser |
| `file` | `C:\\Docs\\notes.md` | opens with its registered handler |
| `command` | `taskkill /f /im foo.exe` | detached shell command |
| `macro` | `ctrl+c, wait=0.2, ctrl+v` · `type:hello` | real SendInput keys |
| `sys` | `lock`, `mute`, `screenshot`, `wifi`, … | built-in Windows actions |

`sys` values: `lock sleep screenshot show_desktop task_manager exit_app mute volume_up
volume_down sound explorer recycle_bin settings wifi bluetooth notifications night_light
display power clipboard_history emoji_picker`.

## Settings

Open from the tray (double-click icon → **Open Settings**). Four tabs:

- **Segments** — add / edit / reorder / delete items on any ring, **+ Add ring**
  grows the wheel outward (up to 4 rings; remove the outermost anytime),
  icon picker (Segoe Fluent glyphs, a [Dashboard Icons](https://dashboardicons.com)
  logo, or your own image), per-item color, live “try this action” button,
  file browse for apps, and an **installed-programs dropdown** when type is `app`:
  type to search the Start Menu + registry program list, click to fill the target
  (entries launch exactly like double-clicking their Start Menu shortcut; ↻ re-scans).
- **Appearance** — hub/wheel size, ring split (two-ring layouts; three or more
  rings divide equally), rotation, gaps, label size, pop
  animation, colors + 14 theme presets, center label. Live preview uses the exact
  same renderer as the real wheel.
- **Hotkey & Behavior** — press-to-record hotkey with instant registration (conflicts
  are reported and the old key stays active); the recorder accepts the keyboard or a
  **Middle / Back / Forward mouse button** (`mmiddle`, `ctrl+mback`, … — one trigger at a
  time, mouse replaces the keyboard combo and vice versa), with **Let the mouse button
  through to the app under the cursor** to choose between swallowing the click and
  detect-only. Start-with-Windows toggle,
  dismiss options, and **Gaming mode**: the wheel turns itself off (hotkey
  included) while the focused app covers a whole monitor — exclusive or
  borderless-fullscreen games — or while one of your listed programs
  (comma-separated exe names, e.g. `fortnite.exe`) has focus. It switches back
  on when the app closes or you alt-tab away; the tray tooltip and menu say
  why the hotkey is off, and tray → **Show wheel** still works as an override.
- **Advanced** — export / import / reset config, open the config folder, action
  type reference, exit.

All edits autosave (debounced) to:

```
%APPDATA%\Radial Wheel\config.json
```

The file is watched — hand-edit it and the running wheel picks changes up
(hotkey re-registers too). If it ever becomes invalid JSON, the app keeps the
last-good config and leaves your broken file next to it as `config.json.bad`.
Your original `wheel_config.json` from the Python prototype (in `archive/`) is
imported automatically on first run.

## Packaging (optional but recommended for daily use)

```powershell
npm run dist    # → dist/:
                #    RadialWheel-1.0.0-portable.exe        (no-install single exe)
                #    Radial Wheel Setup 1.0.0.exe          (one-click NSIS installer)
```

Packaged builds are the recommended way to run long-term: the Start-with-Windows
entry (registry value `local.radialwheel` under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`)
then points at the real exe and carries the app icon (in dev mode it points at
Electron). Install the Setup exe, launch it once, and it lives in the tray from then on.

To launch from source with no console (e.g. a Startup entry during development):
`wscript scripts\launch-hidden.vbs`.

## Notes & limits

- Macros type into whatever window has focus after the wheel closes; that's
  standard SendInput behavior. `wait=` steps space things out.
- `sleep` uses the standard `SetSuspendState` call — if hibernation is enabled it
  hibernates instead (that's Windows, not the app).
- Icons come from **Segoe Fluent Icons** (Win 11) with **Segoe MDL2 Assets**
  (Win 10) fallback; the picker shows exactly what a glyph will look like.
- **Custom segment images**: in the icon picker, **Browse image…** takes a local
  **PNG, JPG, GIF, WebP, BMP, ICO** or **SVG** file (up to 2 MB), or paste an
  image **URL** and hit **Use URL**. The bytes are stored once, content-addressed,
  under `%APPDATA%\Radial Wheel\icons\custom` and `config.json` keeps only a
  `custom:<hash>.<ext>` key — so configs stay small and shareable. A pasted URL is
  downloaded once and kept, so the wheel shows it offline too; a URL-sourced icon
  re-downloads itself on a new machine, while one picked from disk falls back to
  that segment's glyph. Either way nothing renders blank. Files are validated by
  their bytes, not their extension, and an `<img>`-loaded SVG cannot run script.
- No acrylic/backdrop blur behind the overlay (a transparent Electron window can
  only blur its own content) — depth comes from shadows + tuned fills.
- If a global hotkey fails to register at startup (taken by another app), the app
  keeps running, shows a tray balloon, and flags it red in Settings.
- A **mouse-button** shortcut rides a `WH_MOUSE_LL` low-level hook, so it needs the same
  koffi input bridge the macros use. If that bridge can't load (non-Windows, broken
  install) the trigger reports it in Settings and you pick a keyboard combo instead —
  nothing else degrades. Inside the hook, any unexpected error lets the click reach the
  app rather than swallow it (fail-open: a broken hook must never eat your mouse).
  Quitting unhooks it, so Middle click goes back to being an ordinary Middle click.
- Some mice report the Back / Forward button id in the **high word** of the hook event's
  `mouseData` instead of the documented low word; Windows apps then ignore those buttons
  entirely (they "do nothing"). Radial Wheel reads either word, so the side buttons still
  summon the wheel on such mice.
- Gaming mode samples the foreground window every ~1.5 s while enabled (zero cost
  when off; pause fires after ~3 s, resume is immediate). Fullscreen video players
  and remote-desktop windows count as "fullscreen apps" too. It reads the
  foreground process name via Win32 — an admin-elevated game may hide its exe
  name from a non-elevated app, in which case the app-list match can't fire but
  fullscreen detection still does. If the Win32 probe is unavailable the wheel
  simply never pauses (fail-open).

## Development

```
src/main/       main process (config store, hotkeys, mouse-button hook, SendInput macros, tray, windows, IPC)
src/preload/    contextBridge surface (no nodeIntegration anywhere)
src/renderer/   wheel overlay + settings UI (vanilla ESM, shared wheel-core renderer)
scripts/        icon generator, hidden-launch vbs
archive/        the original Python prototype + its config
```

Debugging a mouse trigger: `npm run start:agent -- --mouse-hook-probe` prints the hook's
counters whenever they change — `calls` (every event the proc was handed), `seen` (events
for the armed button), `fired`, `swallowed`, `injectedIgnored`, plus a `buttons` histogram
keyed by Win32 message id and the last decoded `mouseData` / `flags`. `calls` rising while
`seen` stays 0 means the button never reaches the hook (vendor driver remap, or another
app's hook took it first). Dev builds only — inert once packaged.

## Manual test checklist

1. `npm start` → tray icon appears, no console/taskbar window; first-run opens the Welcome guide (replay via tray → Show welcome…; seen-state in `state.json`).
2. Ctrl+Alt+Space over any window/monitor → wheel pops centered on the cursor with animation.
3. Launch: Browser (url), Notes (app), Screenshot (sys), Lock (sys, then sign back in).
4. Add a macro item `type:hello world`, open Notepad, fire it — text appears.
5. Reorder/delete/re-ring items → preview + real wheel update instantly; restart app → persisted.
6. Record a new hotkey (e.g. Ctrl+Alt+J); old one stops working, new one works; try a
   known-taken combo → error shown, previous hotkey still active.
6b. Record **Middle click** as the shortcut (or `Ctrl+Middle`); it summons the wheel and
   Middle click no longer pastes/autoscrolls. Tick **Let the mouse button through** →
   the wheel pops *and* the app still gets the click. Record `Back`/`Forward` over a
   browser: swallowed by default, so no navigation. Re-record a keyboard combo →
   the mouse hook goes away (Middle click behaves normally again). Tray → Pause hotkey
   and Gaming mode must silence the mouse trigger too; **Quit** must leave the mouse
   fully normal (no leaked hook).
7. Settings → Startup off/on → check `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
8. Edit config.json in a text editor → running wheel reflects it within a second.
9. Break config.json (`{oops`) → app survives on last-good config; file saved as `.bad` on next reload attempt.
10. Run `npm start` again → Settings window focuses, no second tray icon.
```
