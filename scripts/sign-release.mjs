#!/usr/bin/env node
/* Sign a release: build + verify + (optionally) upload the signed update
   manifest (see docs/update-signing.md).

   usage:
     node scripts/sign-release.mjs <tag> <file...> [--signing-key PATH] [--upload]

   Builds update-manifest.json from the tag and the given asset files
   (sha256 + size computed from the bytes on disk), signs those exact bytes
   with the ed25519 private key (default ~/.nucleus/update-signing.key, or
   NUCLEUS_SIGNING_KEY), self-verifies, writes <tag>/update-manifest.json and
   <tag>/update-manifest.json.sig next to the assets, and with --upload hands
   both to `gh release upload <tag> --clobber`. A missing private key is a
   HARD failure: an unsigned release is browse-only by design — never sign
   by hand at release time. */
import { createHash, createPrivateKey, sign, createPublicKey, verify, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2).filter((a) => a !== '--upload');
const upload = process.argv.includes('--upload');
const keyFlag = args.indexOf('--signing-key');
let keyPath = process.env.NUCLEUS_SIGNING_KEY || join(homedir(), '.nucleus', 'update-signing.key');
if (keyFlag !== -1) { keyPath = args[keyFlag + 1]; args.splice(keyFlag, 2); }
const [tag, ...files] = args;
if (!tag || files.length === 0) {
  console.error('usage: node scripts/sign-release.mjs <tag> <file...> [--signing-key PATH] [--upload]');
  process.exit(1);
}
if (!existsSync(keyPath)) {
  console.error(`no signing key at ${keyPath}\n` +
    'Generate one with:  node scripts/update-keygen.mjs\n' +
    'An unsigned release is browse-only in-app by design — that is the fail-safe, not a bug.');
  process.exit(1);
}

const assets = files.map((f) => {
  const buf = readFileSync(f);
  return {
    name: basename(f),
    sha256: createHash('sha256').update(buf).digest('hex'),
    size: buf.length
  };
});
const manifest = { schema: 1, repo: 'mockcomic/Nucleus', tag, generatedAt: new Date().toISOString(), nonce: randomUUID(), assets };
const bytes = Buffer.from(JSON.stringify(manifest, null, 1) + '\n', 'utf8');
const sig = sign(null, bytes, createPrivateKey(readFileSync(keyPath, 'utf8')));

const pub = readFileSync(join(here, '..', 'src', 'main', 'update-key.pub.pem'), 'utf8');
if (!verify(null, bytes, createPublicKey(pub), sig)) {
  console.error('self-verification failed — the signing key does not match the committed public key.');
  process.exit(1);
}

const outDir = dirname(files[0]);
const jsonPath = join(outDir, 'update-manifest.json');
const sigPath = join(outDir, 'update-manifest.json.sig');
mkdirSync(outDir, { recursive: true });
writeFileSync(jsonPath, bytes);
writeFileSync(sigPath, sig.toString('base64'));
console.log(`wrote ${jsonPath}\nwrote ${sigPath}\nsigned ${assets.length} asset(s) for ${tag}`);
if (upload) {
  execFileSync('gh', ['release', 'upload', tag, jsonPath, sigPath, '--clobber'], { stdio: 'inherit' });
  console.log('uploaded to the release via gh');
}
