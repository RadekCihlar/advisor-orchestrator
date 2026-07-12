// End-to-end integration test (ROADMAP cleaner list): one full bench flow —
// run() across all 5 arms with an injected fake engine, REAL exec grading
// (spawns node on the generated code), aggregate(), formatReport() — so the
// whole pipeline is covered as a system, not just as units. No network, no
// real engines; the only subprocess is node running the graded code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, type Mode } from './runner.js';
import { grade, type Grader } from './grader.js';
import { aggregate, formatReport, type RunRecord } from './report.js';
import { estimateRunCostUsd } from './pricing.js';
import { tallyTokens } from './usage.js';
import type { CallResult, EngineConfig } from './engines/index.js';

const TASK = 'Write a JavaScript function add(a, b) that returns their sum. Reply with only the code.';

const GRADER: Grader = {
  type: 'exec',
  language: 'node',
  tests: `if (add(1, 2) !== 3) throw new Error('1+2 wrong');
if (add(-1, 1) !== 0) throw new Error('-1+1 wrong');`,
};

const BROKEN = 'Here you go:\n```js\nfunction add(a, b) { return a - b; }\n```';
const FIXED = '```js\nfunction add(a, b) { return a + b; }\n```';

// Scripted engine: builder's FIRST call ships the subtraction bug, any revision
// ships the fix; review-role calls (recognizable by the runner's reviewer
// prompt) critique when they see the bug, approve otherwise. Fresh per arm.
function makeFakeCall(): (cfg: EngineConfig, prompt: string) => Promise<CallResult> {
  let builderCalls = 0;
  return async (_cfg, prompt) => {
    const usage = { inputTokens: 100, outputTokens: 50 };
    if (prompt.startsWith('You are reviewing')) {
      const text = prompt.includes('a - b') ? 'The add function subtracts. Change `a - b` to `a + b`.' : 'APPROVED';
      return { text, usage, notionalCostUsd: null };
    }
    builderCalls++;
    return { text: builderCalls === 1 ? BROKEN : FIXED, usage, notionalCostUsd: null };
  };
}

test('e2e: 5-arm bench flow — fake engine, real exec grading, aggregate, report', async () => {
  const builder: EngineConfig = { engine: 'fake', model: 'builder' };
  const reviewer: EngineConfig = { engine: 'fake', model: 'reviewer' };
  const verifier = async (output: string) => {
    const g = await grade(GRADER, output);
    return { passed: g.score === 1, feedback: g.detail };
  };

  const records: RunRecord[] = [];
  const modes: Mode[] = ['baseline', 'self-review', 'advised', 'escalated', 'verify'];
  for (const mode of modes) {
    const result = await run(
      { task: TASK, builder, reviewer, consults: 2, mode, verifier: mode === 'verify' ? verifier : undefined },
      makeFakeCall(),
    );
    const g = await grade(GRADER, result.finalOutput);
    const t = tallyTokens(result);
    records.push({
      taskId: 'add',
      mode,
      score: g.score,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      cacheCreationTokens: t.cacheCreationTokens,
      rounds: result.rounds.length,
      costUsd: estimateRunCostUsd(result, builder, reviewer),
    });
  }

  // Baseline ships the bug (0/2 checks); every arm with a feedback loop fixes it.
  const byMode = new Map(records.map((r) => [r.mode, r]));
  assert.equal(byMode.get('baseline')!.score, 0);
  for (const m of ['self-review', 'advised', 'escalated', 'verify']) {
    assert.equal(byMode.get(m)!.score, 1, `arm ${m} should reach 1.0`);
  }
  // Reviewed arms spent more than baseline's single call.
  assert.ok(byMode.get('advised')!.inputTokens > byMode.get('baseline')!.inputTokens);
  // Fake engine is unpriceable → cost stays null, never a silent guess.
  assert.equal(byMode.get('advised')!.costUsd, null);

  const stats = aggregate(records);
  assert.equal(stats.length, 5);
  const report = formatReport(stats);
  assert.match(report, /Best quality:.*\(score 1\.00\)/);
  assert.match(report, /Cheapest at top quality:/);
  assert.match(report, /baseline/);
  assert.match(report, /small n/i); // 1 run per arm must be called out
});
