import { call, type EngineConfig } from './engines/index.js';
import { isApproval, reviewerPromptFor } from './runner.js';

// Reviewer catch-rate probe (ROADMAP #11). Born from a live finding
// (CHANGELOG §29): a too-weak reviewer APPROVED code that crashes on its first
// call — converting broken output into *approved* broken output, worse than no
// reviewer at all. Before trusting an advised/escalated verdict, measure the
// reviewer directly: feed it outputs with KNOWN planted defects plus known-good
// ones, through the exact prompt real runs use, and count what it catches.

export interface ProbeItem {
  id: string;
  task: string;
  output: string;
  defective: boolean; // ground truth: does this output actually fail the task?
  note?: string; // what the planted defect is (or why the output is correct)
}

export interface ProbeItemResult {
  id: string;
  defective: boolean;
  approved: boolean;
  ok: boolean; // reviewer got it right (rejected defective / approved correct)
  error?: string; // reviewer call failed — item excluded from the rates
}

export interface ProbeResult {
  items: ProbeItemResult[];
  defectsCaught: number;
  defectsTotal: number;
  falseAlarms: number;
  correctTotal: number;
  catchRate: number | null; // null when every defective item errored
  falseAlarmRate: number | null;
  verdict: 'trustworthy' | 'over-critical' | 'unreliable' | 'rubber-stamp';
}

export function validateProbeItems(raw: unknown): ProbeItem[] {
  if (!Array.isArray(raw)) throw new Error('probe file: top level must be a JSON array');
  const items = raw.map((v, i) => {
    const o = v as Record<string, unknown>;
    if (typeof o.id !== 'string' || typeof o.task !== 'string' || typeof o.output !== 'string' || typeof o.defective !== 'boolean') {
      throw new Error(`probe file: item ${i} needs { id, task, output: string, defective: boolean }`);
    }
    return { id: o.id, task: o.task, output: o.output, defective: o.defective, note: typeof o.note === 'string' ? o.note : undefined };
  });
  if (!items.some((x) => x.defective) || !items.some((x) => !x.defective)) {
    throw new Error('probe file: need at least one defective AND one correct item — rates are meaningless otherwise');
  }
  return items;
}

// Thresholds: a coin-flip reviewer catches ~half the planted defects, so below
// 0.5 it is actively harmful (approves broken work with authority). High catch
// + high false-alarm is "over-critical": safe but wastes rounds re-litigating
// good output.
function verdictFor(catchRate: number | null, falseAlarmRate: number | null): ProbeResult['verdict'] {
  if (catchRate === null || catchRate < 0.5) return 'rubber-stamp';
  if (catchRate < 0.8) return 'unreliable';
  if (falseAlarmRate !== null && falseAlarmRate > 0.5) return 'over-critical';
  return 'trustworthy';
}

export async function probeReviewer(
  items: ProbeItem[],
  reviewer: EngineConfig,
  callFn: typeof call = call,
  note: (msg: string) => void = (m) => console.error(`  · ${m}`),
): Promise<ProbeResult> {
  const results: ProbeItemResult[] = [];
  for (const item of items) {
    try {
      const res = await callFn(reviewer, reviewerPromptFor(item.task, item.output));
      const approved = isApproval(res.text);
      const ok = item.defective ? !approved : approved;
      results.push({ id: item.id, defective: item.defective, approved, ok });
      note(`${item.id}: ${item.defective ? 'defective' : 'correct'} → ${approved ? 'APPROVED' : 'rejected'} ${ok ? '✓' : '✗ MISS'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({ id: item.id, defective: item.defective, approved: false, ok: false, error: msg });
      note(`${item.id}: reviewer call failed (${msg}) — excluded from rates`);
    }
  }

  const scored = results.filter((r) => !r.error);
  const defects = scored.filter((r) => r.defective);
  const corrects = scored.filter((r) => !r.defective);
  const defectsCaught = defects.filter((r) => !r.approved).length;
  const falseAlarms = corrects.filter((r) => !r.approved).length;
  const catchRate = defects.length ? defectsCaught / defects.length : null;
  const falseAlarmRate = corrects.length ? falseAlarms / corrects.length : null;

  return {
    items: results,
    defectsCaught,
    defectsTotal: defects.length,
    falseAlarms,
    correctTotal: corrects.length,
    catchRate,
    falseAlarmRate,
    verdict: verdictFor(catchRate, falseAlarmRate),
  };
}

export function formatProbeReport(reviewer: EngineConfig, r: ProbeResult): string {
  const pct = (x: number | null) => (x === null ? '—' : `${Math.round(x * 100)}%`);
  const lines = [
    `=== reviewer probe: ${reviewer.engine}/${reviewer.model} ===`,
    `  defects caught:   ${r.defectsCaught}/${r.defectsTotal} (${pct(r.catchRate)})`,
    `  false alarms:     ${r.falseAlarms}/${r.correctTotal} (${pct(r.falseAlarmRate)})`,
    `  verdict:          ${r.verdict}`,
  ];
  if (r.verdict === 'rubber-stamp') {
    lines.push(
      '',
      '  ⚠ RUBBER-STAMP: this reviewer approves planted defects at or below chance.',
      '  Using it as an advised/escalated reviewer is WORSE than no reviewer — it',
      '  converts broken output into approved broken output. Use a stronger model.',
    );
  } else if (r.verdict === 'unreliable') {
    lines.push('', '  ⚠ misses too many planted defects to be trusted alone — prefer verify mode (run the tests) where possible.');
  } else if (r.verdict === 'over-critical') {
    lines.push('', '  note: catches defects but also rejects good output — expect wasted revision rounds.');
  }
  const errored = r.items.filter((x) => x.error);
  if (errored.length) lines.push('', `  ${errored.length} item(s) errored and were excluded: ${errored.map((x) => x.id).join(', ')}`);
  return lines.join('\n');
}
