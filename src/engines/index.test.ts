import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryOnce } from './index.js';

test('retryOnce: transient failure then success', async () => {
  let n = 0;
  const r = await retryOnce(
    async () => {
      if (++n === 1) throw new Error('429');
      return 'ok';
    },
    'test-call',
    1,
  );
  assert.equal(r, 'ok');
  assert.equal(n, 2);
});

test('retryOnce: deterministic failure rejects after exactly two attempts', async () => {
  let n = 0;
  await assert.rejects(
    retryOnce(
      async () => {
        n++;
        throw new Error('bad model');
      },
      'test-call',
      1,
    ),
    /bad model/,
  );
  assert.equal(n, 2);
});
