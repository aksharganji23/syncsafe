// Copies the website's screens (../website/public) into this app's public/ folder,
// so the phone app and the website always run the same code.
// In the separate android-app zip the screens are already in public/, so nothing to copy.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '../../website/public');
const dest = path.resolve(here, '../public');

if (!existsSync(src)) {
  console.log('Using the screens already in public/ (no ../website folder next to this one).');
  process.exit(0);
}
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
rmSync(path.join(dest, 'sw.js'), { force: true });   // the app has its own offline files; no service worker needed
console.log(`Copied ${src} -> ${dest}`);
