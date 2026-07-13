import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseUsageLines, summarizeUsage, formatStats } from './stats.js';

const line = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    ts: '2026-07-13T10:00:00.000Z',
    task: 'do a thing',
    mode: 'advised',
    builder: 'local/qwen2.5:3B',
    reviewer: 'codex/auto',
    consults: 2,
    rounds: 2,
    approvedEarly: true,
    flagged: false,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheCreationTokens: 0,
    notionalCostUsd: null,
    ...over,
  });

test('parseUsageLines: tolerant — malformed lines are skipped, not fatal', () => {
  const { lines, skipped } = parseUsageLines(`${line()}\nnot json at all\n${line({ mode: 'baseline', reviewer: null })}\n`);
  assert.equal(lines.length, 2);
  assert.equal(skipped, 1);
});

test('summarizeUsage: groups by pairing, computes rates and totals, keeps the last run', () => {
  const text = [
    line({ ts: '2026-07-13T09:00:00.000Z' }),
    line({ ts: '2026-07-13T10:00:00.000Z', approvedEarly: false, rounds: 3, flagged: true }),
    line({ ts: '2026-07-13T11:00:00.000Z', mode: 'baseline', reviewer: null, rounds: 1, inputTokens: 40, outputTokens: 20, cacheReadTokens: 0 }),
  ].join('\n');
  const s = summarizeUsage(parseUsageLines(text).lines);
  assert.equal(s.runs, 3);
  assert.equal(s.totalTokens, 160 + 160 + 60);
  const advised = s.pairings.find((p) => p.pairing.includes('advised'))!;
  assert.equal(advised.runs, 2);
  assert.equal(advised.meanRounds, 2.5);
  assert.equal(advised.approvedEarlyRate, 0.5);
  assert.equal(advised.flaggedRate, 0.5);
  assert.equal(s.last?.mode, 'baseline');
  assert.equal(s.since, '2026-07-13T09:00:00.000Z');
});

test('summarizeUsage: cost totals only over priced runs', () => {
  const text = [line({ notionalCostUsd: 0.05 }), line({ notionalCostUsd: null })].join('\n');
  const s = summarizeUsage(parseUsageLines(text).lines);
  assert.equal(s.totalCostUsd, 0.05);
  assert.equal(s.pricedRuns, 1);
});

test('formatStats: human report names pairings and totals', () => {
  const s = summarizeUsage(parseUsageLines([line(), line({ mode: 'baseline', reviewer: null })].join('\n')).lines);
  const out = formatStats(s);
  assert.match(out, /2 runs/);
  assert.match(out, /local\/qwen2\.5:3B → codex\/auto \[advised\]/);
  assert.match(out, /local\/qwen2\.5:3B → \(none\) \[baseline\]/);
});
