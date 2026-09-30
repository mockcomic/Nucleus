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

Default hotkey: **Ctrl + Alt + Space** (change it in Settings → Hotkey).
First launch opens the Settings window and registers autostart (per-user Startup entry);
both are changeable anytime.

- The app lives in the system tray — no taskbar entry, no console.
- Tray menu: Show wheel · Open Settings · Reload config · Pause hotkey · Quit.
- Second launch (or double-clicking the tray icon) focuses Settings instead of duplicating.

## Using the wheel

- Open: the hotkey (wheel appears centered on the cursor; on small/secondary displays
  it clamps into view and shrinks to fit).
- Hover: segment highlights, the hub shows its icon + label.
- Select: left-click a segment. Dismiss: right-click, Esc, click the hub, or re-press the hotkey.

### Action types
| type | `value` example | note |
|---|---|---|
| `app` | `notepad.exe`, `C:\\Tools\\foo.exe --flag`, or pick from the installed-programs dropdown | program / Start Menu shortcut (dropdown or Browse…) |
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

- **Segments** — add / edit / reorder / delete items on the inner or outer ring,
  icon picker (Segoe Fluent glyphs), per-item color, live “try this action” button,
  file browse for apps, and an **installed-programs dropdown** when type is `app`:
  type to search the Start Menu + registry program list, click to fill the target
  (entries launch exactly like double-clicking their Start Menu shortcut; ↻ re-scans).
- **Appearance** — hub/wheel size, ring split, rotation, gaps, label size, pop
  animation, colors + 5 theme presets, center label. Live preview uses the exact
  same renderer as the real wheel.
- **Hotkey & Behavior** — press-to-record hotkey with instant registration (conflicts
  are reported and the old key stays active), Start-with-Windows toggle,
  dismiss options.
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
- No acrylic/backdrop blur behind the overlay (a transparent Electron window can
  only blur its own content) — depth comes from shadows + tuned fills.
- If a global hotkey fails to register at startup (taken by another app), the app
  keeps running, shows a tray balloon, and flags it red in Settings.

## Development

```
src/main/       main process (config store, hotkeys, SendInput macros, tray, windows, IPC)
src/preload/    contextBridge surface (no nodeIntegration anywhere)
src/renderer/   wheel overlay + settings UI (vanilla ESM, shared wheel-core renderer)
scripts/        icon generator, hidden-launch vbs
archive/        the original Python prototype + its config
```

## Manual test checklist

1. `npm start` → tray icon appears, no console/taskbar window; first-run opens Settings.
2. Ctrl+Alt+Space over any window/monitor → wheel pops centered on the cursor with animation.
3. Launch: Browser (url), Notes (app), Screenshot (sys), Lock (sys, then sign back in).
4. Add a macro item `type:hello world`, open Notepad, fire it — text appears.
5. Reorder/delete/re-ring items → preview + real wheel update instantly; restart app → persisted.
6. Record a new hotkey (e.g. Ctrl+Alt+J); old one stops working, new one works; try a
   known-taken combo → error shown, previous hotkey still active.
7. Settings → Startup off/on → check `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`.
8. Edit config.json in a text editor → running wheel reflects it within a second.
9. Break config.json (`{oops`) → app survives on last-good config; file saved as `.bad` on next reload attempt.
10. Run `npm start` again → Settings window focuses, no second tray icon.
```
