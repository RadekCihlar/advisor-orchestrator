import type { RunResult } from './runner.js';

export interface TokenTally {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  notionalCost: number;
  claudeCodeCalls: number;
  callsWithoutUsage: number;
}

// Sum every call in a run (builder + reviewer + escalated self-review). Shared by
// printUsage and the benchmark's per-run records.
export function tallyTokens(result: RunResult): TokenTally {
  const t: TokenTally = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    notionalCost: 0,
    claudeCodeCalls: 0,
    callsWithoutUsage: 0,
  };

  for (const r of result.rounds) {
    for (const side of [r.builder, r.reviewer, r.selfReview]) {
      if (!side) continue;
      if (side.usage) {
        t.inputTokens += side.usage.inputTokens;
        t.outputTokens += side.usage.outputTokens;
        t.cacheReadTokens += side.usage.cacheReadTokens ?? 0;
        t.cacheCreationTokens += side.usage.cacheCreationTokens ?? 0;
      } else {
        t.callsWithoutUsage += 1;
      }
      if (side.notionalCostUsd != null) {
        t.notionalCost += side.notionalCostUsd;
        t.claudeCodeCalls += 1;
      }
    }
  }
  return t;
}

// Token counts are meaningful (real, comparable across arms). Dollar cost mostly
// is NOT: `local` is $0; `claude-code` is subscription-covered on a Claude.ai
// plan but genuinely metered on Vertex/Bedrock — its notionalCostUsd is what the
// call reports, informational only. Read it as tokens/calls, not "we saved $X".
export function printUsage(result: RunResult): void {
  const t = tallyTokens(result);
  const lastRound = result.rounds.at(-1);
  console.log(`  mode: ${result.mode}`);
  console.log(`  rounds: ${result.rounds.length}${lastRound?.approved ? ' (reviewer approved early)' : ''}`);
  if (lastRound?.reviewerError) {
    console.log(`  note: reviewer call failed, shipped builder output without review — ${lastRound.reviewerError}`);
  }
  console.log(
    `  tokens: ${t.inputTokens} in / ${t.outputTokens} out${t.callsWithoutUsage ? ` (${t.callsWithoutUsage} local call(s) report no token count)` : ''}`,
  );
  if (t.claudeCodeCalls > 0) {
    console.log(`  cache: ${t.cacheReadTokens} read / ${t.cacheCreationTokens} creation (creation = one-time cold-start tax)`);
    console.log(
      `  notional cost (subscription-covered on a plan, metered on Vertex/Bedrock): $${t.notionalCost.toFixed(4)} across ${t.claudeCodeCalls} claude-code call(s)`,
    );
  }
}
