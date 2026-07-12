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

// Pull runnable code out of an LLM reply. Fence-preferred: fenced blocks are
// the code (joined in order), prose outside them is ignored. No fences → the
// text IS the code, verbatim. The old trailing-prose-stripping heuristics are
// gone: contamination is fixed at the source (design §23/§24 — the builder
// runs vanilla), so leftover prose should fail the exec grader loudly instead
// of being silently trimmed by regexes that could also eat legitimate code.
export function extractCode(output: string): string {
  const fences = [...output.matchAll(/```(?:[a-zA-Z0-9+#.-]*)\n([\s\S]*?)```/g)].map((m) => m[1].replace(/\n$/, ''));
  return fences.length > 0 ? fences.join('\n') : output;
}

// Per-assertion scoring (ROADMAP #4): one check per non-empty line of `tests`.
// Each line must be a self-contained statement — the harness runs them
// individually so one failure doesn't mask the rest, score = passed/total,
// and the FAILING lines (not just "exit 1") become the verify-mode feedback.
export function splitChecks(tests: string): string[] {
  return tests
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function pythonHarness(code: string, checks: string[]): string {
  const list = checks.map((c) => `    ${JSON.stringify(c)},`).join('\n');
  return `${code}

_checks = [
${list}
]
_failures = []
for _c in _checks:
    try:
        exec(_c, globals())
    except Exception as _e:
        _failures.append(f"{_c}  ->  {type(_e).__name__}: {_e}")
print(f"LOUPE_SCORE {len(_checks) - len(_failures)}/{len(_checks)}")
for _f in _failures[:3]:
    print("LOUPE_FAIL " + _f)
`;
}

function nodeHarness(code: string, checks: string[]): string {
  const list = checks.map((c) => `  [${JSON.stringify(c)}, () => { ${c} }],`).join('\n');
  return `${code}

const _checks = [
${list}
];
const _failures = [];
for (const [_src, _fn] of _checks) {
  try { _fn(); } catch (_e) { _failures.push(_src + '  ->  ' + (_e && _e.message ? _e.message : String(_e))); }
}
console.log('LOUPE_SCORE ' + (_checks.length - _failures.length) + '/' + _checks.length);
for (const _f of _failures.slice(0, 3)) console.log('LOUPE_FAIL ' + _f);
`;
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
    const { stdout } = await execFileAsync(interp, [join(dir, filename)], { timeout: timeoutMs, maxBuffer: 1024 * 1024 });
    const m = String(stdout).match(/LOUPE_SCORE (\d+)\/(\d+)/);
    if (!m) return { score: 0, detail: 'harness produced no score (program crashed before checks?)' };
    const passed = Number(m[1]);
    const total = Number(m[2]);
    if (total === 0 || passed === total) return { score: 1, detail: 'all checks passed' };
    const fails = [...String(stdout).matchAll(/^LOUPE_FAIL (.+)$/gm)].map((x) => x[1]);
    return {
      score: passed / total,
      detail: `${passed}/${total} checks passed; failing: ${fails.join(' | ').slice(0, 300)}`,
    };
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
    const checks = splitChecks(grader.tests);
    const code = extractCode(output);
    const program = grader.language === 'python' ? pythonHarness(code, checks) : nodeHarness(code, checks);
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
