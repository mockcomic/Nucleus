---
name: reindex
description: "Rebuild the codebase-memory graph for radial-wheel using codebase-memory-mcp (DeusData) — MCP tool or CLI, with the verified command flags, npm-install pitfall, and evidence checks."
whenToUse: "When asked to reindex the project for the memory/codebase MCP, after large refactors or renames, or when codebase-memory queries (search_graph, trace_call_path, get_architecture) look stale or empty."
---

# Reindex (codebase-memory-mcp)

The codebase memory MCP is **codebase-memory-mcp** (npm package by DeusData, pinned/verified at
`0.11.0`): a tree-sitter knowledge graph of symbols, call chains, and routes. Reindexing =
re-running `index_repository`; it rebuilds the graph for the project idempotently.

Two equivalent surfaces:

- **MCP**: if `mcp__<serverName>__index_repository` tools are connected in the session, call that
  tool with `{"repo_path": "<repo root>"}`.
- **CLI** (always works, no connection needed): every MCP tool has a `cli` mirror —
  `codebase-memory-mcp cli <tool> ...`.

## 1. Reindex command

Run from the repo root (`C:\Users\KH-PC\Documents\GitHub\radial-wheel`):

```powershell
codebase-memory-mcp cli index_repository --repo-path .
```

- Use the `--flag` form, **not** raw JSON positional args — that path is deprecated
  ("passing raw JSON ... is deprecated"); `--args-file <path>` or piped stdin are the alternatives.
- Modes: `--mode full` (default, all+semantic), `moderate` (filtered+semantic), `fast`
  (filtered only). Use `fast` for a quick refresh when semantic edges don't matter.
- This project registers as `C-Users-KH-PC-Documents-GitHub-radial-wheel` (path-derived);
  override with `--name <string>` only if intentionally renaming.
- Expect ~seconds for radial-wheel (last run: 1324 nodes / 3395 edges, with the repo-root
  `.codebase-memory.json` mapping `.mjs` → javascript so `src/main/themes.mjs`,
  `src/renderer/welcome/welcome-core.mjs`, and `scripts/*.mjs` are in the graph).

A benign `level=warn msg=mem.allocator.preloading_completed ...` line on stderr is normal
startup noise — do not treat it as failure.

## 2. Verify (collect both pieces of evidence)

1. The command's JSON result contains `"status":"indexed"` with nonzero `nodes`/`edges`, and
   exit code 0.
2. Cross-check persistence:

```powershell
codebase-memory-mcp cli list_projects
codebase-memory-mcp cli index_status --project C-Users-KH-PC-Documents-GitHub-radial-wheel --diagnostics summary
```

`index_status` coverage rows are best-effort signals, not failures: `not_indexed` entries are
exclude-by-design (gitignore/`.cbmignore`/skip-lists — `.cache`, `.git`, `node_modules`, binary
assets all land there); `parse_partial` means the file indexed but some line ranges may lack
constructs (the repo's `tests/*.ps1` files always show partial — expected). Full log per run:
`~\.cache\codebase-memory-mcp\logs\<project>-<id>.log` (path also printed in the result's
`logfile` field). The graph database lives in `~\.cache\codebase-memory-mcp\` — nothing is
written into the working tree by default (`--persistence true` would write
`.codebase-memory/graph.db.zst` inside the repo; only use it deliberately).

## 3. If the MCP connection looks stale after reindexing

A running MCP server can keep answering from its pre-reindex state. Re-run any query tool
(`search_graph`, `index_status`) to confirm freshness; if queries still return old results,
restart the session/Host so the MCP child respawns — DSH's generic MCP client does not
auto-reconnect crashed children.

## 4. Repair / prerequisites (only when something is missing)

- `codebase-memory-mcp --version` fails or the native runtime is absent: the npm `postinstall`
  downloads the platform runtime set, and npm allow-scripts policies silently skip it. Fix:

  ```powershell
  npm install -g --allow-scripts=codebase-memory-mcp codebase-memory-mcp@0.11.0
  ```

- **Do not run `codebase-memory-mcp install`** unasked — it rewrites MCP/hook configs of every
  detected coding-agent client on the machine. DSH connects via its own MCP row; the package's
  own installer is unnecessary here.
- Version pin: upgrade deliberately (`npm install -g --allow-scripts=codebase-memory-mcp
  codebase-memory-mcp@latest`) — note 0.10.7 and <0.8.1 are broken/deprecated publishes;
  0.10.8+ or 0.11.x are the healthy lines.

## 5. DSH wiring (where this server is registered)

Row lives in the **active** profile's user patch — `~\.dsh\profiles\desktop\cordis.patch.yml`.
Confirm `$env:DSH_PROFILE` first: the `web` profile has its own patch and is not what the desktop
GUI boots, so editing it looks applied and does nothing. The bridge plugin
(`@deepseek-ai/dsh-mcp-client`) already ships in the app; only the row is user data.

```yaml
- insert:
    - id: mcp-codebase-memory
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: cbm              # tools register as mcp__cbm__search_graph, mcp__cbm__trace_path, ...
        transport: stdio
        command: C:\Users\KH-PC\AppData\Roaming\npm\node_modules\codebase-memory-mcp\bin\codebase-memory-mcp.exe
        args: []
        cwd: C:\Users\KH-PC\Documents\GitHub\radial-wheel
        toolCallTimeoutMs: 180000
        failOnStartupError: false
        env:
          CBM_ALLOWED_ROOT: C:\Users\KH-PC\Documents\GitHub
```

- Never run `codebase-memory-mcp install` / `install.ps1` to wire this up (see §4): DSH needs only
  the row above. Audit trail that it did not run: `~\.claude.json`, `~\.codex\config.toml`,
  `~\.cursor\mcp.json`, `~\.qwen\settings.json` still carry their pre-existing mtimes.
- `command` targets the native `.exe`, not the `%APPDATA%\npm\codebase-memory-mcp.cmd` shim — the
  shim re-spawns through Node and is unreliable over piped stdio.
- `cwd` must name the repo. The stdio child inherits the Host's cwd (the profile dir), and CBM
  auto-registers its cwd as a watched workspace; with `CBM_ALLOWED_ROOT` set that produced
  `daemon.workspace.skipped ... is_outside_the_allowed_root` on every poll and left this repo
  without auto-sync. Pinning `cwd` cleared both. For a different repo, pass `repo_path` per call.
- Do not rename `id` or `serverName`: public tool names and permission rules are pinned to them,
  and session history breaks if they change.
- Profile-patch edits **hot-reload**: after each edit the harness disposed and respawned the child
  (new PIDs, fresh `watcher.watch`/`watcher.baseline` lines in `~\.cache\codebase-memory-mcp\logs\
  cbm-daemon.log`) with no app restart. Only a crashed child needs the budget-backed reconnect, and
  a stale server generation still needs the §3 restart.
- Validate YAML before restarting anything using the harness's own tag schema — the `!!js` tag comes
  from the `yaml` package (`customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: v => v }]`);
  `js-yaml` in this workspace's `node_modules` rejects the tag and its "unknown tag" error is a
  false alarm about a file the harness loads fine.
- Rollback: delete the `- insert:` item (or restore `cordis.patch.yml.bak-cbm` — that backup was
  taken before the `mcp-context7` row was added, so restoring it drops that row too), then
  optionally `codebase-memory-mcp cli delete_project --project
  C-Users-KH-PC-Documents-GitHub-radial-wheel`.
- Graph limits worth remembering: this project's edge census is `DEFINES, CONTAINS_FOLDER,
  CONTAINS_FILE, FILE_CHANGES_WITH, CALLS, USAGE, WRITES, DEFINES_METHOD, CALL_REFERENCE,
  CONFIGURES, IMPORTS, SEMANTICALLY_RELATED, SIMILAR_TO, HAS_BRANCH` — there are no
  `EMITS`/`LISTENS_ON`/`HANDLES` edges, so Electron's string IPC (`ipcMain.handle` in
  `src/main/ipc.js` ↔ `ipcRenderer.invoke` in `src/preload/index.js`) is **not** linked in the
  graph. `grep` is still the right tool for that boundary, and for the koffi FFI surface.
