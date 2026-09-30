---
name: test-bootstrap
description: "Brings an incremental node:test suite to radial-wheel (which currently has none): pure-function targets, electron-stub recipe, DOM-free renderer logic, isolation rules."
whenToUse: "When asked to add tests, or before a risky refactor of config validation, hotkey parsing, or wheel geometry."
---

# Test bootstrap

`package.json` has no test script. Establish this baseline and keep it green.

## Setup

- Add `"test": "node --test tests/"` to the scripts in `package.json`.
- Tests live in `tests/` as `*.test.js`, using `node:test` + `node:assert/strict`.

## Easy targets (pure CommonJS, no electron import at load)

- `src/main/hotkeys.js` — `parse()`: modifier reordering, key normalization, and every throw path (multiple main keys, unknown token, missing modifier).
- `src/main/macro.js` — `vkFor()` mapping tables (F-keys, CHAR_VK, unknown-key throws) is pure; never call the SendInput paths in unit tests.
- `src/main/sys.js` — `IDS`/`ALIAS` table completeness (every alias resolves to a catalog id). Do not call `run()` — it spawns processes.

## Modules that import electron at load time

`config.js`, `autostart.js`, `ipc.js` etc. `require('electron')` at module scope. Stub it via require-cache injection before the first require:

```js
const os = require('node:os');
const electronPath = require.resolve('electron');
require.cache[electronPath] = {
  id: electronPath, filename: electronPath, loaded: true,
  exports: { app: { getPath: () => os.tmpdir() } }
};
const { validate, defaults } = require('../src/main/config.js');
```

Priority target: `validate()` fuzzing — clamp bounds (`config.js:90-104`), type coercion, hex-color rejection, the never-empty-rings guard (`config.js:84`), and hotkey regex acceptance.

## Renderer shared code (ESM)

- `src/renderer/shared/wheel-core.js` is a plain ESM module importable from node:test; `degToXY`, `ringSpans`, `sectorPath` are DOM-free. Never import paths that reach `svgEl`/`document` (`wheel-core.js:23-27`) without a DOM stub.

## Isolation rules

- Unit tests must never launch Electron, register global hotkeys, or touch the real `%APPDATA%\Radial Wheel\` — route every fs-using path through the tmpdir stub above.
- If a module is too entangled to test this way, extract the pure part rather than mocking deeper.
