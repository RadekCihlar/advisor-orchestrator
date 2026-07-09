import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { call, type EngineConfig } from './engines/index.js';

const execFileAsync = promisify(execFile);

// Scores an arm's final output 0..1 so the benchmark can answer its actual
// question ("did the reviewer help?") instead of relying on a human eyeball.
//
// - includes / regex: deterministic, pure, zero-cost — use for tasks with a
//   known answer or a hard textual constraint.
// - judge: an LLM scores against a rubric — for open-ended quality. Costs a
//   call; the engine is injectable so it's testable offline.
export type Grader =
  | { type: 'includes'; must: string[]; caseInsensitive?: boolean }
  | { type: 'regex'; pattern: string; flags?: string }
  | { type: 'judge'; rubric: string; engine?: EngineConfig }
  // exec: the output is code; append `tests` and run it. This is the grader
  // where builder+reviewer provably beats solo — the test result is ground
  // truth, not another LLM's opinion. score = 1 if the program exits 0, else 0.
  | { type: 'exec'; language: 'python' | 'node'; tests: string; timeoutMs?: number };

export interface GradeResult {
  score: number; // 0..1
  detail: string;
}

// Pure graders — no I/O, safe to call anywhere.
export function gradeDeterministic(
  grader: Extract<Grader, { type: 'includes' | 'regex' }>,
  output: string,
): GradeResult {
  if (grader.type === 'includes') {
    const hay = grader.caseInsensitive ? output.toLowerCase() : output;
    const needles = grader.caseInsensitive ? grader.must.map((m) => m.toLowerCase()) : grader.must;
    if (needles.length === 0) return { score: 1, detail: 'no required strings' };
    const missing = needles.filter((n) => !hay.includes(n));
    const score = (needles.length - missing.length) / needles.length;
    return { score, detail: missing.length ? `missing: ${missing.join(', ')}` : 'all required strings present' };
  }
  const re = new RegExp(grader.pattern, grader.flags);
  const ok = re.test(output);
  return { score: ok ? 1 : 0, detail: ok ? 'pattern matched' : `no match: /${grader.pattern}/${grader.flags ?? ''}` };
}

// Extract a 0-10 score from the judge's reply. Prefer an explicit "N/10";
// otherwise take the LAST standalone integer — judges usually end on the score,
// and this dodges leading scale-echoes ("on a scale of 0 to 10: 7" → 7, not 0).
export function parseJudgeScore(text: string): number | null {
  const outOf = text.match(/\b(10|[0-9])\s*(?:\/|out of)\s*10\b/i);
  if (outOf) return Number(outOf[1]) / 10;
  const all = [...text.matchAll(/\b(10|[0-9])\b/g)];
  if (all.length === 0) return null;
  const last = Number(all[all.length - 1][1]);
  return Math.max(0, Math.min(10, last)) / 10;
}

// Pull runnable code out of an LLM reply.
// - If it fenced the code, use ONLY the fenced blocks (join all) — prose outside
//   the fences is ignored.
// - If there are no fences, treat the text as code but drop a trailing
//   prose/decoration block that ambient session context sometimes injects
//   (e.g. a "★ Insight ───" box). Without this, that prose gets concatenated
//   with the tests and breaks the program — scoring correct code as a failure.
export function extractCode(output: string): string {
  const fences = [...output.matchAll(/```(?:[a-zA-Z0-9+#.-]*)\n([\s\S]*?)```/g)].map((m) => m[1]);
  if (fences.length > 0) return fences.join('\n');

  // No fences: code comes first; strip a trailing prose/decoration block the
  // ambient session style tends to append (a "★ Insight" box, ─ rules, a
  // backtick note, or a plain explanatory sentence). Best-effort — the real fix
  // is stopping the builder from inheriting an explanatory output style at all.
  const isCut = (l: string): boolean =>
    /^\s*(★|`)/.test(l) || // ★ bullet / backtick-prose line
    /[─—]{3,}/.test(l) || // box-drawing / em-dash rule
    /^\s*(-{5,}|={5,})\s*$/.test(l) || // markdown horizontal rule
    /^[A-Z][^;{}()=]*\s[^;{}()=]*[.!?]\s*$/.test(l); // a prose sentence with no code punctuation
  const lines = output.split('\n');
  const cut = lines.findIndex(isCut);
  return (cut === -1 ? lines : lines.slice(0, cut)).join('\n');
}

// ponytail: runs UNTRUSTED model-generated code in a subprocess with a wall-clock
// timeout in a throwaway temp dir. That's the pragmatic ceiling — it does NOT
// sandbox filesystem / network / syscalls. For untrusted inputs at scale, run
// the whole benchmark inside a container/VM. Fine for a benchmark you launch.
async function runProgram(language: 'python' | 'node', program: string, timeoutMs: number): Promise<GradeResult> {
  const interp = language === 'python' ? 'python3' : 'node';
  const filename = language === 'python' ? 'prog.py' : 'prog.js';
  const dir = await mkdtemp(join(tmpdir(), 'loupe-exec-'));
  try {
    await writeFile(join(dir, filename), program);
    await execFileAsync(interp, [join(dir, filename)], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    return { score: 1, detail: 'all checks passed' };
  } catch (err) {
    const e = err as { code?: unknown; killed?: boolean; stderr?: string; message?: string };
    if (e.code === 'ENOENT') throw new Error(`exec grader: interpreter "${interp}" not found`);
    if (e.killed) return { score: 0, detail: `timed out after ${timeoutMs}ms` };
    // Surface the thrown assertion message (the useful line), not the stack tail.
    const stderr = String(e.stderr ?? e.message ?? '').trim();
    const msg = stderr.split('\n').find((l) => /error/i.test(l) && !/^\s*at\s/.test(l)) ?? stderr.split('\n')[0] ?? 'unknown';
    return { score: 0, detail: `checks failed: ${msg.slice(0, 200)}` };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function grade(
  grader: Grader,
  output: string,
  opts: { callFn?: typeof call; judgeEngine?: EngineConfig } = {},
): Promise<GradeResult> {
  if (grader.type === 'includes' || grader.type === 'regex') return gradeDeterministic(grader, output);

  if (grader.type === 'exec') {
    const program = `${extractCode(output)}\n\n${grader.tests}\n`;
    return runProgram(grader.language, program, grader.timeoutMs ?? 10_000);
  }

  const engine = grader.engine ?? opts.judgeEngine;
  if (!engine) throw new Error('judge grader needs an engine (grader.engine or opts.judgeEngine)');
  const callFn = opts.callFn ?? call;
  const prompt =
    `Score how well the RESPONSE satisfies the CRITERIA, on an integer scale from 0 (fails) to 10 (perfect). ` +
    `Reply with ONLY the integer.\n\nCRITERIA: ${grader.rubric}\n\nRESPONSE:\n${output}`;
  const res = await callFn(engine, prompt);
  const score = parseJudgeScore(res.text);
  if (score === null) return { score: 0, detail: `judge returned no parseable score: "${res.text.slice(0, 80)}"` };
  return { score, detail: `judge scored ${Math.round(score * 10)}/10` };
}
