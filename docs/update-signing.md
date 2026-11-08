# Update release signing

Nucleus's in-app updater authenticates every update with an **ed25519-signed
release manifest**. SHA-256 (see `src/main/update.js`) proves the downloaded
bytes match a published digest; the signed manifest proves *the digest list
itself* came from this project — closing the hole where a host that can lie
about the release JSON can lie about the checksum too.

## The manifest

Two fixed-name assets ship with every release:

| Asset | Content |
|---|---|
| `update-manifest.json` | JSON: `schema:1`, `repo`, `tag`, `generatedAt`, `nonce`, and `assets[{name, sha256, size}]` |
| `update-manifest.json.sig` | base64 ed25519 signature over the **exact bytes** of the JSON (detached — no canonicalization rules needed at verify time) |

The app rebuilds the download URLs from the tag (pinned to
`github.com/mockcomic/Nucleus/releases/download/…`), fetches the pair through
the same byte-capped, redirect-pinned (https, GitHub hosts only) path as the
installer itself, and verifies the signature against a public key embedded in
the app.

**Trust model.** The signature is only worth what the embedded public key is
worth: the key is pinned in this repo (`src/main/update-key.pub.pem`), so
whoever can ship you a genuine Nucleus build also chooses who can sign
updates. That is the standard trust anchor for an auto-updater.

## Credentials

| Credential | Where it lives | Bundled with the app? |
|---|---|---|
| `src/main/update-key.pub.pem` | committed in this repo | **yes** (the app reads it at startup) |
| `~/.nucleus/update-signing.key` | the release machine only (override: `NUCLEUS_SIGNING_KEY`) | **never** — not in the repo, not packaged |

One-time setup on a new release machine:

```
node scripts/update-keygen.mjs        # writes BOTH files; refuse to overwrite without --force
```

**Rotating the key** = commit a new `update-key.pub.pem` AND ship an app
version containing it: old apps only trust old keys, so bump the key in a
released update before you start signing with it.

## Signing a release

At release time, after `npm run dist` produces the installers in `dist/`:

```
node scripts/sign-release.mjs v1.2.0 dist/Nucleus-1.2.0-b22-setup.exe dist/Nucleus-1.2.0-b22-portable.exe --upload
```

The script computes sha256+size from the bytes on disk, writes
`update-manifest.json` + `.sig` next to the assets, **self-verifies against
the committed public key** (hard-fails if the key pair disagrees), and with
`--upload` attaches both files via `gh release upload <tag> --clobber`
(credential: `gh` already logged in). Without `--upload`, drag the two files
onto the GitHub release yourself. A missing private key is a hard error:
**never sign by hand at release time, and never ship a release you could not
sign and simply leave browse-only by accident.**

## How the app behaves (fail-closed, no unsigned fallback)

* Manifest signature valid → `authenticated: true`. "Update now" downloads
  the installer, requires the **manifest's** digest (a conflicting GitHub
  `digest` field is overridden — the signed list is the authority; assets the
  manifest omits lose their digest), and only that verified file may be run.
* Signature invalid / manifest tampered / half pair / unknown schema or tag
  → the release is still announced and the release page opens, but the app
  **refuses to download or run it**, and says why (`authReason`).
* No manifest pair on the release at all (older release, signing skipped) →
  same browse-only behavior. The absence of proof is never treated as proof.
* `runUpdate()` can only spawn a file this module just downloaded *and*
  matched against the manifest digest — enforced structurally, not by caller
  discipline. Manual installation (running the `.exe` from Downloads) always
  remains the user's option.
* If `update-key.pub.pem` is missing from a build, everything degrades to
  browse-only — fails closed, never open.

Scope note: this authenticates the **manifest**. Windows Authenticode signing
of the `.exe` itself is a separate concern and deliberately out of scope.
