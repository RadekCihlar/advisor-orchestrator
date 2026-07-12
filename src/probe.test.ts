import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatProbeReport, probeReviewer, validateProbeItems, type ProbeItem } from './probe.js';
import type { CallResult } from './engines/index.js';

const quiet = () => {};
const reviewer = { engine: 'local', model: 'fake' };

const items: ProbeItem[] = [
  { id: 'bad-1', task: 't', output: 'broken', defective: true },
  { id: 'bad-2', task: 't', output: 'also broken', defective: true },
  { id: 'good-1', task: 't', output: 'fine', defective: false },
  { id: 'good-2', task: 't', output: 'also fine', defective: false },
];

const approveAll = async (): Promise<CallResult> => ({ text: 'APPROVED', usage: null, notionalCostUsd: null });

test('probe: approve-everything reviewer → catch rate 0, rubber-stamp verdict', async () => {
  const r = await probeReviewer(items, reviewer, approveAll, quiet);
  assert.equal(r.catchRate, 0);
  assert.equal(r.falseAlarmRate, 0); // approving good output is correct
  assert.equal(r.verdict, 'rubber-stamp');
  assert.match(formatProbeReport(reviewer, r), /RUBBER-STAMP/);
});

test('probe: perfect reviewer → catch rate 1, no false alarms, trustworthy', async () => {
  const perfect = async (_cfg: unknown, prompt: string): Promise<CallResult> => ({
    text: prompt.includes('broken') ? 'The code is broken: it crashes.' : 'APPROVED',
    usage: null,
    notionalCostUsd: null,
  });
  const r = await probeReviewer(items, reviewer, perfect as never, quiet);
  assert.equal(r.catchRate, 1);
  assert.equal(r.falseAlarmRate, 0);
  assert.equal(r.verdict, 'trustworthy');
  assert.doesNotMatch(formatProbeReport(reviewer, r), /RUBBER-STAMP/);
});

test('probe: reject-everything reviewer → full catch but over-critical', async () => {
  const rejectAll = async (): Promise<CallResult> => ({ text: 'Wrong.', usage: null, notionalCostUsd: null });
  const r = await probeReviewer(items, reviewer, rejectAll, quiet);
  assert.equal(r.catchRate, 1);
  assert.equal(r.falseAlarmRate, 1);
  assert.equal(r.verdict, 'over-critical');
});

test('probe: errored calls are excluded from rates, listed in the report', async () => {
  let n = 0;
  const flaky = async (): Promise<CallResult> => {
    n++;
    if (n === 1) throw new Error('429');
    return { text: 'Wrong.', usage: null, notionalCostUsd: null };
  };
  const r = await probeReviewer(items, reviewer, flaky, quiet);
  assert.equal(r.defectsTotal, 1); // bad-1 errored out (retryOnce is above this layer)
  assert.match(formatProbeReport(reviewer, r), /1 item\(s\) errored.*bad-1/);
});

test('validateProbeItems: rejects a fixture set with only one class', () => {
  assert.throws(() => validateProbeItems([{ id: 'x', task: 't', output: 'o', defective: true }]), /one defective AND one correct/);
  assert.throws(() => validateProbeItems({ not: 'an array' }), /array/);
});

test('shipped benchmark/probe.json is valid and balanced', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'probe.json');
  const items = validateProbeItems(JSON.parse(readFileSync(path, 'utf8')));
  const defective = items.filter((x) => x.defective).length;
  assert.ok(defective >= 3, 'need enough planted defects for a meaningful rate');
  assert.ok(items.length - defective >= 3, 'need enough correct items to measure false alarms');
  assert.ok(items.every((x) => x.note), 'every fixture documents its defect or why it is correct');
});
