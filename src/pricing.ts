// Real-$ cost estimation (ROADMAP #13). Token counts are the primary,
// always-comparable metric; dollars are derived and provider-dependent:
//   local        → $0 (free by construction)
//   claude-code  → the CLI's own reported notionalCostUsd (authoritative;
//                  subscription-covered on a plan, real on Vertex/Bedrock)
//   anthropic-api / openai-api → estimated from the table below
//   anything else (codex, unknown models) → null, never a silent guess
//
// PRICES DRIFT. Rows are per MTok, checked against provider pricing pages
// 2026-07; correct here when they move — a wrong row fails loudly in
// pricing.test.ts only if the test constant moves with it, so treat this
// table as data, not gospel.

import type { EngineConfig } from './engines/types.js';
import type { CallResult } from './engines/types.js';
import type { RunResult } from './runner.js';

interface Price {
  inPerM: number;
  outPerM: number;
  cacheReadPerM: number; // discounted re-read
  cacheCreatePerM: number; // write premium (Anthropic 1.25×; OpenAI bills no write premium → = in rate)
}

const anthropic = (inPerM: number, outPerM: number): Price => ({
  inPerM,
  outPerM,
  cacheReadPerM: inPerM * 0.1,
  cacheCreatePerM: inPerM * 1.25,
});

// FIRST match in table order wins (Array.find) — keep more-specific rows
// above generic ones (e.g. "fable-5" before any hypothetical bare "claude").
// Substring match so aliases and dated snapshots ("claude-opus-4-8",
// "claude-opus-4-5-20251101") hit the same row.
const TABLE: Array<{ engine: string; match: string; price: Price }> = [
  { engine: 'anthropic-api', match: 'fable-5', price: anthropic(10, 50) },
  { engine: 'anthropic-api', match: 'opus', price: anthropic(5, 25) },
  { engine: 'anthropic-api', match: 'sonnet', price: anthropic(3, 15) },
  { engine: 'anthropic-api', match: 'haiku', price: anthropic(1, 5) },
  { engine: 'openai-api', match: 'gpt-5', price: { inPerM: 1.25, outPerM: 10, cacheReadPerM: 0.125, cacheCreatePerM: 1.25 } },
];

// $ for one call, or null when the engine/model isn't priceable.
export function costForCall(cfg: EngineConfig, usage: CallResult['usage']): number | null {
  if (cfg.engine === 'local') return 0;
  if (!usage) return null;
  const row = TABLE.find((r) => r.engine === cfg.engine && cfg.model.includes(r.match));
  if (!row) return null;
  const p = row.price;
  return (
    (usage.inputTokens * p.inPerM +
      usage.outputTokens * p.outPerM +
      (usage.cacheReadTokens ?? 0) * p.cacheReadPerM +
      (usage.cacheCreationTokens ?? 0) * p.cacheCreatePerM) /
    1e6
  );
}

// $ for a whole run. A provider-reported notionalCostUsd wins over the table
// (claude-code knows its own bill). One unpriceable call → null for the whole
// run: a partial sum would silently understate cost.
export function estimateRunCostUsd(result: RunResult, builder: EngineConfig, reviewer: EngineConfig): number | null {
  let total = 0;
  for (const r of result.rounds) {
    const sides: Array<[CallResult | null | undefined, EngineConfig]> = [
      [r.builder, builder],
      [r.reviewer, reviewer],
      [r.selfReview, builder], // self-review always runs on the builder model
    ];
    for (const [side, cfg] of sides) {
      if (!side) continue;
      if (side.notionalCostUsd != null) {
        total += side.notionalCostUsd;
        continue;
      }
      const c = costForCall(cfg, side.usage);
      if (c === null) return null;
      total += c;
    }
  }
  return total;
}
