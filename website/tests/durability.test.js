// Randomized durability test (short version for every `npm test` run).
// Full run: `npm run test:durability` (1,000 cycles).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runDurability } from './sim.js';

for (const seed of [1, 2, 3]) {
  test(`durability: 150 random offline/online cycles with 30% faults (seed ${seed})`, async () => {
    const result = await runDurability({ cycles: 150, devices: 4, faultRate: 0.3, seed });
    assert.deepEqual(result.problems, [], result.problems.slice(0, 5).join('\n'));
    assert.ok(result.injectedFaults > 0, 'faults were injected');
  });
}
