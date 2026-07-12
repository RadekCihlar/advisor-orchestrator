// Turns per-run records into the benchmark's actual product: a quality×cost
// table + a verdict. This is what lets the tool answer "does the reviewer help,
// and at what cost?" automatically instead of by eyeball.

export interface RunRecord {
  taskId: string;
  mode: string; // arm
  score: number | null; // null = ungraded (task had no grader, or judge failed)
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  rounds: number;
  // Estimated real dollars for the run (src/pricing.ts), null when any call in
  // the run wasn't priceable. Tokens stay the primary metric; $ is derived.
  costUsd: number | null;
}

export interface ArmStats {
  mode: string;
  runs: number;
  gradedRuns: number;
  meanScore: number | null;
  scoreRange: [number, number] | null;
  // Sample stddev (n-1) of graded scores; null when < 2 graded runs. What
  // separates "advised is better" from "advised got lucky once" (ROADMAP #7).
  stddevScore: number | null;
  meanInputTokens: number;
  meanOutputTokens: number;
  meanCacheReadTokens: number;
  meanCacheCreationTokens: number;
  // Cost proxy = ALL real tokens moved: input + output + cacheRead + cacheCreation.
  // cacheRead matters because the CLI engines re-read a big ambient block on
  // EVERY call, so it scales with reviewer call-count — the dominant difference
  // between a 1-call arm and a 5-call arm. Excluding it (an earlier mistake)
  // made multi-call arms look almost free.
  meanTotalTokens: number;
  // Mean estimated $ per run; null unless EVERY run in the arm was priced —
  // a partial mean would silently understate the expensive runs (ROADMAP #13).
  meanCostUsd: number | null;
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

const sampleStddev = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};

export function aggregate(records: RunRecord[]): ArmStats[] {
  const byMode = new Map<string, RunRecord[]>();
  for (const r of records) {
    const list = byMode.get(r.mode);
    if (list) list.push(r);
    else byMode.set(r.mode, [r]);
  }
  const stats: ArmStats[] = [];
  for (const [mode, rs] of byMode) {
    const scores = rs.map((r) => r.score).filter((s): s is number => s !== null);
    stats.push({
      mode,
      runs: rs.length,
      gradedRuns: scores.length,
      meanScore: scores.length ? mean(scores) : null,
      scoreRange: scores.length ? [Math.min(...scores), Math.max(...scores)] : null,
      stddevScore: sampleStddev(scores),
      meanInputTokens: mean(rs.map((r) => r.inputTokens)),
      meanOutputTokens: mean(rs.map((r) => r.outputTokens)),
      meanCacheReadTokens: mean(rs.map((r) => r.cacheReadTokens)),
      meanCacheCreationTokens: mean(rs.map((r) => r.cacheCreationTokens)),
      meanTotalTokens: mean(rs.map((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens)),
      meanCostUsd: rs.every((r) => r.costUsd !== null) ? mean(rs.map((r) => r.costUsd as number)) : null,
    });
  }
  return stats;
}

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');

export function formatReport(stats: ArmStats[]): string {
  if (stats.length === 0) return 'No runs to report.';

  const lines: string[] = [];
  lines.push('=== quality × cost by arm ===');
  lines.push(`${'arm'.padEnd(12)} ${'runs'.padStart(4)} ${'score'.padStart(11)} ${'in'.padStart(8)} ${'out'.padStart(8)} ${'cacheRd'.padStart(9)} ${'cacheCr'.padStart(9)} ${'total'.padStart(9)} ${'$/task'.padStart(8)}`);
  for (const s of stats) {
    // mean ±stddev in the table; the min-max range stays in the JSON export
    const score =
      s.meanScore === null
        ? '—'
        : `${s.meanScore.toFixed(2)}${s.stddevScore !== null ? ` ±${s.stddevScore.toFixed(2)}` : ''}`;
    const cost = s.meanCostUsd === null ? '—' : `$${s.meanCostUsd.toFixed(s.meanCostUsd >= 0.1 ? 2 : 4)}`;
    lines.push(
      `${s.mode.padEnd(12)} ${String(s.runs).padStart(4)} ${score.padStart(11)} ${n0(s.meanInputTokens).padStart(8)} ${n0(s.meanOutputTokens).padStart(8)} ${n0(s.meanCacheReadTokens).padStart(9)} ${n0(s.meanCacheCreationTokens).padStart(9)} ${n0(s.meanTotalTokens).padStart(9)} ${cost.padStart(8)}`,
    );
  }

  const smallN = stats.filter((s) => s.gradedRuns > 0 && s.gradedRuns < 5);
  if (smallN.length > 0) {
    lines.push(`  (small n: ${smallN.map((s) => `${s.mode}=${s.gradedRuns}`).join(', ')} graded runs — directional only, raise --repeat for confidence)`);
  }

  lines.push('');
  const graded = stats.filter((s) => s.meanScore !== null) as Array<ArmStats & { meanScore: number }>;
  if (graded.length === 0) {
    lines.push('Verdict: no graders on these tasks — cost shown, quality unknown.');
    lines.push('  Add a `grader` to tasks in benchmark/tasks.json to get a quality verdict.');
    const cheapest = [...stats].sort((a, b) => a.meanTotalTokens - b.meanTotalTokens)[0];
    lines.push(`  Cheapest arm: ${cheapest.mode} (${n0(cheapest.meanTotalTokens)} tokens/task).`);
    return lines.join('\n');
  }

  const bestScore = Math.max(...graded.map((s) => s.meanScore));
  const EPS = 0.02; // treat within 2% as "same quality"
  const topTier = graded.filter((s) => s.meanScore >= bestScore - EPS);
  const cheapestAtTop = [...topTier].sort((a, b) => a.meanTotalTokens - b.meanTotalTokens)[0];
  const baseline = graded.find((s) => s.mode === 'baseline');

  lines.push('Verdict:');
  lines.push(`  Best quality:            ${bestQualityLabel(graded, bestScore)}`);
  lines.push(`  Cheapest at top quality: ${cheapestAtTop.mode} (${n0(cheapestAtTop.meanTotalTokens)} tokens/task, score ${cheapestAtTop.meanScore.toFixed(2)})`);
  if (baseline) {
    for (const s of graded) {
      if (s.mode === 'baseline') continue;
      const dScore = s.meanScore - baseline.meanScore;
      const xCost = baseline.meanTotalTokens > 0 ? s.meanTotalTokens / baseline.meanTotalTokens : NaN;
      lines.push(
        `    ${s.mode}: ${dScore >= 0 ? '+' : ''}${dScore.toFixed(2)} quality vs baseline at ${Number.isFinite(xCost) ? xCost.toFixed(1) + '×' : '?'} its cost`,
      );
    }
  }
  return lines.join('\n');
}

function bestQualityLabel(graded: Array<ArmStats & { meanScore: number }>, bestScore: number): string {
  const winners = graded.filter((s) => s.meanScore >= bestScore - 1e-9).map((s) => s.mode);
  return `${winners.join(', ')} (score ${bestScore.toFixed(2)})`;
}

// Serializable bundle for `bench --out results.json` — lets runs accumulate and
// be compared/diffed over time instead of vanishing to stdout.
export interface ReportJson {
  meta: Record<string, unknown>;
  stats: ArmStats[];
  records: RunRecord[];
}
export function reportJson(meta: Record<string, unknown>, stats: ArmStats[], records: RunRecord[]): ReportJson {
  return { meta, stats, records };
}

// `loupe diff a.json b.json` — did my prompt/model change help? Compares two
// `bench --out` bundles per arm: score and total-token movement (ROADMAP #8).
export function diffReports(a: ReportJson, b: ReportJson): string {
  const label = (r: ReportJson, name: string) =>
    `${name}: ${typeof r.meta.generatedAt === 'string' ? r.meta.generatedAt : 'no timestamp'}${typeof r.meta.builder === 'string' ? ` (builder ${r.meta.builder})` : ''}`;
  const byMode = (r: ReportJson) => new Map(r.stats.map((s) => [s.mode, s]));
  const aStats = byMode(a);
  const bStats = byMode(b);
  const modes = [...new Set([...aStats.keys(), ...bStats.keys()])];

  const score = (s: ArmStats | undefined) => (s?.meanScore == null ? '—' : s.meanScore.toFixed(2));
  const lines: string[] = [];
  lines.push('=== diff A → B ===');
  lines.push(label(a, 'A'));
  lines.push(label(b, 'B'));
  lines.push('');
  lines.push(`${'arm'.padEnd(12)} ${'score A → B'.padEnd(16)} ${'Δscore'.padStart(7)}   ${'tokens A → B'.padEnd(22)} ${'Δtokens'.padStart(8)}`);
  for (const mode of modes) {
    const sa = aStats.get(mode);
    const sb = bStats.get(mode);
    if (!sa || !sb) {
      lines.push(`${mode.padEnd(12)} (only in ${sa ? 'A' : 'B'})`);
      continue;
    }
    const dScore =
      sa.meanScore != null && sb.meanScore != null
        ? `${sb.meanScore - sa.meanScore >= 0 ? (sb.meanScore === sa.meanScore ? '±' : '+') : ''}${(sb.meanScore - sa.meanScore).toFixed(2)}`
        : '—';
    const dTok = sa.meanTotalTokens > 0 ? `${((sb.meanTotalTokens / sa.meanTotalTokens - 1) * 100).toFixed(0)}%` : '—';
    const dTokSigned = dTok === '—' || dTok.startsWith('-') ? dTok : `+${dTok}`;
    lines.push(
      `${mode.padEnd(12)} ${`${score(sa)} → ${score(sb)}`.padEnd(16)} ${dScore.padStart(7)}   ${`${n0(sa.meanTotalTokens)} → ${n0(sb.meanTotalTokens)}`.padEnd(22)} ${dTokSigned.padStart(8)}`,
    );
  }
  return lines.join('\n');
}
