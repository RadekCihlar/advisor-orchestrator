import { test } from 'node:test';
import assert from 'node:assert/strict';
import { run, isApproval, stripMarker } from './runner.js';
import type { EngineConfig, CallResult } from './engines/index.js';

// Injected fake engine — lets us test the loop's control flow (who gets
// called, when it stops, what feedback flows back) with zero real API calls.
const B: EngineConfig = { engine: 'local', model: 'builder-model' };
const R: EngineConfig = { engine: 'local', model: 'reviewer-model' };

const mk = (text: string): CallResult => ({ text, usage: { inputTokens: 1, outputTokens: 1 }, notionalCostUsd: null });
const isReviewPrompt = (p: string) => p.startsWith('You are reviewing');

test('baseline: one builder pass, no reviewer', async () => {
  let builderCalls = 0;
  let reviewerCalls = 0;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) reviewerCalls++;
    else builderCalls++;
    return mk('BUILD');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 2, mode: 'baseline' }, fake);

  assert.equal(r.finalOutput, 'BUILD');
  assert.equal(r.rounds.length, 1);
  assert.equal(builderCalls, 1);
  assert.equal(reviewerCalls, 0);
  assert.equal(r.rounds[0].reviewer, null);
});

test('advised: reviewer APPROVED round 0 → early break', async () => {
  let builderCalls = 0;
  let reviewerCalls = 0;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      reviewerCalls++;
      return mk('APPROVED');
    }
    builderCalls++;
    return mk('BUILD');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised' }, fake);

  assert.equal(r.rounds.length, 1, 'should stop after approval, not burn remaining consults');
  assert.equal(builderCalls, 1);
  assert.equal(reviewerCalls, 1);
  assert.equal(r.rounds[0].approved, true);
});

test('advised: critique then approve, feedback flows into next builder prompt', async () => {
  let reviewerCalls = 0;
  const builderPrompts: string[] = [];
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      reviewerCalls++;
      return reviewerCalls === 1 ? mk('please fix the off-by-one') : mk('APPROVED');
    }
    builderPrompts.push(prompt);
    return mk(`BUILD-${builderPrompts.length}`);
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised' }, fake);

  assert.equal(r.rounds.length, 2);
  assert.equal(reviewerCalls, 2);
  assert.equal(r.finalOutput, 'BUILD-2');
  assert.match(builderPrompts[1], /Reviewer feedback:/);
  assert.match(builderPrompts[1], /off-by-one/, 'reviewer critique must reach the builder');
});

test('advised: reviewer failure ships builder output without review', async () => {
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) throw new Error('rate_limited');
    return mk('BUILD');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 2, mode: 'advised' }, fake);

  assert.equal(r.rounds.length, 1, 'reviewer error → approved=true → break');
  assert.equal(r.finalOutput, 'BUILD');
  assert.equal(r.rounds[0].approved, true);
  assert.match(r.rounds[0].reviewerError ?? '', /rate_limited/);
});

test('escalated: self-review approves → bigger reviewer never called', async () => {
  let opusCalls = 0;
  const fake = async (cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      if (cfg.model === R.model) opusCalls++;
      // self-review (builder-model reviewer) approves immediately
      return cfg.model === B.model ? mk('APPROVED') : mk('opus critique');
    }
    return mk('BUILD');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 2, mode: 'escalated' }, fake);

  assert.equal(opusCalls, 0, 'no escalation when self-review is satisfied');
  assert.equal(r.rounds.length, 1);
  assert.notEqual(r.rounds[0].selfReview, null);
  assert.equal(r.rounds[0].reviewer, null);
  assert.equal(r.rounds[0].escalated ?? false, false);
});

test('escalated: self never approves → bigger reviewer fires exactly once', async () => {
  let opusCalls = 0;
  const builderPrompts: string[] = [];
  const fake = async (cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      if (cfg.model === R.model) {
        opusCalls++;
        return mk('opus says fix the loop bound');
      }
      return mk('self says something is off'); // self-review, never approves
    }
    builderPrompts.push(prompt);
    return mk(`BUILD-${builderPrompts.length}`);
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'escalated' }, fake);

  assert.equal(opusCalls, 1, 'bigger reviewer is bounded to at most one call per run');
  assert.equal(r.rounds.filter((x) => x.escalated).length, 1, 'exactly one round is the escalation round');
  assert.equal(r.rounds.length, 4, 'runs to the last round (consults=3 → rounds 0..3)');
  assert.match(builderPrompts[1], /opus says fix the loop bound/, 'escalated feedback must reach the builder');
});

test('verify mode: verifier fails then passes → revises with feedback, no LLM reviewer', async () => {
  let verifyCalls = 0;
  const builderPrompts: string[] = [];
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    builderPrompts.push(prompt);
    return mk(`BUILD-${builderPrompts.length}`);
  };
  const verifier = async (_output: string) => {
    verifyCalls++;
    return verifyCalls === 1
      ? { passed: false, feedback: 'test_foo failed: expected 5 got 6' }
      : { passed: true, feedback: '' };
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'verify', verifier }, fake);

  assert.equal(verifyCalls, 2);
  assert.equal(r.rounds.length, 2, 'passes on round 2 → stops early');
  assert.equal(r.rounds[0].approved, false);
  assert.equal(r.rounds[1].approved, true);
  assert.match(builderPrompts[1], /test_foo failed/, 'verifier feedback must reach the builder');
  assert.ok(r.rounds.every((x) => x.reviewer === null), 'verify mode makes no LLM reviewer calls');
  assert.equal(r.rounds[0].verify?.passed, false);
});

test('isApproval: strict — bare APPROVED yes, "APPROVED, but…" no', () => {
  assert.equal(isApproval('APPROVED'), true);
  assert.equal(isApproval('  "Approved."  '), true);
  assert.equal(isApproval('APPROVED\nno further notes'), true);
  assert.equal(isApproval('APPROVED, but rename the variable'), false);
  assert.equal(isApproval('Not approved'), false);
});

test('stripMarker: removes marker and flags; no marker → unchanged', () => {
  assert.deepEqual(stripMarker('X\n<<needs-review>>'), { text: 'X', flagged: true });
  assert.deepEqual(stripMarker('X'), { text: 'X', flagged: false });
});

test('escalated: builder marker skips self-review and fires the escalation immediately', async () => {
  const calls: string[] = [];
  const fake = async (cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      calls.push(`review:${cfg.model}`);
      return mk('APPROVED');
    }
    calls.push(`build:${cfg.model}`);
    return mk('BUILD <<needs-review>>');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 2, mode: 'escalated' }, fake);

  // no self-review call by builder-model on the review prompt — straight to reviewer-model
  assert.deepEqual(calls, ['build:builder-model', 'review:reviewer-model']);
  assert.equal(r.rounds[0].flagged, true);
  assert.equal(r.rounds[0].escalated, true);
  assert.equal(r.finalOutput, 'BUILD', 'marker must be stripped from shipped output');
});

test('escalated: builder prompt carries the marker instruction; advised does not', async () => {
  const prompts: string[] = [];
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    prompts.push(prompt);
    return mk('APPROVED');
  };
  await run({ task: 't', builder: B, reviewer: R, consults: 1, mode: 'escalated' }, fake);
  assert.match(prompts[0], /<<needs-review>>/);
  prompts.length = 0;
  await run({ task: 't', builder: B, reviewer: R, consults: 1, mode: 'advised' }, fake);
  assert.doesNotMatch(prompts[0], /<<needs-review>>/);
});
