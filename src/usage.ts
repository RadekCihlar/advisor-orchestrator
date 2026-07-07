import type { RunResult } from './runner.js';

// Token counts are meaningful (real, comparable across arms). Dollar cost is
// mostly NOT: `local` is always $0, `claude-code` is subscription-covered
// with no actual separate charge — its notionalCostUsd is what the call
// WOULD cost at metered API rates, informational only. Don't read this as
// "we saved $X" — read it as "we used N tokens / M subscription-backed calls".
export function printUsage(result: RunResult): void {
  let inputTokens = 0;
  let outputTokens = 0;
  let notionalCost = 0;
  let callsWithoutUsage = 0;
  let claudeCodeCalls = 0;

  for (const r of result.rounds) {
    for (const side of [r.builder, r.reviewer]) {
      if (!side) continue;
      if (side.usage) {
        inputTokens += side.usage.inputTokens;
        outputTokens += side.usage.outputTokens;
      } else {
        callsWithoutUsage += 1;
      }
      if (side.notionalCostUsd != null) {
        notionalCost += side.notionalCostUsd;
        claudeCodeCalls += 1;
      }
    }
  }

  const lastRound = result.rounds.at(-1);
  console.log(`  mode: ${result.mode}`);
  console.log(`  rounds: ${result.rounds.length}${lastRound?.approved ? ' (reviewer approved early)' : ''}`);
  if (lastRound?.reviewerError) {
    console.log(`  note: reviewer call failed, shipped builder output without review — ${lastRound.reviewerError}`);
  }
  console.log(`  tokens: ${inputTokens} in / ${outputTokens} out${callsWithoutUsage ? ` (${callsWithoutUsage} local call(s) report no token count)` : ''}`);
  if (claudeCodeCalls > 0) {
    console.log(`  notional cost (subscription-covered, NOT a real charge): $${notionalCost.toFixed(4)} across ${claudeCodeCalls} claude-code call(s)`);
  }
}
