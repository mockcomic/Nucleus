/* Generates assets/tray.ico (+ tray-32.png) for packaging: node scripts/make-icons.mjs */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const { ensureProjectIcons } = await import(pathToFileURL(path.join(root, 'src', 'main', 'icon-gen.js')).href);
console.log('wrote', ensureProjectIcons(path.join(root, 'assets')));
