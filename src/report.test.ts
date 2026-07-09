import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, formatReport, reportJson, type RunRecord } from './report.js';

const rec = (
  mode: string,
  score: number | null,
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
): RunRecord => ({
  taskId: 't',
  mode,
  score,
  inputTokens: input,
  outputTokens: output,
  cacheReadTokens: cacheRead,
  cacheCreationTokens: cacheCreate,
  rounds: 1,
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
