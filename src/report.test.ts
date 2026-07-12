import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, diffReports, formatReport, reportJson, type RunRecord } from './report.js';

const rec = (
  mode: string,
  score: number | null,
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
  costUsd: number | null = null,
): RunRecord => ({
  taskId: 't',
  mode,
  score,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreate,
  rounds: 1,
  costUsd,
});

test('aggregate: means + score range per arm', () => {
  const stats = aggregate([
    rec('baseline', 1, 100, 50),
    rec('baseline', 0, 200, 60),
    rec('advised', 1, 400, 80, 6000, 500),
  ]);
  const baseline = stats.find((s) => s.mode === 'baseline')!;
  assert.equal(baseline.runs, 2);
  assert.equal(baseline.meanScore, 0.5);
  assert.deepEqual(baseline.scoreRange, [0, 1]);
  assert.equal(baseline.meanInputTokens, 150);
  const advised = stats.find((s) => s.mode === 'advised')!;
  assert.equal(advised.meanCacheReadTokens, 500);
  assert.equal(advised.meanTotalTokens, 400 + 80 + 500 + 6000);
});

test('aggregate: ungraded arm → meanScore null', () => {
  const stats = aggregate([rec('baseline', null, 100, 50)]);
  assert.equal(stats[0].meanScore, null);
  assert.equal(stats[0].gradedRuns, 0);
});

test('formatReport: graded set names best quality + cheapest-at-top + vs-baseline', () => {
  const out = formatReport(
    aggregate([
      rec('baseline', 0.6, 100, 50),
      rec('self-review', 0.9, 250, 90),
      rec('advised', 0.9, 4000, 120, 6000),
    ]),
  );
  assert.match(out, /Best quality:\s+self-review, advised \(score 0\.90\)/);
  // self-review ties advised on quality but is far cheaper → cheapest at top
  assert.match(out, /Cheapest at top quality: self-review/);
  assert.match(out, /advised: \+0\.30 quality vs baseline at/);
});

test('formatReport: near-tie cheaper arm gets the cost-aware callout (ROADMAP #5)', () => {
  const out = formatReport(
    aggregate([
      rec('baseline', 0.6, 100, 50),
      rec('self-review', 0.89, 250, 90), // within EPS of best, ~0.06× advised's tokens
      rec('advised', 0.9, 4000, 120, 1000),
    ]),
  );
  // 0.01 below best, at a fraction of the tokens → callout names both arms + the trade
  assert.match(out, /self-review matches advised within 0\.01 at 0\.1× its tokens/);
});

test('formatReport: no cost-aware callout when the best arm is also cheapest at top', () => {
  const out = formatReport(
    aggregate([
      rec('baseline', 0.6, 100, 50),
      rec('advised', 0.9, 400, 120),
    ]),
  );
  assert.doesNotMatch(out, /matches .* within/);
});

test('formatReport: significance — clear separation between top arm and runner-up (ROADMAP #4)', () => {
  const out = formatReport(
    aggregate([
      rec('baseline', 0.5, 100, 50), rec('baseline', 0.55, 100, 50), rec('baseline', 0.45, 100, 50),
      rec('advised', 1.0, 400, 80), rec('advised', 0.9, 400, 80), rec('advised', 0.95, 400, 80),
    ]),
  );
  assert.match(out, /Significance:\s+advised \+0\.45 vs baseline — clear at this n/);
});

test('formatReport: significance — overlapping arms are called inconclusive with a repeat estimate', () => {
  const out = formatReport(
    aggregate([
      rec('baseline', 0.5, 100, 50), rec('baseline', 0.8, 100, 50),
      rec('advised', 0.6, 400, 80), rec('advised', 0.9, 400, 80),
    ]),
  );
  assert.match(out, /Significance:\s+advised \+0\.10 vs baseline — inconclusive at this n, run ~\d+ more repeats/);
});

test('formatReport: significance — n<2 on an arm says more repeats are needed', () => {
  const out = formatReport(aggregate([rec('baseline', 0.5, 100, 50), rec('advised', 0.9, 400, 80)]));
  assert.match(out, /Significance:\s+n too small .*--repeat/);
});

test('formatReport: ungraded set explains how to get a verdict', () => {
  const out = formatReport(aggregate([rec('baseline', null, 100, 50), rec('advised', null, 4000, 120)]));
  assert.match(out, /no graders/);
  assert.match(out, /Cheapest arm: baseline/);
});

test('reportJson bundles meta + stats + records and round-trips through JSON', () => {
  const records = [rec('baseline', 1, 10, 5), rec('advised', 1, 40, 8, 6000, 500)];
  const j = reportJson({ builder: 'claude-code/opus', consults: 1 }, aggregate(records), records);
  assert.equal(j.meta.builder, 'claude-code/opus');
  assert.equal(j.records.length, 2);
  assert.ok(j.stats.some((s) => s.mode === 'advised'));
  assert.deepEqual(JSON.parse(JSON.stringify(j)).meta, j.meta); // serializable
});

test('aggregate: stddevScore is the sample stddev; null under 2 graded runs', () => {
  const recs = [
    { taskId: 't', mode: 'advised', score: 0.5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1, costUsd: null },
    { taskId: 't', mode: 'advised', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1, costUsd: null },
    { taskId: 't', mode: 'baseline', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1, costUsd: null },
  ];
  const stats = aggregate(recs);
  const advised = stats.find((s) => s.mode === 'advised')!;
  const baseline = stats.find((s) => s.mode === 'baseline')!;
  assert.ok(Math.abs(advised.stddevScore! - 0.35355) < 1e-4);
  assert.equal(baseline.stddevScore, null);
});

test('aggregate: meanCostUsd averages when all runs priced, null when any is not', () => {
  const priced = aggregate([rec('baseline', 1, 1, 1, 0, 0, 0.1), rec('baseline', 1, 1, 1, 0, 0, 0.3)]);
  assert.equal(priced[0].meanCostUsd, 0.2);
  const mixed = aggregate([rec('advised', 1, 1, 1, 0, 0, 0.1), rec('advised', 1, 1, 1, 0, 0, null)]);
  assert.equal(mixed[0].meanCostUsd, null);
});

test('formatReport: $/task column shows cost when priced, — when not', () => {
  const out = formatReport(aggregate([rec('baseline', 1, 1, 1, 0, 0, 0.1234), rec('advised', 1, 1, 1, 0, 0, null)]));
  assert.match(out, /\$\/task/);
  assert.match(out, /\$0\.12/);
  assert.match(out, /advised.*—\s*$/m);
});

test('diffReports: per-arm score and token deltas between two result files', () => {
  const a = reportJson({ generatedAt: '2026-07-10T00:00:00Z' }, aggregate([rec('baseline', 0.5, 100, 50), rec('advised', 0.7, 400, 80)]), []);
  const b = reportJson({ generatedAt: '2026-07-11T00:00:00Z' }, aggregate([rec('baseline', 0.75, 110, 55), rec('advised', 0.7, 380, 70)]), []);
  const out = diffReports(a, b);
  assert.match(out, /baseline\s+0\.50 → 0\.75\s+\+0\.25/);
  assert.match(out, /advised\s+0\.70 → 0\.70\s+±0\.00/);
  assert.match(out, /2026-07-10T00:00:00Z/); // shows which run is which
  assert.match(out, /2026-07-11T00:00:00Z/);
});

test('diffReports: arms present in only one file are flagged, not dropped', () => {
  const a = reportJson({}, aggregate([rec('baseline', 0.5, 100, 50)]), []);
  const b = reportJson({}, aggregate([rec('baseline', 0.5, 100, 50), rec('verify', 0.9, 120, 60)]), []);
  const out = diffReports(a, b);
  assert.match(out, /verify\s+\(only in B\)/);
});

test('diffReports: ungraded arm shows token delta with score placeholder', () => {
  const a = reportJson({}, aggregate([rec('baseline', null, 100, 50)]), []);
  const b = reportJson({}, aggregate([rec('baseline', null, 200, 100)]), []);
  const out = diffReports(a, b);
  assert.match(out, /baseline\s+— → —/);
  assert.match(out, /150 → 300/); // meanTotalTokens A → B
});

test('diffReports: zero tokens in A shows bare — placeholder, not "+—"', () => {
  const a = reportJson({}, aggregate([rec('baseline', null, 0, 0)]), []);
  const b = reportJson({}, aggregate([rec('baseline', null, 200, 100)]), []);
  const out = diffReports(a, b);
  assert.doesNotMatch(out, /\+—/);
});

test('formatReport: shows ±stddev and warns on small n', () => {
  const recs = [
    { taskId: 't', mode: 'advised', score: 0.5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1, costUsd: null },
    { taskId: 't', mode: 'advised', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1, costUsd: null },
  ];
  const out = formatReport(aggregate(recs));
  assert.match(out, /±0\.35/);
  assert.match(out, /small n/i);
});
