// `npm run test:durability` — the headline durability test from the proposal:
// 1,000 randomized cycles of offline edits, reconnects and dropped requests.
// Usage: node tests/durability-run.js [cycles] [seed]
import { runDurability } from './sim.js';

const cycles = Number(process.argv[2] || 1000);
const seed = Number(process.argv[3] || Date.now() % 100000);
console.log(`Running ${cycles} cycles with 4 devices, 30% injected faults, seed ${seed}...`);
const started = Date.now();
const r = await runDurability({ cycles, devices: 4, faultRate: 0.3, seed });

console.log('');
console.log(`  Cycles run:              ${r.cycles}`);
console.log(`  Injected server faults:  ${r.injectedFaults}`);
console.log(`  Syncs failed or offline: ${r.failedSyncs}`);
console.log(`  Duplicate ops ignored:   ${r.duplicatesIgnored}`);
console.log(`  Conflicts raised:        ${r.conflictsRaised}`);
console.log(`  Records on server:       ${r.serverRecords}`);
console.log(`  Time:                    ${((Date.now() - started) / 1000).toFixed(1)} s`);
console.log('');
if (r.problems.length) {
  console.log(`FAIL: ${r.problems.length} problem(s)`);
  r.problems.slice(0, 20).forEach((p) => console.log(`  - ${p}`));
  console.log(`Replay with: node tests/durability-run.js ${cycles} ${seed}`);
  process.exit(1);
}
console.log('PASS: every device matches the server; 0 records lost; 0 operations applied twice.');
