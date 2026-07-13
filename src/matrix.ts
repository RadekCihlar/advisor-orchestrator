// Reviewer-matrix logic shared by `bench --reviewers` and `loupe recommend`
// (ROADMAP #8): candidate parsing, arm labels, and the pick. Pure — the
// engine calls stay in the commands.

import type { EngineConfig } from './engines/index.js';
import type { ArmStats } from './report.js';

// "codex/auto, local/qwen2.5:3B" → configs. Only the FIRST slash splits, so
// Ollama-style registry models (library/model:7b) survive.
export function parseReviewerSpecs(list: string): EngineConfig[] {
  const parts = list.split(',').map((p) => p.trim());
  if (parts.length === 0 || parts.every((p) => !p)) throw new Error('reviewer list is empty — expected "engine/model,engine/model,…"');
  return parts.map((p) => {
    const slash = p.indexOf('/');
    if (slash <= 0 || slash === p.length - 1) throw new Error(`bad reviewer spec "${p}" — expected engine/model`);
    return { engine: p.slice(0, slash), model: p.slice(slash + 1) };
  });
}

export const armLabelFor = (cfg: EngineConfig): string => `advised@${cfg.engine}/${cfg.model}`;

// Same ε as the bench verdict: within 2% mean score is "same quality".
export const EPS = 0.02;

export type Recommendation = { kind: 'reviewer'; reviewer: EngineConfig; arm: ArmStats } | { kind: 'none' };

// The matrix verdict: among graded arms, take the top tier (within EPS of the
// best mean score); if baseline is in it, no reviewer earns its keep — the
// honest outcome loupe exists to surface. Otherwise the cheapest top-tier
// reviewer wins.
export function recommendFrom(stats: ArmStats[]): Recommendation {
  const graded = stats.filter((s): s is ArmStats & { meanScore: number } => s.meanScore !== null);
  if (graded.length === 0) return { kind: 'none' };
  const best = Math.max(...graded.map((s) => s.meanScore));
  const topTier = graded.filter((s) => s.meanScore >= best - EPS).sort((a, b) => a.meanTotalTokens - b.meanTotalTokens);
  if (topTier.some((s) => s.mode === 'baseline')) return { kind: 'none' };
  const winner = topTier.find((s) => s.mode.startsWith('advised@'));
  if (!winner) return { kind: 'none' };
  const spec = winner.mode.slice('advised@'.length);
  const slash = spec.indexOf('/');
  return { kind: 'reviewer', reviewer: { engine: spec.slice(0, slash), model: spec.slice(slash + 1) }, arm: winner };
}
