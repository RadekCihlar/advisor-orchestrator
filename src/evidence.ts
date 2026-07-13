// Pairing-evidence priors (ROADMAP v3 #21, v1): a small, curated,
// provenance-tagged dataset of pairing findings shipped with loupe
// (benchmark/evidence.json). probe/recommend consult it BEFORE spending
// tokens — but priors only inform, runs decide: nothing is ever skipped on a
// prior alone. Every entry must carry note + source + date; an unverifiable
// prior is misinformation, not evidence.

import type { EngineConfig } from './engines/index.js';

export interface EvidenceEntry {
  role: 'reviewer' | 'builder';
  engine: string; // exact engine name
  modelPattern: string; // case-insensitive regex over the model name
  verdict: string; // e.g. rubber-stamp | unreliable | trustworthy | capability-floor
  note: string;
  n: number; // how many independent observations back this
  source: string; // where the receipts live (CHANGELOG §, issue, results file)
  date: string;
}

export function validateEvidence(raw: unknown): EvidenceEntry[] {
  if (!Array.isArray(raw)) throw new Error('evidence file: top level must be a JSON array');
  return raw.map((v, i) => {
    const o = v as Record<string, unknown>;
    if (
      (o.role !== 'reviewer' && o.role !== 'builder') ||
      typeof o.engine !== 'string' ||
      typeof o.modelPattern !== 'string' ||
      typeof o.verdict !== 'string' ||
      typeof o.note !== 'string' ||
      typeof o.n !== 'number' ||
      typeof o.source !== 'string' ||
      typeof o.date !== 'string'
    ) {
      throw new Error(`evidence file: entry ${i} needs { role, engine, modelPattern, verdict, note, n, source, date }`);
    }
    return o as unknown as EvidenceEntry;
  });
}

export function findEvidence(entries: EvidenceEntry[], role: EvidenceEntry['role'], cfg: EngineConfig): EvidenceEntry[] {
  return entries.filter(
    (e) => e.role === role && e.engine === cfg.engine && new RegExp(e.modelPattern, 'i').test(cfg.model),
  );
}

export function formatPriors(entries: EvidenceEntry[], cfg: EngineConfig): string[] {
  return entries.map(
    (e) => `prior (shipped evidence): ${cfg.engine}/${cfg.model} → ${e.verdict} — ${e.note} (n=${e.n}, ${e.source}, ${e.date})`,
  );
}
