import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { findEvidence, validateEvidence, type EvidenceEntry } from './evidence.js';

const ENTRIES: EvidenceEntry[] = [
  { role: 'reviewer', engine: 'local', modelPattern: '(0\\.5b|1\\.5b)', verdict: 'rubber-stamp', note: 'tiny locals approve defects', n: 2, source: 'CHANGELOG §29', date: '2026-07-13' },
  { role: 'reviewer', engine: 'codex', modelPattern: '.*', verdict: 'trustworthy', note: 'codex/auto 5/5', n: 1, source: 'CHANGELOG §30', date: '2026-07-12' },
];

test('findEvidence: engine + model pattern, case-insensitive, role-filtered', () => {
  assert.equal(findEvidence(ENTRIES, 'reviewer', { engine: 'local', model: 'qwen2.5:0.5B' })[0]?.verdict, 'rubber-stamp');
  assert.equal(findEvidence(ENTRIES, 'reviewer', { engine: 'local', model: 'qwen2.5:3B' }).length, 0, 'no 3B entry in this fixture');
  assert.equal(findEvidence(ENTRIES, 'reviewer', { engine: 'codex', model: 'auto' })[0]?.verdict, 'trustworthy');
  assert.equal(findEvidence(ENTRIES, 'builder', { engine: 'local', model: 'qwen2.5:0.5b' }).length, 0, 'role must match');
});

test('shipped evidence file is valid, provenance-tagged, and matches our live findings', () => {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'evidence.json');
  const entries = validateEvidence(JSON.parse(readFileSync(path, 'utf8')));
  assert.ok(entries.length >= 3, 'ships at least the three live-verified priors');
  for (const e of entries) {
    assert.ok(e.note && e.source && e.date, `${e.verdict} entry must carry note+source+date`);
    new RegExp(e.modelPattern, 'i'); // throws if invalid
  }
  const tiny = findEvidence(entries, 'reviewer', { engine: 'local', model: 'qwen2.5:0.5b' });
  assert.equal(tiny[0]?.verdict, 'rubber-stamp', 'the 0.5b rubber-stamp finding is a shipped prior');
});
