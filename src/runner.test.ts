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

// --- lean protocol (--lean): delta re-review + capped critique ---

const isAnyReviewPrompt = (p: string) => p.startsWith('You are reviewing') || p.startsWith('You are re-reviewing');
// Realistic-length lines: the lean-vs-full economy compares whole prompts, so
// toy 8-char lines would make template overhead dominate and skew every test.
const bigOut = (marker: string) =>
  Array.from({ length: 30 }, (_, i) => (i === 7 ? `line ${i} ${marker}` : `line ${i} of the generated artifact content`)).join('\n');

test('lean advised: round 1 reviewer gets its critique + the diff, not the full output', async () => {
  const reviewerPrompts: string[] = [];
  let builds = 0;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isAnyReviewPrompt(prompt)) {
      reviewerPrompts.push(prompt);
      return reviewerPrompts.length === 1 ? mk('fix line 7, it is wrong') : mk('APPROVED');
    }
    builds++;
    return mk(bigOut(builds === 1 ? 'v1' : 'v2'));
  };

  const r = await run({ task: 'the task', builder: B, reviewer: R, consults: 3, mode: 'advised', lean: true }, fake);

  assert.equal(r.rounds.length, 2);
  assert.ok(reviewerPrompts[0].startsWith('You are reviewing'), 'round 0 must use the standard full prompt');
  assert.ok(reviewerPrompts[0].includes(bigOut('v1')), 'round 0 sees the full output');
  assert.ok(reviewerPrompts[1].startsWith('You are re-reviewing'), 'round 1 uses the delta prompt');
  assert.ok(reviewerPrompts[1].includes('fix line 7, it is wrong'), 'delta prompt carries the previous critique');
  assert.ok(reviewerPrompts[1].includes('+ line 7 v2'), 'delta prompt carries the changed line');
  assert.ok(!reviewerPrompts[1].includes('line 20'), 'unchanged far-away lines must not be re-sent');
});

test('lean advised: builder rewrites everything → falls back to the full prompt', async () => {
  const reviewerPrompts: string[] = [];
  let builds = 0;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isAnyReviewPrompt(prompt)) {
      reviewerPrompts.push(prompt);
      return reviewerPrompts.length === 1 ? mk('start over') : mk('APPROVED');
    }
    builds++;
    return builds === 1 ? mk(bigOut('v1')) : mk('completely different\nrewrite');
  };

  await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised', lean: true }, fake);

  assert.equal(reviewerPrompts.length, 2);
  assert.ok(reviewerPrompts[1].startsWith('You are reviewing'), 'rewrite → delta pointless → standard full prompt');
  assert.ok(reviewerPrompts[1].includes('completely different\nrewrite'));
});

test('lean: runaway critique is capped before reaching the builder', async () => {
  const builderPrompts: string[] = [];
  let reviews = 0;
  const rant = 'x'.repeat(5000);
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isAnyReviewPrompt(prompt)) {
      reviews++;
      return reviews === 1 ? mk(rant) : mk('APPROVED');
    }
    builderPrompts.push(prompt);
    return mk(bigOut(`v${builderPrompts.length}`));
  };

  await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised', lean: true }, fake);

  assert.equal(builderPrompts.length, 2);
  assert.ok(builderPrompts[1].includes('[critique truncated]'), 'cap marker present');
  assert.ok(builderPrompts[1].length < 3000, `revise prompt should not echo the 5000-char rant (got ${builderPrompts[1].length})`);
});

test('no lean: round 1 reviewer still gets the standard full prompt (unchanged default)', async () => {
  const reviewerPrompts: string[] = [];
  let builds = 0;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isAnyReviewPrompt(prompt)) {
      reviewerPrompts.push(prompt);
      return reviewerPrompts.length === 1 ? mk('fix line 7') : mk('APPROVED');
    }
    builds++;
    return mk(bigOut(`v${builds}`));
  };

  await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised' }, fake);

  assert.ok(reviewerPrompts[1].startsWith('You are reviewing'), 'default protocol untouched');
  assert.ok(reviewerPrompts[1].includes(bigOut('v2')), 'full output still sent by default');
});

test('lean verify: test-failure feedback is ground truth — never capped', async () => {
  const builderPrompts: string[] = [];
  const failures = `assertion failed: ${'y'.repeat(4000)}`;
  let checks = 0;
  const verifier = async (_out: string) => {
    checks++;
    return checks === 1 ? { passed: false, feedback: failures } : { passed: true, feedback: '' };
  };
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    builderPrompts.push(prompt);
    return mk(bigOut(`v${builderPrompts.length}`));
  };

  await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'verify', lean: true, verifier }, fake);

  assert.equal(builderPrompts.length, 2);
  assert.ok(builderPrompts[1].includes(failures), 'verify feedback must reach the builder in full');
});

test('caching metadata: every builder/reviewer call carries a stable-prefix length covering the task', async () => {
  const seen: Array<{ prompt: string; len: number | undefined }> = [];
  let reviews = 0;
  const fake = async (_cfg: EngineConfig, prompt: string, opts?: { cachedPrefixLen?: number }): Promise<CallResult> => {
    seen.push({ prompt, len: opts?.cachedPrefixLen });
    if (isAnyReviewPrompt(prompt)) {
      reviews++;
      return reviews === 1 ? mk('fix line 7') : mk('APPROVED');
    }
    return mk(bigOut(`v${seen.length}`));
  };

  await run({ task: 'my special task', builder: B, reviewer: R, consults: 2, mode: 'advised' }, fake);

  assert.ok(seen.length >= 4, 'two rounds: 2 builder + 2 reviewer calls');
  for (const s of seen) {
    assert.ok((s.len ?? 0) > 0, `call missing cachedPrefixLen: ${s.prompt.slice(0, 40)}`);
    assert.ok(s.len! <= s.prompt.length, 'prefix must not overrun the prompt');
    assert.ok(s.prompt.slice(0, s.len).includes('my special task'), 'prefix covers the task statement');
  }
  const builderLens = new Set(seen.filter((s) => !isAnyReviewPrompt(s.prompt)).map((s) => s.len));
  assert.equal(builderLens.size, 1, 'builder prefix stable across rounds → cache hit on round 1');
});

test('lean: small diff but critique echo makes the delta prompt bigger → standard prompt wins', async () => {
  // Live-observed on local 3B (2026-07-13): short output + long round-0
  // critique → the delta prompt (header + echoed critique + diff) came out
  // LARGER than the standard full prompt. Economy must hold at the whole-
  // prompt level, not just diff-vs-output.
  const reviewerPrompts: string[] = [];
  let builds = 0;
  const longCritique = `the approach is wrong because ${'reasons '.repeat(200)}`;
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isAnyReviewPrompt(prompt)) {
      reviewerPrompts.push(prompt);
      return reviewerPrompts.length === 1 ? mk(longCritique) : mk('APPROVED');
    }
    builds++;
    return mk(bigOut(`v${builds}`)); // 30 short lines, one changed → diff itself is small
  };

  await run({ task: 't', builder: B, reviewer: R, consults: 3, mode: 'advised', lean: true }, fake);

  assert.ok(
    reviewerPrompts[1].startsWith('You are reviewing'),
    'when the delta prompt is not actually smaller, send the standard one',
  );
});
