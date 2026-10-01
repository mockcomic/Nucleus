---
name: win32-koffi
description: "Conventions and pitfalls for the koffi FFI layer in radial-wheel: SendInput buffers, __stdcall signatures, fail-soft loading, hotkey auto-repeat guard, key-injection pacing."
whenToUse: "When adding or changing keyboard synthesis, global hotkeys, or any user32 call in src/main/macro.js, hotkeys.js, or sys.js."
---

# Win32 / koffi rules

`src/main/macro.js` is the only sanctioned FFI module — it is the single place koffi is
`require`d and loaded. Other modules that need user32 (e.g. `mousehook.js`) declare their
prototypes through the guarded `macro.ffi` passthroughs (`declareUser32`, `proto`,
`pointer`, `register`, `unregister`, `decode`) and never load koffi themselves.
New Win32 calls follow its conventions.

## Loading

- Load koffi inside try/catch and keep a module-level `available` flag plus `loadError` (`macro.js:16-27`). On non-Windows or a broken install, every feature must degrade to a clean user-facing error (`needInput()`, `macro.js:56-58`) — never a crash at require-time.
- Every user32 prototype must specify `__stdcall`, or the mismatched calling convention can crash the process:
  `user32.func('uint32 __stdcall SendInput(uint32 nInputs, void* pInputs, int32 cbSize)')`.

## SendInput buffers

- The x64 INPUT struct is exactly 40 bytes (`X64_INPUT_SIZE`). Write fields at fixed offsets: type u32@0, wVk u16@8, wScan u16@10, dwFlags u32@12 (`macro.js:60-67`). Raw buffers only — no FFI struct declarations.
- Always check the return value: `SendInput` returns the number of events actually injected; treat `r !== n` as an error (`macro.js:69-74`).
- Chords press modifiers left-to-right and release in reverse order (`macro.js:90-96`); literal typing uses `KEYEVENTF_UNICODE` with the char code in the scan field (`macro.js:110-117`).

## Pacing

- ~12 ms between key events, ~8 ms for typed-character down/up, and `wait=` macro steps clamped to 5 s max (`macro.js:76-122`). Without pacing, fast target apps drop events.
- When synthesizing keys after the overlay hides, wait ~120 ms for the formerly focused window to regain focus (`src/main/ipc.js:25-27`) — otherwise keystrokes land in your own window.

## Global hotkeys

- Registration goes through Electron `globalShortcut`; a falsy register result / `isRegistered` re-check catches "already taken by another app" — unregister before reporting failure (`hotkeys.js:51-62`).
- Ctrl+Alt combos keep re-firing after release (Electron/Windows quirk); the callback guards it with `GetAsyncKeyState` on both modifier VK codes via `macro.isDown` (`hotkeys.js:51-57`).
- `macro.isDown` returns `true` when FFI is unavailable — a fail-open choice. Any new guard must state its failure mode explicitly (`macro.js:124-127`).

## Global mouse hooks (mousehook.js)

- A `WH_MOUSE_LL` procedure runs on the system's input critical path: Windows holds up every mouse event in the session until it returns. Keep the body to a few integer compares, never call Electron/Node APIs inline (defer the trigger with `setImmediate`), and route EVERY bail-out through `CallNextHookEx` — fail-open, so a broken hook passes clicks through instead of eating them (`mousehook.js` hook body).
- Read `MSLLHOOKSTRUCT` fields only for the message you actually matched: `mouseData` u32@8, `flags` u32@12 (x64, after `POINT pt`), via `macro.ffi.decode(lParam, off, 'uint32')`. Skip `LLMHF_INJECTED` (0x1) events so synthesized input can't summon the wheel.
- Swallowing must be PAIRED: if the press is hidden (`return 1`), the matching release must be hidden too, or the target app gets a stray button-up (`state.suppressed`).
- Keep the koffi-registered callback pinned in a module variable and reuse it across install/uninstall; `koffi.unregister` only at shutdown.
- `Quit` AND every trigger change must unhook: `hotkeyMgr.unregister()` → `mousehook.clear()`, `quitApp()` → `mousehook.shutdown()`. A leaked hook keeps stealing the user's clicks.

## Teardown & platform

- `quitApp()` unregisters hotkeys before destroying windows (`main.js:47-54`); a leaked global hotkey outlives a crash and steals keys from other apps.
- Keep everything OS-specific behind the `process.platform === 'win32'` check at the FFI boundary.
