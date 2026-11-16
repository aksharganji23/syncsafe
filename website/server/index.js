// Entry point: `npm start` (or `npm run start:https`).
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { createApp, VERSION } from './app.js';
import { seedIfEmpty } from './seed.js';
import { attachLive } from './live.js';
import { startJobs } from './jobs.js';
import { lanAddresses } from './network.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(here, '..', 'data');
const PORT = Number(process.env.PORT || 3000);
const HTTPS_ON = process.argv.includes('--https') || process.env.HTTPS === '1';

const ctx = await createApp({ dbDir: path.join(DATA_DIR, 'pgdata'), dataDir: DATA_DIR });
const seeded = await seedIfEmpty(ctx.db);

async function certificate() {
  const keyFile = path.join(DATA_DIR, 'tls-key.pem');
  const certFile = path.join(DATA_DIR, 'tls-cert.pem');
  if (!fs.existsSync(certFile)) {
    const { generate } = await import('selfsigned');
    const ips = lanAddresses().map((a) => ({ type: 7, ip: a.address }));
    const pems = await generate([{ name: 'commonName', value: 'SyncSafe local' }], {
      days: 825, keySize: 2048, algorithm: 'sha256',
      extensions: [{ name: 'subjectAltName', altNames: [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips] }],
    });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(keyFile, pems.private);
    fs.writeFileSync(certFile, pems.cert);
  }
  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

const server = HTTPS_ON ? https.createServer(await certificate(), ctx.app) : http.createServer(ctx.app);
ctx.setLive(attachLive(server, { db: ctx.db, bus: ctx.bus, secret: ctx.secret, metrics: ctx.metrics }));
const stopJobs = startJobs(ctx.db, ctx.bus, (...a) => console.error(...a));

server.listen(PORT, () => {
  const scheme = HTTPS_ON ? 'https' : 'http';
  const addrs = lanAddresses();
  const best = addrs.find((a) => !a.likelyVirtual);
  console.log('');
  console.log(`  SyncSafe ${VERSION} is running   (database: ${ctx.db.kind === 'postgres' ? 'PostgreSQL server' : 'built-in PostgreSQL, data/pgdata'})`);
  console.log(`  Open:        ${scheme}://localhost:${PORT}`);
  if (best) console.log(`  Phone app:   type  ${scheme}://${best.address}:${PORT}  as the Server address   (${best.name})`);
  else console.log('  Phone app:   no Wi-Fi address found. Connect the laptop to Wi-Fi (or a phone hotspot) and restart.');
  const others = addrs.filter((a) => a !== best);
  if (others.length) {
    console.log('  Other addresses (only if the one above fails):');
    for (const a of others) console.log(`               ${scheme}://${a.address}:${PORT}   (${a.name}${a.likelyVirtual ? ', virtual adapter: a phone cannot reach this' : ''})`);
  }
  console.log(`  Emulator:    type  10.0.2.2:${PORT}  in the Android Studio emulator`);
  if (HTTPS_ON) console.log('  HTTPS uses a self-signed certificate: the browser will warn once; choose Advanced → Continue.');
  if (seeded) console.log('  Sample data loaded. Log in as admin@syncsafe.test / Admin@123 (more accounts in README)');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
});

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  stopJobs();
  server.close();
  await ctx.db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
