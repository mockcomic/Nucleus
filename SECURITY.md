# Security policy

## Reporting a vulnerability

Please report security issues privately: use a
[GitHub private security vulnerability report](/mockcomic/Nucleus/security/advisories/new),
or open a regular issue WITHOUT the exploit details and mention
“security — details to follow”. Expect a response within a few days; this is
a hobby project maintained by one person, so fixes ship as ordinary
releases, and disclosure is welcome once one is out.

## Trust model, in one paragraph

Nucleus is a local launcher: it runs commands **you** configured, and the
security boundaries exist around everything that arrives from *somewhere
else*. Update installers are authenticated by an ed25519-signed release
manifest verified against a key embedded in the app — integrity *and*
authenticity, fail-closed, no unsigned fallback
([docs/update-signing.md](docs/update-signing.md)). Network fetches for
icon artwork go through an SSRF guard that refuses loopback, private, and
link-local addresses — even via redirects or DNS tricks — unless you
explicitly allow your own network in Settings
([docs/security-model.md](docs/security-model.md)). A config **imported**
from another machine shows you the commands it will make launchable before
applying anything. Windows code signing (Authenticode) of the .exe itself is
a separate, not-yet-done layer; the manifest signature does not replace it
and vice versa.

## Supported versions

The latest release only. Older releases keep working but keep whatever
fixes were current when they shipped.
