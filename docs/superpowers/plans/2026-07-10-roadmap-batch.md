# Roadmap Batch: stash port + packs + per-assertion scoring + stats

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the surviving stash@{1} features (uncertainty marker #11, --json/stdin, usage.jsonl, npm-shim resolution, retry, strict approval) plus ROADMAP #3 (task packs), #4 (per-assertion exec scoring + targeted feedback), and #7 (mean±stddev + small-n flag).

**Architecture:** All changes ride the existing structure: `src/runner.ts` (loop), `src/grader.ts` (scoring), `src/report.ts` (aggregation), `src/cli.ts` (flags/commands), `src/engines/*` (providers). New files: `benchmark/packs/{coding,reasoning,constraint}.json` + `src/packs.test.ts`. No new abstractions, no new deps.

**Tech Stack:** TypeScript ESM, node:test via `tsx --test`, Node >= 24.

## Global Constraints

- **Never run `npm install`** — corporate Nexus registry unreachable; devDeps absent. Tests run via the npx cache: `npx tsx --test src/*.test.ts src/engines/*.test.ts` (tsx v4.23.0 confirmed cached). `tsc` is unavailable locally; CI runs typecheck on push.
- **No new dependencies.** stdlib only.
- **Exec-graded pack tasks use `language: "node"` only** — `python3` is not guaranteed on Windows dev machines; node is (we run under it).
- **Working tree already holds uncommitted merge-resolution changes** (ROADMAP.md, docs/design.md, src/engines/claude-code.ts, README.md, .gitignore, src/runner.ts, untracked plugin dirs). Commit steps below stage ONLY named files. The merge-resolution changes should be committed first (Task 0) — requires user confirmation per their git rules.
- Repo commit convention: Conventional Commits (`feat:` / `fix:` / `docs:` / `chore:` / `test:`).
- Match existing comment style: comments explain WHY/constraints, not narration.

---

### Task 0: Commit the pulled-merge resolution (user-gated)

**Files:** all currently modified tracked files.

This isolates the already-finished merge work from the new roadmap work so later task commits stay clean. **Ask the user before running any commit.**

- [ ] **Step 1: Confirm with user, then commit tracked modifications**

```bash
git add .gitignore README.md ROADMAP.md docs/design.md src/engines/claude-code.ts src/runner.ts
git commit -m "feat: merge parallel-session work — combined style+hooks contamination fix, live consult narration"
```

(Untracked `.claude-plugin/`, `hooks/`, `skills/`, `docs/superpowers/` stay uncommitted; user decides their fate separately.)

---

### Task 1: Strict approval parse (from stash)

**Files:**
- Modify: `src/runner.ts:61` (the `isApproval` const)
- Test: `src/runner.test.ts`

**Interfaces:**
- Produces: `export const isApproval = (text: string): boolean` — first line, stripped of quotes/punctuation, must equal `APPROVED` (case-insensitive). Task 2 reuses it unchanged.

**Why:** current `text.trim().toUpperCase().startsWith('APPROVED')` treats `"APPROVED, but fix X"` as an approval — that's a critique. Stash had the strict parse.

- [ ] **Step 1: Write the failing test** (append to `src/runner.test.ts`; add `isApproval` to the import from `./runner.js`)

```ts
test('isApproval: strict — bare APPROVED yes, "APPROVED, but…" no', () => {
  assert.equal(isApproval('APPROVED'), true);
  assert.equal(isApproval('  "Approved."  '), true);
  assert.equal(isApproval('APPROVED\nno further notes'), true);
  assert.equal(isApproval('APPROVED, but rename the variable'), false);
  assert.equal(isApproval('Not approved'), false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/runner.test.ts`
Expected: FAIL — `isApproval` is not exported (import error), then after exporting the current lax version: `'APPROVED, but rename the variable'` case fails.

- [ ] **Step 3: Replace the implementation** in `src/runner.ts` (replace line 61)

```ts
// Strict verdict parse: the FIRST LINE, stripped of quotes/punctuation, must BE
// "APPROVED" — "APPROVED, but fix X" is a critique, not an approval.
export const isApproval = (text: string): boolean => {
  const firstLine = text.trim().split('\n')[0] ?? '';
  return firstLine.replace(/^["'`*\s]+|["'`*\s.!]+$/g, '').toUpperCase() === 'APPROVED';
};
```

- [ ] **Step 4: Run the full runner suite**

Run: `npx tsx --test src/runner.test.ts`
Expected: PASS (all existing tests use bare `'APPROVED'` replies — unaffected).

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts src/runner.test.ts
git commit -m "fix: strict APPROVED parse — 'APPROVED, but…' is a critique, not an approval"
```

---

### Task 2: Uncertainty marker `<<needs-review>>` (ROADMAP #11, from stash)

**Files:**
- Modify: `src/runner.ts` (marker consts, `ConsultRound`, builder prompt, escalated branch)
- Test: `src/runner.test.ts`

**Interfaces:**
- Produces: `export const UNCERTAINTY_MARKER = '<<needs-review>>'`; `export function stripMarker(text: string): { text: string; flagged: boolean }`; `ConsultRound.flagged?: boolean`. Task 4's `logRun` reads `r.flagged`.

**Semantics:** escalated mode only. Builder prompts carry an instruction to append the marker when unsure. A flagged round with the escalation still unspent skips the cheap self-review and fires the big reviewer immediately. Flagged with the escalation already spent → normal self-review path (marker still stripped from output).

- [ ] **Step 1: Write the failing tests** (append to `src/runner.test.ts`; add `stripMarker` to imports)

```ts
test('stripMarker: removes marker and flags; no marker → unchanged', () => {
  assert.deepEqual(stripMarker('X\n<<needs-review>>'), { text: 'X', flagged: true });
  assert.deepEqual(stripMarker('X'), { text: 'X', flagged: false });
});

test('escalated: builder marker skips self-review and fires the escalation immediately', async () => {
  const calls: string[] = [];
  const fake = async (cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    if (isReviewPrompt(prompt)) {
      calls.push(`review:${cfg.model}`);
      return mk('APPROVED');
    }
    calls.push(`build:${cfg.model}`);
    return mk('BUILD <<needs-review>>');
  };

  const r = await run({ task: 't', builder: B, reviewer: R, consults: 2, mode: 'escalated' }, fake);

  // no self-review call by builder-model on the review prompt — straight to reviewer-model
  assert.deepEqual(calls, ['build:builder-model', 'review:reviewer-model']);
  assert.equal(r.rounds[0].flagged, true);
  assert.equal(r.rounds[0].escalated, true);
  assert.equal(r.finalOutput, 'BUILD', 'marker must be stripped from shipped output');
});

test('escalated: builder prompt carries the marker instruction; advised does not', async () => {
  const prompts: string[] = [];
  const fake = async (_cfg: EngineConfig, prompt: string): Promise<CallResult> => {
    prompts.push(prompt);
    return mk('APPROVED');
  };
  await run({ task: 't', builder: B, reviewer: R, consults: 1, mode: 'escalated' }, fake);
  assert.match(prompts[0], /<<needs-review>>/);
  prompts.length = 0;
  await run({ task: 't', builder: B, reviewer: R, consults: 1, mode: 'advised' }, fake);
  assert.doesNotMatch(prompts[0], /<<needs-review>>/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/runner.test.ts`
Expected: FAIL — `stripMarker` not exported.

- [ ] **Step 3: Implement in `src/runner.ts`**

Add after the `isApproval` definition:

```ts
// ROADMAP #11 / design §9: the builder appends this marker when genuinely
// unsure. Escalated mode reads it as "don't trust my self-review" and spends
// its one big-reviewer escalation immediately instead of self-reviewing first.
export const UNCERTAINTY_MARKER = '<<needs-review>>';

export function stripMarker(text: string): { text: string; flagged: boolean } {
  if (!text.includes(UNCERTAINTY_MARKER)) return { text, flagged: false };
  return { text: text.replaceAll(UNCERTAINTY_MARKER, '').trimEnd(), flagged: true };
}

const MARKER_INSTRUCTION = `\n\nIf you are genuinely unsure your answer is correct or complete, append the exact marker ${UNCERTAINTY_MARKER} as the last line of your reply.`;
```

Add `flagged?: boolean;` to `ConsultRound` (after `approved: boolean;`).

In `run()`, build the prompt with the instruction for escalated mode (replace the `builderPrompt` assignment):

```ts
    const marker = opts.mode === 'escalated' ? MARKER_INSTRUCTION : '';
    const builderPrompt =
      round === 0
        ? `Task: ${opts.task}${marker}`
        : `Task: ${opts.task}\n\nYour previous attempt:\n${builderOutput}\n\nReviewer feedback:\n${feedback}\n\nRevise your attempt accordingly. Output only the revised attempt.${marker}`;
```

After the builder call, strip the marker (replace `builderOutput = builderResult.text;`):

```ts
    const stripped = stripMarker(builderResult.text);
    builderOutput = stripped.text;
```

In the escalated branch, skip self-review on a flagged round with the escalation unspent (replace the block from `note(\`round ${round}: self-review by ...\`)` through the `selfApproved` const):

```ts
        let selfApproved = false;
        if (stripped.flagged && !hasEscalated) {
          note(`round ${round}: builder flagged ${UNCERTAINTY_MARKER} — skipping self-review, escalating directly`);
        } else {
          // Cheap self-review first (builder critiques itself — cache stays warm).
          // A failed self-review isn't swallowed: it falls through to escalation,
          // i.e. it's treated as "self couldn't clear it, phone the big reviewer".
          note(`round ${round}: self-review by ${id(opts.builder)}…`);
          try {
            selfReview = await callFn(opts.builder, prompt);
          } catch {
            selfReview = null;
          }
          selfApproved = selfReview !== null && isApproval(selfReview.text);
        }
```

(The following `if (selfApproved) … else if (!hasEscalated) … else …` chain is unchanged — a flagged round has `selfApproved === false` and `hasEscalated === false`, so it flows into the escalation arm.)

In the `rounds.push(...)` line add `flagged: stripped.flagged,` after `approved,`.

- [ ] **Step 4: Run the suite**

Run: `npx tsx --test src/runner.test.ts`
Expected: PASS, including all pre-existing escalated-mode tests (they never emit the marker, so `stripMarker` is a no-op for them).

- [ ] **Step 5: Commit**

```bash
git add src/runner.ts src/runner.test.ts
git commit -m "feat: <<needs-review>> uncertainty marker — flagged builder skips self-review, escalates at once (ROADMAP #11)"
```

---

### Task 3: npm-shim exe resolution + one blind retry (from stash)

**Files:**
- Modify: `src/engines/claude-code.ts:58-59` (bin resolution)
- Modify: `src/engines/index.ts:29-31` (`call`)
- Create: `src/engines/index.test.ts`

**Interfaces:**
- Produces: `export async function retryOnce<T>(fn: () => Promise<T>, label: string, delayMs = 3000): Promise<T>` in `src/engines/index.ts`. `call()` behavior unchanged for callers (same signature).

- [ ] **Step 1: Write the failing tests** — create `src/engines/index.test.ts`:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryOnce } from './index.js';

test('retryOnce: transient failure then success', async () => {
  let n = 0;
  const r = await retryOnce(
    async () => {
      if (++n === 1) throw new Error('429');
      return 'ok';
    },
    'test-call',
    1,
  );
  assert.equal(r, 'ok');
  assert.equal(n, 2);
});

test('retryOnce: deterministic failure rejects after exactly two attempts', async () => {
  let n = 0;
  await assert.rejects(
    retryOnce(
      async () => {
        n++;
        throw new Error('bad model');
      },
      'test-call',
      1,
    ),
    /bad model/,
  );
  assert.equal(n, 2);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/engines/index.test.ts`
Expected: FAIL — `retryOnce` is not exported.

- [ ] **Step 3: Implement retry in `src/engines/index.ts`** (replace the `call` function)

```ts
// One blind retry after a short delay — covers the transient 429/5xx blips
// that used to cost a whole bench arm; a deterministic error (bad model name)
// just fails once more. Real backoff only if this proves too crude.
export async function retryOnce<T>(fn: () => Promise<T>, label: string, delayMs = 3000): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  · ${label} failed (${msg}) — retrying once in ${Math.round(delayMs / 1000)}s…`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return fn();
  }
}

export async function call(cfg: EngineConfig, prompt: string): Promise<CallResult> {
  return retryOnce(() => getEngine(cfg.engine).call(cfg.model, prompt), `call to ${cfg.engine}/${cfg.model}`);
}
```

- [ ] **Step 4: Implement bin resolution in `src/engines/claude-code.ts`** — add `existsSync` to the `node:fs` import, then replace the `CLAUDE_BIN`/`NEEDS_SHELL` consts (lines 52-59, keeping the comment's first paragraph spirit):

```ts
// Prefer a real binary spawned WITHOUT a shell, so Node's normal argv
// escaping just works. Resolution order:
// 1. CLAUDE_CODE_EXECPATH (set automatically inside a Claude Code session)
// 2. the .exe behind the npm-global shim (standalone shells don't have the
//    env var — this repo's whole point is running outside a session)
// 3. last resort: the .cmd shim, which requires shell:true — that does NOT
//    safely escape args (Node's own deprecation warning says so) and mangles
//    multi-word prompts.
function resolveClaudeBin(): { bin: string; needsShell: boolean } {
  if (process.env.CLAUDE_CODE_EXECPATH) return { bin: process.env.CLAUDE_CODE_EXECPATH, needsShell: false };
  if (process.platform === 'win32') {
    const npmExe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(npmExe)) return { bin: npmExe, needsShell: false };
    return { bin: 'claude.cmd', needsShell: true };
  }
  return { bin: 'claude', needsShell: false };
}
const { bin: CLAUDE_BIN, needsShell: NEEDS_SHELL } = resolveClaudeBin();
```

- [ ] **Step 5: Run the full suite**

Run: `npx tsx --test src/*.test.ts src/engines/*.test.ts`
Expected: PASS (49 existing + 2 new). `resolveClaudeBin` is platform/env-dependent — not unit-tested; the Task 4 smoke run exercises it live.

- [ ] **Step 6: Commit**

```bash
git add src/engines/index.ts src/engines/index.test.ts src/engines/claude-code.ts
git commit -m "feat: resolve claude .exe behind the npm shim + one blind retry on transient call failures"
```

---

### Task 4: `--json`, stdin task, usage.jsonl log (from stash)

**Files:**
- Modify: `src/cli.ts` (parseArgs, USAGE, runOne, run command)
- Modify: `.gitignore` (add `usage.jsonl`)

**Interfaces:**
- Consumes: `tallyTokens` (already imported), `ConsultRound.flagged` (Task 2).
- Produces: `--json` on `run` → stdout carries ONE JSON document `{ ...RunResult, usage: TokenTally }`; human narration moves to stderr. `run -` reads the task from stdin. Every completed `runOne` (bench arms included) appends a line to `usage.jsonl` at repo root.

No unit tests: `src/cli.ts` calls `main()` at import, so importing it from a test would execute the CLI and kill the suite (this is why no cli.test.ts exists). Verification is a live smoke run.

- [ ] **Step 1: parseArgs boolean flags** — in `src/cli.ts`, add above `parseArgs`:

```ts
const BOOL_FLAGS = new Set(['json', 'help']); // never consume the next arg as a value
```

and change the condition inside `parseArgs`:

```ts
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
```

- [ ] **Step 2: usage log + JSON output** — add imports: `appendFileSync` to the `node:fs` import. Add after `const here = ...`:

```ts
const LOG_PATH = join(here, '..', 'usage.jsonl');

// One appended line per completed run (bench arms included) — a local usage
// history. Never fatal: a log write failure must not eat a successful run.
function logRun(task: string, result: RunResult, builder: EngineConfig, reviewer: EngineConfig, consults: number): void {
  const t = tallyTokens(result);
  const line = {
    ts: new Date().toISOString(),
    task: task.length > 80 ? `${task.slice(0, 80)}…` : task,
    mode: result.mode,
    builder: `${builder.engine}/${builder.model}`,
    reviewer: result.mode === 'baseline' ? null : `${reviewer.engine}/${reviewer.model}`,
    consults,
    rounds: result.rounds.length,
    approvedEarly: result.rounds.at(-1)?.approved ?? false,
    flagged: result.rounds.some((r) => r.flagged),
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    notionalCostUsd: t.notionalCost,
  };
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`);
  } catch (err) {
    console.error(`  · usage log write failed (${err instanceof Error ? err.message : String(err)})`);
  }
}
```

Change `runOne` — new trailing param `json = false`, log every run, JSON short-circuit (label to stderr in json mode):

```ts
async function runOne(
  task: string,
  mode: Mode,
  builder: EngineConfig,
  reviewer: EngineConfig,
  consults: number,
  verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>,
  json = false,
): Promise<RunResult> {
```

replace `console.log(label);` with:

```ts
  // in --json mode stdout carries ONLY the JSON document; humans read stderr
  (json ? console.error : console.log)(label);
```

and replace the tail of `runOne` (from `console.log('\n--- final output ---');`) with:

```ts
  logRun(task, result, builder, reviewer, consults);
  if (json) {
    console.log(JSON.stringify({ ...result, usage: tallyTokens(result) }));
    return result;
  }
  console.log('\n--- final output ---');
  console.log(result.finalOutput);
  console.log('\n--- usage ---');
  printUsage(result);
  return result;
```

- [ ] **Step 3: stdin task + help + wire the flag** — in the `run` command block, replace `const task = positional[1];` with:

```ts
    let task = positional[1];
    if (task === '-') {
      task = readFileSync(0, 'utf8').trim(); // fd 0 = stdin, for long/multiline tasks
    }
```

Add at the top of `main()` after `const command = positional[0];`:

```ts
  if (flags.help === true || command === 'help') {
    console.log(USAGE);
    return;
  }
```

Change the `runOne` call in the run command to pass the flag:

```ts
      await runOne(task, mode, builder, reviewer, consults, undefined, flags.json === true);
```

In `loadConfigAuto`, route the note to stderr so `--json` stdout stays pure — replace `console.log('Using loupe.config.json');` with `console.error('Using loupe.config.json');`.

Update `USAGE`: in the `run` line add `[--json]` after `[--consults N]`, and append two explanation lines:

```
    "<task>" may be - to read the task from stdin (long/multiline tasks).
    --json: stdout carries one machine-readable JSON document (result, rounds,
    usage); human progress goes to stderr. Every completed run appends one
    line to usage.jsonl (repo root).
```

- [ ] **Step 4: gitignore** — append `usage.jsonl` line to `.gitignore`.

- [ ] **Step 5: Smoke-verify live** (exercises resolveClaudeBin too)

```bash
echo "Reply with exactly: OK" | npx tsx src/cli.ts run - --json --mode baseline --builder-engine claude-code --builder-model sonnet > /tmp/out.json 2>/tmp/err.txt; echo "exit=$?"; head -c 300 /tmp/out.json; tail -1 usage.jsonl
```

Expected: exit=0; stdout is a single JSON object with `"mode":"baseline"`, `"finalOutput"` containing `OK`, and a `usage` object; `usage.jsonl` gained one line with the same run. stderr (err.txt) holds the label + round narration.

- [ ] **Step 6: Full suite still green**

Run: `npx tsx --test src/*.test.ts src/engines/*.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts .gitignore
git commit -m "feat: --json machine output, stdin task via '-', per-run usage.jsonl log"
```

---

### Task 5: Per-assertion exec scoring + targeted feedback (ROADMAP #4)

**Files:**
- Modify: `src/grader.ts` (exec path: check splitting, harnesses, stdout-parsed scoring)
- Test: `src/grader.test.ts`

**Interfaces:**
- Consumes: `extractCode` (unchanged).
- Produces: `export function splitChecks(tests: string): string[]` (one check per non-empty line). Exec `GradeResult.score` becomes fractional (`passed/total`); `detail` names up to 3 failing checks with their errors — this is what `verify` mode feeds back to the builder (cli.ts already passes `g.detail` as feedback, so targeted feedback lands with no cli change). `passed` in the cli verifier stays `score === 1`.

**Grader contract change (document in README, Task 7):** each non-empty line of `tests` must be a self-contained assertion/statement. Existing single-line and multi-line-of-asserts tasks keep working (every line already is one).

- [ ] **Step 1: Write the failing tests** (append to `src/grader.test.ts`; add `splitChecks` to imports)

```ts
test('splitChecks: one check per non-empty line', () => {
  assert.deepEqual(splitChecks("a();\n\n  b();  \n"), ['a();', 'b();']);
});

test('exec grader: per-assertion fractional score + failing check named in detail', async () => {
  const code = 'function add(a, b) { return a === 2 ? a + b : 0; }';
  const r = await grade(
    {
      type: 'exec',
      language: 'node',
      tests: "if (add(2,3) !== 5) throw new Error('add(2,3) wrong');\nif (add(4,4) !== 8) throw new Error('add(4,4) wrong');",
    },
    code,
  );
  assert.equal(r.score, 0.5);
  assert.match(r.detail, /1\/2 checks passed/);
  assert.match(r.detail, /add\(4,4\) wrong/, 'the failing check must be named for targeted feedback');
});

test('exec grader: code that crashes at load still scores 0 with the error surfaced', async () => {
  const r = await grade({ type: 'exec', language: 'node', tests: 'f();' }, 'syntax error here((');
  assert.equal(r.score, 0);
  assert.match(r.detail, /checks failed|no score/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/grader.test.ts`
Expected: FAIL — `splitChecks` not exported.

- [ ] **Step 3: Implement in `src/grader.ts`**

Add after `extractCode`:

```ts
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
```

Replace `runProgram`'s success return (`return { score: 1, detail: 'all checks passed' };`) with stdout parsing — the full new `runProgram`:

```ts
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
```

Change the exec branch of `grade()`:

```ts
  if (grader.type === 'exec') {
    const checks = splitChecks(grader.tests);
    const code = extractCode(output);
    const program = grader.language === 'python' ? pythonHarness(code, checks) : nodeHarness(code, checks);
    return runProgram(grader.language, program, grader.timeoutMs ?? 10_000);
  }
```

- [ ] **Step 4: Run the grader suite**

Run: `npx tsx --test src/grader.test.ts`
Expected: PASS — including the pre-existing exec tests: single-line pass → `LOUPE_SCORE 1/1` → score 1 with detail `'all checks passed'`; single-line fail → `LOUPE_SCORE 0/1` → score 0.

- [ ] **Step 5: Full suite**

Run: `npx tsx --test src/*.test.ts src/engines/*.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/grader.ts src/grader.test.ts
git commit -m "feat: per-assertion exec scoring — fractional grades, failing checks feed verify mode (ROADMAP #4)"
```

---

### Task 6: Task packs + `--pack` / `--task` flags (ROADMAP #3)

**Files:**
- Create: `benchmark/packs/coding.json`, `benchmark/packs/reasoning.json`, `benchmark/packs/constraint.json`
- Create: `src/packs.test.ts` (pack sanity: shape + ground-truth reference solutions score 1)
- Modify: `src/cli.ts` (bench: `--pack`, `--task`), `USAGE`

**Interfaces:**
- Consumes: `grade`, `splitChecks` (Task 5), `Grader`.
- Produces: pack JSON files whose shape matches the existing tasks.json (`{ id, prompt, grader }[]`). `bench --pack coding` resolves `benchmark/packs/coding.json`; `--task <id>` filters any task file to one task.

- [ ] **Step 1: Write the pack files.**

`benchmark/packs/coding.json` — node exec, multi-assertion, edge-case-heavy for headroom:

```json
[
  {
    "id": "coding-parse-range",
    "prompt": "Write a JavaScript function parseRange(s) that expands a range string like '1-3,5,7-9' into an array of integers [1,2,3,5,7,8,9]. Rules: comma-separated parts; each part is either a single integer or 'a-b' with a<=b; ignore spaces around parts; throw an Error on a malformed part (empty part, 'b-a' with b>a, or non-numeric). Output only the function.",
    "grader": {
      "type": "exec",
      "language": "node",
      "tests": "if (JSON.stringify(parseRange('1-3,5,7-9')) !== '[1,2,3,5,7,8,9]') throw new Error(\"parseRange('1-3,5,7-9') wrong\");\nif (JSON.stringify(parseRange('4')) !== '[4]') throw new Error(\"parseRange('4') wrong\");\nif (JSON.stringify(parseRange(' 1 , 2-2 ')) !== '[1,2]') throw new Error('spaces not ignored');\nlet threw1 = false; try { parseRange('5-2'); } catch { threw1 = true; } if (!threw1) throw new Error('reversed range must throw');\nlet threw2 = false; try { parseRange('1,,2'); } catch { threw2 = true; } if (!threw2) throw new Error('empty part must throw');"
    }
  },
  {
    "id": "coding-balanced-brackets",
    "prompt": "Write a JavaScript function isBalanced(s) that returns true when every ( ) [ ] { } in s is correctly matched and nested (other characters ignored), false otherwise. Output only the function.",
    "grader": {
      "type": "exec",
      "language": "node",
      "tests": "if (isBalanced('a(b[c]{d})') !== true) throw new Error('nested mix should be true');\nif (isBalanced('([)]') !== false) throw new Error('interleaved should be false');\nif (isBalanced('') !== true) throw new Error('empty should be true');\nif (isBalanced(')(') !== false) throw new Error('close-first should be false');\nif (isBalanced('((') !== false) throw new Error('unclosed should be false');"
    }
  },
  {
    "id": "coding-luhn",
    "prompt": "Write a JavaScript function luhnValid(s) that returns true when the digit string s passes the Luhn checksum, false otherwise. Non-digit characters or an empty string return false; a single digit is validated by the algorithm as-is. Output only the function.",
    "grader": {
      "type": "exec",
      "language": "node",
      "tests": "if (luhnValid('79927398713') !== true) throw new Error('79927398713 is valid');\nif (luhnValid('79927398714') !== false) throw new Error('79927398714 is invalid');\nif (luhnValid('4539148803436467') !== true) throw new Error('4539148803436467 is valid');\nif (luhnValid('1234a') !== false) throw new Error('non-digits must be false');\nif (luhnValid('') !== false) throw new Error('empty must be false');"
    }
  },
  {
    "id": "coding-roman-to-int",
    "prompt": "Write a JavaScript function romanToInt(s) converting a valid Roman numeral (I,V,X,L,C,D,M with subtractive notation) to an integer. Output only the function.",
    "grader": {
      "type": "exec",
      "language": "node",
      "tests": "if (romanToInt('III') !== 3) throw new Error('III'); \nif (romanToInt('LVIII') !== 58) throw new Error('LVIII');\nif (romanToInt('MCMXCIV') !== 1994) throw new Error('MCMXCIV');\nif (romanToInt('IX') !== 9) throw new Error('IX');"
    }
  }
]
```

`benchmark/packs/reasoning.json` — deterministic graders with an `ANSWER:` discipline:

```json
[
  {
    "id": "reasoning-prime-3599",
    "prompt": "Is 3599 prime? If composite, give its prime factorization. Explain briefly, then end your reply with exactly 'ANSWER: prime' or 'ANSWER: composite'.",
    "grader": { "type": "includes", "must": ["59", "61", "ANSWER: composite"], "caseInsensitive": true }
  },
  {
    "id": "reasoning-book-bookmark",
    "prompt": "A book and a bookmark cost $2.20 in total. The book costs exactly $2.00 more than the bookmark. How much does the bookmark cost? Show your reasoning briefly, then end your reply with exactly 'ANSWER: <number> cents'.",
    "grader": { "type": "regex", "pattern": "ANSWER:\\s*10(\\.0+)?\\s*cents", "flags": "i" }
  },
  {
    "id": "reasoning-age-puzzle",
    "prompt": "Anna is 25 now. In 5 years, Anna will be exactly twice as old as Ben was 3 years ago. How old is Ben now? Show your reasoning briefly, then end your reply with exactly 'ANSWER: <number>'.",
    "grader": { "type": "regex", "pattern": "ANSWER:\\s*18\\b" }
  },
  {
    "id": "reasoning-letter-count",
    "prompt": "How many times does the letter 'r' appear in the phrase 'strawberry raspberry'? Count carefully, then end your reply with exactly 'ANSWER: <number>'.",
    "grader": { "type": "regex", "pattern": "ANSWER:\\s*6\\b" }
  }
]
```

`benchmark/packs/constraint.json` — hard textual constraints, regex-checkable:

```json
[
  {
    "id": "constraint-no-e",
    "prompt": "Write ONE grammatical English sentence of at least eight words that does not contain the letter e (uppercase or lowercase). Output only the sentence, nothing else.",
    "grader": { "type": "regex", "pattern": "^\\s*([^\\seE]+\\s+){7,}[^\\seE]+\\s*$" }
  },
  {
    "id": "constraint-seven-words",
    "prompt": "Write a sentence about the ocean that is exactly seven words long. Output only the sentence.",
    "grader": { "type": "regex", "pattern": "^\\W*([\\w'-]+\\W+){6}[\\w'-]+\\W*$" }
  },
  {
    "id": "constraint-acrostic-loupe",
    "prompt": "Write a five-line poem where the lines start with the letters L, O, U, P, E in that order (an acrostic of LOUPE). Output only the five lines.",
    "grader": { "type": "regex", "pattern": "^\\s*L[^\\n]*\\n+O[^\\n]*\\n+U[^\\n]*\\n+P[^\\n]*\\n+E[^\\n]*\\s*$" }
  },
  {
    "id": "constraint-json-only",
    "prompt": "Output only a single JSON object (no prose, no code fence) with exactly two keys: \"name\" (a fictional person's name, a string) and \"age\" (an integer between 20 and 60).",
    "grader": { "type": "regex", "pattern": "^\\s*\\{[^{}]*\"name\"\\s*:\\s*\"[^\"]+\"[^{}]*\"age\"\\s*:\\s*(2[0-9]|[3-5][0-9]|60)[^{}]*\\}\\s*$" }
  }
]
```

- [ ] **Step 2: Write the pack sanity test** — create `src/packs.test.ts`. It proves every pack parses, has unique ids and known grader types, every regex compiles, and — the ground-truth guarantee — a known-good reference solution scores 1.0 while a known-bad one scores < 1:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { grade, type Grader } from './grader.js';

const packsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'packs');
interface PackTask {
  id: string;
  prompt: string;
  grader: Grader;
}
const packs = new Map<string, PackTask[]>(
  readdirSync(packsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(packsDir, f), 'utf8')) as PackTask[]]),
);

test('packs: every task has id, prompt, and a deterministic grader; ids unique', () => {
  assert.ok(packs.size >= 3, 'coding/reasoning/constraint packs exist');
  const seen = new Set<string>();
  for (const [file, tasks] of packs) {
    assert.ok(tasks.length >= 3, `${file} has enough tasks`);
    for (const t of tasks) {
      assert.ok(t.id && !seen.has(t.id), `${file}: duplicate/missing id ${t.id}`);
      seen.add(t.id);
      assert.ok(t.prompt.length > 20, `${t.id}: prompt`);
      assert.ok(['exec', 'regex', 'includes'].includes(t.grader.type), `${t.id}: deterministic grader (no judge in packs)`);
      if (t.grader.type === 'regex') new RegExp(t.grader.pattern, t.grader.flags); // throws if invalid
    }
  }
});

// Ground truth: a correct reference answer must score 1.0 on its own grader,
// and a wrong one must not. A pack task failing here has a broken grader, not
// a hard task — this is what keeps "headroom" honest.
const good: Record<string, string> = {
  'coding-parse-range': `function parseRange(s){return s.split(',').map(p=>p.trim()).map(p=>{if(!p)throw new Error('empty');const m=p.match(/^(-?\\d+)(?:-(-?\\d+))?$/);if(!m)throw new Error('bad part');const a=Number(m[1]);if(m[2]===undefined)return[a];const b=Number(m[2]);if(b<a)throw new Error('reversed');const out=[];for(let i=a;i<=b;i++)out.push(i);return out;}).flat();}`,
  'coding-balanced-brackets': `function isBalanced(s){const open={'(':')','[':']','{':'}'};const close=new Set([')',']','}']);const st=[];for(const ch of s){if(open[ch])st.push(open[ch]);else if(close.has(ch)){if(st.pop()!==ch)return false;}}return st.length===0;}`,
  'coding-luhn': `function luhnValid(s){if(!/^\\d+$/.test(s))return false;let sum=0;const ds=s.split('').reverse().map(Number);for(let i=0;i<ds.length;i++){let d=ds[i];if(i%2===1){d*=2;if(d>9)d-=9;}sum+=d;}return sum%10===0;}`,
  'coding-roman-to-int': `function romanToInt(s){const v={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};let t=0;for(let i=0;i<s.length;i++){const c=v[s[i]],n=v[s[i+1]]??0;t+=c<n?-c:c;}return t;}`,
  'reasoning-prime-3599': '3599 = 3600 - 1 = 60^2 - 1^2 = 59 x 61, so it is not prime.\nANSWER: composite',
  'reasoning-book-bookmark': 'Let x be the bookmark. x + (x + 200) = 220 cents, so x = 10.\nANSWER: 10 cents',
  'reasoning-age-puzzle': 'Anna+5 = 30 = 2(Ben-3), so Ben-3 = 15, Ben = 18.\nANSWER: 18',
  'reasoning-letter-count': 'strawberry has 3, raspberry has 3.\nANSWER: 6',
  'constraint-no-e': 'A dog and a cat sat down by that big wall today.',
  'constraint-seven-words': 'The ocean holds many secrets beneath waves.',
  'constraint-acrostic-loupe': 'Light bends through the glass\nOver every hidden flaw\nUntil the truth appears\nPatiently it waits\nEvery detail seen',
  'constraint-json-only': '{"name": "Mira Kalen", "age": 34}',
};
const bad: Record<string, string> = {
  'coding-parse-range': 'function parseRange(s){return [1];}',
  'reasoning-prime-3599': 'It looks prime to me.\nANSWER: prime',
  'constraint-seven-words': 'The ocean holds many secrets beneath the rolling waves.',
  'constraint-json-only': 'Sure! Here is the JSON: {"name": "Mira", "age": 34}',
};

for (const [file, tasks] of packs) {
  for (const t of tasks) {
    test(`pack ground truth: ${t.id} reference solution scores 1.0`, async () => {
      const ref = good[t.id];
      assert.ok(ref, `missing reference solution for ${t.id} — add it to packs.test.ts`);
      const r = await grade(t.grader, ref);
      assert.equal(r.score, 1, `${file}/${t.id}: ${r.detail}`);
    });
  }
}

for (const [id, wrong] of Object.entries(bad)) {
  test(`pack ground truth: ${id} wrong answer scores < 1`, async () => {
    const task = [...packs.values()].flat().find((t) => t.id === id)!;
    const r = await grade(task.grader, wrong);
    assert.ok(r.score < 1, `${id}: wrong answer scored ${r.score}`);
  });
}
```

- [ ] **Step 3: Run the pack tests**

Run: `npx tsx --test src/packs.test.ts`
Expected: PASS. If any reference solution fails, fix the GRADER or the reference until ground truth holds — do not delete the check.

- [ ] **Step 4: Wire `--pack` and `--task` into bench** — in `src/cli.ts` bench block, add `readdirSync` to the `node:fs` import and replace the `tasksPath`/`tasks` lines:

```ts
    const packsDir = join(here, '..', 'benchmark', 'packs');
    if (typeof flags.pack === 'string' && typeof flags.tasks === 'string') {
      console.error('Error: pass --pack or --tasks, not both.');
      process.exit(1);
    }
    let tasksPath: string;
    if (typeof flags.pack === 'string') {
      tasksPath = join(packsDir, `${flags.pack}.json`);
      if (!existsSync(tasksPath)) {
        const available = readdirSync(packsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
        console.error(`Error: unknown pack "${flags.pack}". Available: ${available.join(', ')}`);
        process.exit(1);
      }
    } else {
      tasksPath = typeof flags.tasks === 'string' ? flags.tasks : join(here, '..', 'benchmark', 'tasks.json');
    }
    let tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; prompt: string; grader?: Grader }>;
    if (typeof flags.task === 'string') {
      tasks = tasks.filter((t) => t.id === flags.task);
      if (tasks.length === 0) {
        console.error(`Error: no task with id "${flags.task}" in ${tasksPath}`);
        process.exit(1);
      }
    }
```

Update `USAGE` bench section: add `[--pack coding|reasoning|constraint] [--task <id>]` to the flag list and the line:

```
    --pack <name> runs benchmark/packs/<name>.json; --task <id> runs one task.
```

- [ ] **Step 5: Full suite + a no-network bench smoke**

Run: `npx tsx --test src/*.test.ts src/engines/*.test.ts`
Expected: PASS.

Run: `npx tsx src/cli.ts bench --pack nope 2>&1 | head -2`
Expected: `Error: unknown pack "nope". Available: coding, constraint, reasoning` with non-zero exit.

- [ ] **Step 6: Commit**

```bash
git add benchmark/packs src/packs.test.ts src/cli.ts
git commit -m "feat: coding/reasoning/constraint task packs + bench --pack/--task (ROADMAP #3)"
```

---

### Task 7: Statistical rigor — mean±stddev + small-n flag (ROADMAP #7)

**Files:**
- Modify: `src/report.ts` (`ArmStats.stddevScore`, `aggregate`, `formatReport`)
- Test: `src/report.test.ts`

**Interfaces:**
- Produces: `ArmStats.stddevScore: number | null` (sample stddev, n-1; null when < 2 graded runs). Table shows `mean ±stddev`; a `small n` warning line prints when any graded arm has < 5 graded runs. `reportJson` picks the new field up automatically (stats are serialized whole).

- [ ] **Step 1: Write the failing tests** (append to `src/report.test.ts` — reuse its existing record-builder helpers if present, otherwise inline records shaped like `RunRecord`)

```ts
test('aggregate: stddevScore is the sample stddev; null under 2 graded runs', () => {
  const recs = [
    { taskId: 't', mode: 'advised', score: 0.5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
    { taskId: 't', mode: 'advised', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
    { taskId: 't', mode: 'baseline', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
  ];
  const stats = aggregate(recs);
  const advised = stats.find((s) => s.mode === 'advised')!;
  const baseline = stats.find((s) => s.mode === 'baseline')!;
  assert.ok(Math.abs(advised.stddevScore! - 0.35355) < 1e-4);
  assert.equal(baseline.stddevScore, null);
});

test('formatReport: shows ±stddev and warns on small n', () => {
  const recs = [
    { taskId: 't', mode: 'advised', score: 0.5, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
    { taskId: 't', mode: 'advised', score: 1.0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, rounds: 1 },
  ];
  const out = formatReport(aggregate(recs));
  assert.match(out, /±0\.35/);
  assert.match(out, /small n/i);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx tsx --test src/report.test.ts`
Expected: FAIL — `stddevScore` undefined / no `±` in output.

- [ ] **Step 3: Implement in `src/report.ts`**

Add to `ArmStats` after `scoreRange`:

```ts
  // Sample stddev (n-1) of graded scores; null when < 2 graded runs. What
  // separates "advised is better" from "advised got lucky once" (ROADMAP #7).
  stddevScore: number | null;
```

Add next to `mean`:

```ts
const sampleStddev = (xs: number[]): number | null => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
```

In `aggregate`'s `stats.push({...})` add `stddevScore: sampleStddev(scores),` after `scoreRange`.

In `formatReport`, replace the score-cell construction with mean±stddev (range stays in the JSON only):

```ts
    const score =
      s.meanScore === null
        ? '—'
        : `${s.meanScore.toFixed(2)}${s.stddevScore !== null ? ` ±${s.stddevScore.toFixed(2)}` : ''}`;
```

After the table loop (before the `lines.push('');`), add the small-n warning:

```ts
  const smallN = stats.filter((s) => s.gradedRuns > 0 && s.gradedRuns < 5);
  if (smallN.length > 0) {
    lines.push(`  (small n: ${smallN.map((s) => `${s.mode}=${s.gradedRuns}`).join(', ')} graded runs — directional only, raise --repeat for confidence)`);
  }
```

- [ ] **Step 4: Run report + full suites**

Run: `npx tsx --test src/report.test.ts` then `npx tsx --test src/*.test.ts src/engines/*.test.ts`
Expected: PASS. Note: the pre-existing test named `'aggregate: means + score range per arm'` still passes — `scoreRange` is kept in the stats/JSON, only the table cell changed.

- [ ] **Step 5: Commit**

```bash
git add src/report.ts src/report.test.ts
git commit -m "feat: mean±stddev per arm + small-n warning in bench report (ROADMAP #7)"
```

---

### Task 8: Docs — ROADMAP status, design log, README flags

**Files:**
- Modify: `ROADMAP.md` (#3, #4, #7, #11 → ✅ DONE with one-line outcomes)
- Modify: `docs/design.md` (append §25)
- Modify: `README.md` (bench usage: `--pack`, `--task`; run usage: `--json`, `-` stdin; exec grader line-per-check contract)

- [ ] **Step 1: ROADMAP.md** — mark items done in place, mirroring #2's ✅ style:
  - #3: `✅ **DONE — task packs**` … `benchmark/packs/{coding,reasoning,constraint}.json`, all deterministic graders, ground-truth-tested in `src/packs.test.ts`; `bench --pack <name> [--task <id>]`.
  - #4: `✅ **DONE — per-assertion exec scoring**` … score = passing/total checks; failing checks (with errors) are the verify-mode feedback.
  - #7: `✅ **DONE — statistical rigor**` … mean±stddev (sample) per arm + small-n (<5) warning; stddev in `--out` JSON.
  - #11: `✅ **DONE — <<needs-review>> marker**` … escalated-mode builders can flag uncertainty; flagged rounds skip self-review and spend the escalation immediately; logged in usage.jsonl.

- [ ] **Step 2: design.md §25** — append a dated entry (2026-07-10) summarizing: stash@{1} triage (what was ported: marker, --json/stdin, usage.jsonl, npm-shim, retry, strict APPROVED; what was superseded: escalate-mode prototype, checks-array scoring, cacheCreation tracking, live narration), then #4 (harness design: one check per line, LOUPE_SCORE stdout protocol, fractional score, targeted feedback), #3 (packs + ground-truth sanity tests as the honesty mechanism), #7 (sample stddev + small-n rule). Note the grader contract change: each `tests` line must be self-contained.

- [ ] **Step 3: README.md** — update the bench/run usage snippets to include the new flags, and document the exec-grader per-line contract in the grader table/section.

- [ ] **Step 4: Commit**

```bash
git add ROADMAP.md docs/design.md README.md
git commit -m "docs: mark ROADMAP #3/#4/#7/#11 done; design log §25; README flags + grader contract"
```

---

## Final verification (after all tasks)

- [ ] `npx tsx --test src/*.test.ts src/engines/*.test.ts` — everything green.
- [ ] Live smoke: `npx tsx src/cli.ts bench --pack reasoning --task reasoning-letter-count --repeat 1 --builder-engine claude-code --builder-model sonnet --reviewer-engine claude-code --reviewer-model sonnet --consults 1` — arms run, per-mode grades print, report shows the small-n warning, `usage.jsonl` grows.
- [ ] `tsc` unavailable locally — push to CI for the typecheck gate (user decides when to push).
