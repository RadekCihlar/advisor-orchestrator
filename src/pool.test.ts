import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPool } from './pool.js';

test('runPool: processes every item and never exceeds the concurrency limit', async () => {
  const done: number[] = [];
  let inFlight = 0;
  let peak = 0;
  await runPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    done.push(n);
  });
  assert.equal(done.length, 7);
  assert.deepEqual([...done].sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7]);
  assert.ok(peak <= 3, `peak in-flight ${peak} exceeded limit 3`);
  assert.ok(peak >= 2, `expected actual parallelism, got peak ${peak}`);
});

test('runPool: limit 1 preserves item order (sequential)', async () => {
  const order: number[] = [];
  await runPool([3, 1, 2], 1, async (n) => {
    await new Promise((r) => setTimeout(r, n)); // varying latency can't reorder at limit 1
    order.push(n);
  });
  assert.deepEqual(order, [3, 1, 2]);
});

test('runPool: a rejecting item rejects the pool', async () => {
  await assert.rejects(
    runPool([1, 2], 2, async (n) => {
      if (n === 2) throw new Error('boom');
    }),
    /boom/,
  );
});
