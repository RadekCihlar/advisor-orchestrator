import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costForCall, estimateRunCostUsd } from './pricing.js';
import type { RunResult } from './runner.js';

const usage = (input: number, output: number, cacheRead = 0, cacheCreate = 0) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreate,
});

test('costForCall: anthropic sonnet-5 at $3/$15 per MTok + cache rates', () => {
  // 1M in + 1M out + 1M cacheRead (0.1×in) + 1M cacheCreate (1.25×in)
  const c = costForCall({ engine: 'anthropic-api', model: 'claude-sonnet-5' }, usage(1e6, 1e6, 1e6, 1e6));
  assert.ok(Math.abs(c! - (3 + 15 + 0.3 + 3.75)) < 1e-9);
});

test('costForCall: opus tier matched by model substring', () => {
  const c = costForCall({ engine: 'anthropic-api', model: 'claude-opus-4-8' }, usage(1e6, 0));
  assert.equal(c, 5);
});

test('costForCall: local is free, unknown model is null, null usage is null', () => {
  assert.equal(costForCall({ engine: 'local', model: 'qwen2.5' }, usage(1e6, 1e6)), 0);
  assert.equal(costForCall({ engine: 'anthropic-api', model: 'claude-9-hyper' }, usage(1, 1)), null);
  assert.equal(costForCall({ engine: 'openai-api', model: 'gpt-5.1' }, null), null);
});

const mkRun = (rounds: RunResult['rounds']): RunResult =>
  ({ mode: 'advised', finalOutput: 'x', rounds }) as RunResult;

test('estimateRunCostUsd: sums builder + reviewer sides with the right engine config', () => {
  const run = mkRun([
    {
      round: 1,
      builder: { text: 'b', usage: usage(1e6, 0), notionalCostUsd: null },
      reviewer: { text: 'r', usage: usage(0, 1e6), notionalCostUsd: null },
      approved: true,
      flagged: false,
    } as RunResult['rounds'][0],
  ]);
  const c = estimateRunCostUsd(
    run,
    { engine: 'anthropic-api', model: 'claude-sonnet-5' }, // builder: $3 for 1M in
    { engine: 'anthropic-api', model: 'claude-opus-4-8' }, // reviewer: $25 for 1M out
  );
  assert.ok(Math.abs(c! - 28) < 1e-9);
});

test('estimateRunCostUsd: a reported notionalCostUsd wins over the table estimate', () => {
  const run = mkRun([
    {
      round: 1,
      builder: { text: 'b', usage: usage(1e6, 0), notionalCostUsd: 0.42 },
      reviewer: null,
      approved: true,
      flagged: false,
    } as RunResult['rounds'][0],
  ]);
  const c = estimateRunCostUsd(run, { engine: 'claude-code', model: 'sonnet' }, { engine: 'local', model: 'x' });
  assert.equal(c, 0.42);
});

test('estimateRunCostUsd: any unpriceable call → null (no silent partial sums)', () => {
  const run = mkRun([
    {
      round: 1,
      builder: { text: 'b', usage: usage(1e6, 0), notionalCostUsd: null },
      reviewer: { text: 'r', usage: null, notionalCostUsd: null }, // no usage, no notional
      approved: true,
      flagged: false,
    } as RunResult['rounds'][0],
  ]);
  const c = estimateRunCostUsd(
    run,
    { engine: 'anthropic-api', model: 'claude-sonnet-5' },
    { engine: 'codex', model: 'gpt-5-codex' },
  );
  assert.equal(c, null);
});
