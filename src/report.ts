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
}

export interface ArmStats {
  mode: string;
  runs: number;
  gradedRuns: number;
  meanScore: number | null;
  scoreRange: [number, number] | null;
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
}

const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

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
      meanInputTokens: mean(rs.map((r) => r.inputTokens)),
      meanOutputTokens: mean(rs.map((r) => r.outputTokens)),
      meanCacheReadTokens: mean(rs.map((r) => r.cacheReadTokens)),
      meanCacheCreationTokens: mean(rs.map((r) => r.cacheCreationTokens)),
      meanTotalTokens: mean(rs.map((r) => r.inputTokens + r.outputTokens + r.cacheReadTokens + r.cacheCreationTokens)),
    });
  }
  return stats;
}

const n0 = (x: number): string => Math.round(x).toLocaleString('en-US');

export function formatReport(stats: ArmStats[]): string {
  if (stats.length === 0) return 'No runs to report.';

  const lines: string[] = [];
  lines.push('=== quality × cost by arm ===');
  lines.push(`${'arm'.padEnd(12)} ${'runs'.padStart(4)} ${'score'.padStart(11)} ${'in'.padStart(8)} ${'out'.padStart(8)} ${'cacheRd'.padStart(9)} ${'cacheCr'.padStart(9)} ${'total'.padStart(9)}`);
  for (const s of stats) {
    const score =
      s.meanScore === null
        ? '—'
        : `${s.meanScore.toFixed(2)}${s.scoreRange && s.scoreRange[0] !== s.scoreRange[1] ? ` [${s.scoreRange[0].toFixed(2)}-${s.scoreRange[1].toFixed(2)}]` : ''}`;
    lines.push(
      `${s.mode.padEnd(12)} ${String(s.runs).padStart(4)} ${score.padStart(11)} ${n0(s.meanInputTokens).padStart(8)} ${n0(s.meanOutputTokens).padStart(8)} ${n0(s.meanCacheReadTokens).padStart(9)} ${n0(s.meanCacheCreationTokens).padStart(9)} ${n0(s.meanTotalTokens).padStart(9)}`,
    );
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
