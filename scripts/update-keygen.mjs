#!/usr/bin/env node
/* One-time signing-key setup for the update manifest (see
   docs/update-signing.md). Generates an ed25519 keypair:
     public  -> src/main/update-key.pub.pem   (COMMITTED: the app embeds it)
     private -> ~/.nucleus/update-signing.key (NEVER committed or packaged)
   Refuses to overwrite either file without --force.

   usage: node scripts/update-keygen.mjs [--force] */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PUB = join(here, '..', 'src', 'main', 'update-key.pub.pem');
const PRIV = process.env.NUCLEUS_SIGNING_KEY || join(homedir(), '.nucleus', 'update-signing.key');
const force = process.argv.includes('--force');

const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

for (const [label, p] of [['public', PUB], ['private', PRIV]]) {
  if (existsSync(p) && !force) {
    console.error(`${label} key already exists: ${p} (use --force to replace)`);
    process.exit(1);
  }
}
mkdirSync(dirname(PRIV), { recursive: true });
writeFileSync(PUB, publicKey, 'utf8');
writeFileSync(PRIV, privateKey, { encoding: 'utf8', mode: 0o600 });
console.log('public key (commit this):      ' + PUB);
console.log('private key (keep it OUTSIDE ' + join(here, '..') + '): ' + PRIV);
