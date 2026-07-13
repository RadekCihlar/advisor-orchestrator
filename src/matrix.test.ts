import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewerSpecs, armLabelFor, recommendFrom } from './matrix.js';
import type { ArmStats } from './report.js';

test('parseReviewerSpecs: engine/model list, model may contain : and .', () => {
  assert.deepEqual(parseReviewerSpecs('codex/auto, local/qwen2.5:3B'), [
    { engine: 'codex', model: 'auto' },
    { engine: 'local', model: 'qwen2.5:3B' },
  ]);
});

test('parseReviewerSpecs: model may contain / (only the FIRST slash splits)', () => {
  assert.deepEqual(parseReviewerSpecs('local/library/model:7b'), [{ engine: 'local', model: 'library/model:7b' }]);
});

test('parseReviewerSpecs: malformed entry throws with the offending spec', () => {
  assert.throws(() => parseReviewerSpecs('codex/auto,broken'), /broken/);
  assert.throws(() => parseReviewerSpecs(''), /empty/i);
});

test('armLabelFor: stable advised@engine/model label', () => {
  assert.equal(armLabelFor({ engine: 'local', model: 'qwen2.5:3B' }), 'advised@local/qwen2.5:3B');
});

const arm = (mode: string, meanScore: number | null, meanTotalTokens: number): ArmStats => ({
  mode,
  runs: 2,
  gradedRuns: 2,
  meanScore,
  scoreRange: meanScore === null ? null : [meanScore, meanScore],
  stddevScore: 0,
  meanInputTokens: 0,
  meanOutputTokens: 0,
  meanCacheReadTokens: 0,
  meanCacheCreationTokens: 0,
  meanTotalTokens,
  meanCostUsd: null,
});

test('recommendFrom: cheapest reviewer within ε of the best wins', () => {
  const r = recommendFrom([
    arm('baseline', 0.5, 500),
    arm('advised@codex/auto', 0.9, 9000),
    arm('advised@local/qwen2.5:3B', 0.89, 2000),
  ]);
  assert.equal(r.kind, 'reviewer');
  assert.deepEqual(r.kind === 'reviewer' && r.reviewer, { engine: 'local', model: 'qwen2.5:3B' });
});

test('recommendFrom: baseline within ε of the best → no reviewer earns its keep', () => {
  const r = recommendFrom([
    arm('baseline', 0.9, 500),
    arm('advised@codex/auto', 0.91, 9000),
  ]);
  assert.equal(r.kind, 'none');
});

test('recommendFrom: reviewer clearly ahead of baseline → that reviewer, even if pricey', () => {
  const r = recommendFrom([arm('baseline', 0.2, 500), arm('advised@codex/auto', 0.9, 9000)]);
  assert.equal(r.kind, 'reviewer');
  assert.deepEqual(r.kind === 'reviewer' && r.reviewer, { engine: 'codex', model: 'auto' });
});

test('recommendFrom: nothing graded → none', () => {
  assert.equal(recommendFrom([arm('baseline', null, 500)]).kind, 'none');
});
