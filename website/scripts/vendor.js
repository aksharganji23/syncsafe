// `npm run vendor`: copies third-party browser libraries into public/vendor so the
// app works offline and inside the Android app with no build step.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'public', 'vendor');
fs.mkdirSync(out, { recursive: true });

await build({
  stdin: { contents: "export * from 'yjs';", resolveDir: root, loader: 'js' },
  bundle: true, format: 'esm', minify: true, outfile: path.join(out, 'yjs.mjs'),
  legalComments: 'inline',
});
const leaflet = path.join(root, 'node_modules', 'leaflet', 'dist');
fs.copyFileSync(path.join(leaflet, 'leaflet.js'), path.join(out, 'leaflet.js'));
fs.copyFileSync(path.join(leaflet, 'leaflet.css'), path.join(out, 'leaflet.css'));
fs.mkdirSync(path.join(out, 'images'), { recursive: true });
for (const f of fs.readdirSync(path.join(leaflet, 'images'))) fs.copyFileSync(path.join(leaflet, 'images', f), path.join(out, 'images', f));
console.log('Vendored yjs and leaflet into public/vendor');
