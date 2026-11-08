# Security model

What is trusted, where the boundaries are, and what each protection does.
Companion docs: [update-signing.md](update-signing.md) (the release ritual)
and [SECURITY.md](../SECURITY.md) (reporting).

## 1. Updates — integrity AND authenticity, fail-closed

*Trust anchor:* `src/main/update-key.pub.pem`, embedded at build time.
*Authority:* the release's `update-manifest.json` (+ detached `.sig`),
signed by the matching private key, which never ships.

The chain a running app walks, all in the main process:

1. The Releases API answer is treated as untrusted data: only whitelisted
   fields survive `sanitizeRelease()`, asset URLs must match the pinned
   `https://github.com/mockcomic/Nucleus/releases/download/…` (or GitHub's
   asset CDN) regex, and the release page URL is rebuilt, never adopted.
2. The manifest pair is fetched through the same capped, redirect-pinned,
   SSRF-guarded transport as the installer. A signature that does not verify
   — bad, missing, half-published, wrong-key, tampered, signed for another
   tag — marks the release **browse-only**: the offer still appears and the
   release page still opens, but `downloadUpdate()` refuses to fetch a byte.
   There is no unsigned fallback; absence of proof is never proof.
3. A download is kept only if its sha256 matches the *manifest's* digest
   (GitHub's own `digest` field is a cross-check; the signed list wins
   conflicts). The `.part` file is cleaned on every failure path, and
   `runUpdate()` structurally spawns only paths the module just verified.
4. Every step stays user-gated (offer → download → run prompt), so
   "preserve notifications + manual install" is not weakened by the gates:
   manual download-and-run from the release page always remains possible.

Known limit (accepted, documented): the public key ships in the app, so an
attacker who controls what app builds you install controls that anchor; and
a stale-but-validly-signed manifest can linger on a GitHub release the
maintainer edited (re-sign on every republish — the workflow does).

## 2. Remote images — the SSRF guard (`src/main/netguard.js`)

Pasted icon URLs are untrusted input; an unchecked fetch makes the app a
free probe of the user's network. Every image fetch (custom icons,
dashboard logos) and the update system go through:

* **URL gate:** https only; no embedded credentials; a literal-IP host must
  itself be public.
* **Connect-time IP pinning** (undici connector): the app resolves the
  hostname itself, refuses when *every* answer is loopback / RFC1918 / CGNAT
  / link-local / multicast / unique-local (v4 **and** v6, incl. IPv4-mapped,
  6to4, Teredo carriers), then dials the validated literal IP while TLS SNI
  keeps the original hostname — so DNS cannot re-bind to an internal address
  between check and connect.
* **Redirect walk:** redirects are followed manually, at most 4, and every
  hop re-runs the whole gate before it is requested (a redirect to
  `127.0.0.1`, plain http, or `ftp:` dies before the socket).
* **Content gate:** magic-byte sniffing (`sniffImage`) decides what an icon
  is — never the extension, never `content-type`. Script-bearing SVGs are
  rejected; sizes are capped during streaming.

**The one opt-out:** Settings → Behavior → “Allow custom icons from my local
network” (`behavior.lanIcons`, default off). It widens *icon* fetches only —
private ranges and plain http — and never touches updates or dashboard
art. Errors from the guard are generic by design (“that address is not
allowed…”): internal hostnames/ports must not leak through an SSRF oracle.

## 3. Imported configuration — provenance decides trust

`validate()` (config.js) is a strict rebuild: types, lengths, enums, known
keys only, fresh objects — so an import cannot inject unknown fields, pollute
`Object.prototype`, or smuggle security settings (regression-tested). The
remaining risk was semantic: a config from elsewhere may contain `command`,
`app`, `file`, `macro`, `url`, `sys` items — and `command` segments run
through `cmd.exe` *by design* (Run-dialog semantics is the feature).

So the boundary is placed at the moment trust changes:

* **Import** (a file from outside): before anything is applied, Nucleus lists
  every executable item the import will make launchable (type, label, target
  — capped) and asks. Cancel = nothing changes. A config with no executable
  items imports silently.
* **Restore from the app's own backups** and the legacy migration path skip
  the dialog: those files were written by this machine *after* the same
  approval existed. Local edits (Settings UI, hand-editing config.json)
  remain trusted-without-nagging — asking there would be noise, not security.
* Import always backs the displaced config up first (pre-existing behavior),
  so an approved import is one “Restore” away from undone.

Export carries no secrets: the config holds paths, labels, colors and icon
keys — no tokens or credentials are stored, so export cannot leak any
(verified by inspecting `defaults()`; nothing in the schema is secret-bearing).

## 4. Electron & IPC posture (audited, unchanged)

* All three windows: `nodeIntegration: false`, `contextIsolation: true`,
  `sandbox: true`; preload exposes only the channels the page uses.
* Privileged IPC is sender-frame-gated to exact `file:` URLs of shipped
  pages (`PRIVILEGED` map; drift-guarded by `ipc-gating.test.js`), and every
  handler re-validates its arguments — the renderer never supplies raw
  paths that get opened (the pick-file dialog and the read are one main-side
  round trip).
* `will-navigate` is blocked, window.open denied, CSP meta tags on every
  page (`default-src 'none'`, images `data:`/`https:` where needed).
* `shell.openExternal` receives only URLs from a scheme allowlist
  (`safeExternalUrl`); `child_process` runs either direct spawns (no shell)
  or the user's own `command` segments, whose token quoting
  (`quoteCmdArg`) survives `cmd /c` re-parsing.

## Out of scope (recorded, deliberate)

Windows Authenticode signing of the shipped .exe (a separate, future layer:
SmartScreen reputation, not manifest authenticity); release attestation;
`style-src 'unsafe-inline'` tightening; `npm`-level dependency pinning
beyond the lockfile.
