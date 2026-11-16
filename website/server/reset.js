// `npm run reset`: delete the database so the next `npm start` reloads the sample data.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || path.join(here, '..', 'data');
const dir = path.join(dataDir, 'pgdata');

if (fs.existsSync(dir)) {
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('Database deleted. Run `npm start` to reload the sample data.');
} else {
  console.log('No database found; nothing to reset.');
}
console.log('Devices notice the reset on their next sync and reload their data by themselves.');
