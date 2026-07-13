// `loupe stats` (ROADMAP v3 #16): turn the usage.jsonl run history that
// already accumulates into local evidence — which pairings you actually run,
// what they cost, how often the reviewer approves early. Pure functions here;
// file I/O stays in the command. --json output is stable for statuslines and
// scripts.

export interface UsageLine {
  ts: string;
  mode: string;
  builder: string;
  reviewer: string | null;
  rounds: number;
  approvedEarly: boolean;
  flagged: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  notionalCostUsd: number | null;
}

// Tolerant by design: the log is append-only across versions, so unknown or
// malformed lines are counted and skipped, never fatal.
export function parseUsageLines(text: string): { lines: UsageLine[]; skipped: number } {
  const lines: UsageLine[] = [];
  let skipped = 0;
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (typeof o.ts !== 'string' || typeof o.mode !== 'string' || typeof o.builder !== 'string' || typeof o.rounds !== 'number') {
        skipped++;
        continue;
      }
      lines.push({
        ts: o.ts,
        mode: o.mode,
        builder: o.builder,
        reviewer: typeof o.reviewer === 'string' ? o.reviewer : null,
        rounds: o.rounds,
        approvedEarly: o.approvedEarly === true,
        flagged: o.flagged === true,
        inputTokens: typeof o.inputTokens === 'number' ? o.inputTokens : 0,
        outputTokens: typeof o.outputTokens === 'number' ? o.outputTokens : 0,
        cacheReadTokens: typeof o.cacheReadTokens === 'number' ? o.cacheReadTokens : 0,
        cacheCreationTokens: typeof o.cacheCreationTokens === 'number' ? o.cacheCreationTokens : 0,
        notionalCostUsd: typeof o.notionalCostUsd === 'number' ? o.notionalCostUsd : null,
      });
    } catch {
      skipped++;
    }
  }
  return { lines, skipped };
}

export interface PairingStats {
  pairing: string; // "builder → reviewer [mode]"
  runs: number;
  meanRounds: number;
  approvedEarlyRate: number;
  flaggedRate: number;
  totalTokens: number;
  totalCostUsd: number | null; // sum over priced runs; null when none priced
}

export interface StatsSummary {
  runs: number;
  since: string | null; // earliest ts
  totalTokens: number;
  totalCostUsd: number | null;
  pricedRuns: number;
  pairings: PairingStats[];
  last: UsageLine | null; // most recent run — statusline material
}

const tokensOf = (l: UsageLine): number =>
  l.inputTokens + l.outputTokens + (l.cacheReadTokens ?? 0) + (l.cacheCreationTokens ?? 0);

export function summarizeUsage(lines: UsageLine[]): StatsSummary {
  const byPairing = new Map<string, UsageLine[]>();
  for (const l of lines) {
    const key = `${l.builder} → ${l.reviewer ?? '(none)'} [${l.mode}]`;
    const list = byPairing.get(key);
    if (list) list.push(l);
    else byPairing.set(key, [l]);
  }
  const pairings: PairingStats[] = [...byPairing]
    .map(([pairing, ls]) => {
      const priced = ls.filter((l) => l.notionalCostUsd !== null);
      return {
        pairing,
        runs: ls.length,
        meanRounds: ls.reduce((a, l) => a + l.rounds, 0) / ls.length,
        approvedEarlyRate: ls.filter((l) => l.approvedEarly).length / ls.length,
        flaggedRate: ls.filter((l) => l.flagged).length / ls.length,
        totalTokens: ls.reduce((a, l) => a + tokensOf(l), 0),
        totalCostUsd: priced.length ? priced.reduce((a, l) => a + (l.notionalCostUsd as number), 0) : null,
      };
    })
    .sort((a, b) => b.runs - a.runs);

  const sorted = [...lines].sort((a, b) => a.ts.localeCompare(b.ts));
  const priced = lines.filter((l) => l.notionalCostUsd !== null);
  return {
    runs: lines.length,
    since: sorted[0]?.ts ?? null,
    totalTokens: lines.reduce((a, l) => a + tokensOf(l), 0),
    totalCostUsd: priced.length ? priced.reduce((a, l) => a + (l.notionalCostUsd as number), 0) : null,
    pricedRuns: priced.length,
    pairings,
    last: sorted.at(-1) ?? null,
  };
}

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');
const pct = (x: number): string => `${Math.round(x * 100)}%`;

export function formatStats(s: StatsSummary): string {
  if (s.runs === 0) return 'No runs logged yet — every completed `loupe run`/`bench` arm appends one line to usage.jsonl.';
  const lines: string[] = [];
  lines.push(`=== loupe stats — ${s.runs} runs since ${s.since?.slice(0, 10) ?? '?'} ===`);
  lines.push(
    `total tokens: ${n0(s.totalTokens)}${s.totalCostUsd !== null ? `   est. $${s.totalCostUsd.toFixed(4)} over ${s.pricedRuns} priced run(s)` : '   (no priced runs)'}`,
  );
  lines.push('');
  const w = Math.max(12, ...s.pairings.map((p) => p.pairing.length));
  lines.push(`${'pairing'.padEnd(w)} ${'runs'.padStart(5)} ${'rounds'.padStart(7)} ${'approved'.padStart(9)} ${'flagged'.padStart(8)} ${'tokens'.padStart(10)}`);
  for (const p of s.pairings) {
    lines.push(
      `${p.pairing.padEnd(w)} ${String(p.runs).padStart(5)} ${p.meanRounds.toFixed(1).padStart(7)} ${pct(p.approvedEarlyRate).padStart(9)} ${pct(p.flaggedRate).padStart(8)} ${n0(p.totalTokens).padStart(10)}`,
    );
  }
  if (s.last) {
    lines.push('');
    lines.push(`last run: ${s.last.ts}  ${s.last.mode}  ${s.last.builder} → ${s.last.reviewer ?? '(none)'}  ${s.last.rounds} round(s)`);
  }
  return lines.join('\n');
}
