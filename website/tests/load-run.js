// `npm run test:load` — 200 devices reconnect and push a batch each; reports latency.
// Like the real app, each device waits a random 0–3 s "reconnect jitter" before syncing,
// so the whole fleet does not hit the server in the same millisecond.
// Target from the proposal: p95 under 500 ms per batch.
// JITTER_MS=0 sends everything at once (worst-case burst; requests then queue).
// Against your running server:  BASE_URL=http://localhost:3000 npm run test:load
// (without BASE_URL a temporary in-memory server is started in this process).
import { startServer, loginFull, newId } from './helpers.js';

const DEVICES = Number(process.env.DEVICES || 200);
const BATCHES = Number(process.env.BATCHES || 1);
const OPS = Number(process.env.OPS || 10);
const JITTER_MS = Number(process.env.JITTER_MS ?? 3000);

let base = process.env.BASE_URL;
let srv = null;
if (!base) { srv = await startServer(); base = srv.base; }

const { access_token: token, deviceId } = await loginFull(base, 'asha@syncsafe.test');
const latencies = [];
let errors = 0;

async function device() {
  await new Promise((r) => setTimeout(r, Math.random() * JITTER_MS));
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-device-id': deviceId };
  for (let b = 0; b < BATCHES; b++) {
    const ops = Array.from({ length: OPS }, (_, i) => ({
      op_id: newId(), record_id: newId(), type: 'create', base_version: 0,
      fields: { title: `Load test ${b}-${i}`, status: 'Pending', priority: 'Low' },
    }));
    const t0 = performance.now();
    const res = await fetch(`${base}/api/sync/push`, { method: 'POST', headers, body: JSON.stringify({ ops }) });
    await res.json();
    latencies.push(performance.now() - t0);
    if (!res.ok) errors++;
  }
}

console.log(`Load test: ${DEVICES} devices x ${BATCHES} batches x ${OPS} operations, reconnect jitter 0-${JITTER_MS} ms, against ${base}`);
const started = performance.now();
await Promise.all(Array.from({ length: DEVICES }, device));
const total = (performance.now() - started) / 1000;

latencies.sort((a, b) => a - b);
const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((p / 100) * latencies.length))].toFixed(0);
console.log('');
console.log(`  Batches sent:   ${latencies.length}  (${latencies.length * OPS} operations)`);
console.log(`  Errors:         ${errors}`);
console.log(`  Latency p50:    ${pct(50)} ms`);
console.log(`  Latency p95:    ${pct(95)} ms`);
console.log(`  Latency max:    ${latencies.at(-1).toFixed(0)} ms`);
console.log(`  Wall time:      ${total.toFixed(1)} s (${((latencies.length * OPS) / total).toFixed(0)} operations/s)`);
console.log('');
console.log(Number(pct(95)) < 500 && errors === 0 ? 'PASS: p95 under the 500 ms target' : `ABOVE TARGET: p95 ${pct(95)} ms vs 500 ms target (see docs/TESTING.md, "Load test")`);
if (srv) await srv.close();
