# loupe — Build history (changelog)

> Moved from `docs/design.md` (2026-07-11) with **section numbers preserved** —
> code comments and ROADMAP.md cite these as "design §N". §0–14 (the pre-build
> spec) were superseded by the code itself; the current design lives in
> [`ARCHITECTURE.md`](ARCHITECTURE.md).

## 15. Implementation pivot — no metered API, two free engines (superseded §2/§4/§11 client details)

Between design and build, the requirement changed: **no Anthropic Console API key at all**, not even for the reviewer. §2's "custom orchestrator" decision stands unchanged; only which engine each call goes through changed.

**Two engine options, either role, config-only choice — no direction constraint, since neither is Anthropic's beta tool:**

| Engine | How | Cost |
|---|---|---|
| `local` | HTTP to a running Ollama instance (`POST /api/chat`) | $0, your own compute |
| `claude-code` | Spawn headless `claude -p "<prompt>" --model <alias> --output-format json`, parse `.result` + `.usage`/`.total_cost_usd` | Subscription-covered, no separate charge |

**Benchmark design — three arms, not two** (added after `advisor()` review flagged a real confound): `baseline` (1-pass, no reviewer) vs `advised` (N-pass + reviewer) can't isolate whether the *reviewer* helped or whether *any* N-pass revision would've helped. `self-review` (reviewer config == builder config) closes that gap for near-zero extra code — the runner already treats reviewer/builder as independent configs, so pointing both at the same engine+model needed no special-casing. `advised` only means something if it beats `self-review`.

**Gotchas found only by actually running it (all fixed in code, kept here so nobody rediscovers them the hard way):**
- `--bare` looked like the right flag to isolate each consult call from ambient CLAUDE.md/memory/hooks context — it isn't. Verified live: `--bare` forces `ANTHROPIC_API_KEY`/`apiKeyHelper`-only auth and never reads OAuth/keychain, which breaks subscription login entirely. Not used. Trade-off accepted instead: every `claude-code` call carries ambient context (observed 10k–50k+ cache-read tokens on trivial prompts) — real usage against subscription rate limits, not a real dollar cost.
- Windows: `execFile('claude', …)` → `ENOENT` (bare name doesn't resolve `.cmd` shims). `execFile('claude.cmd', …)` → `EINVAL` (`.cmd` isn't directly spawnable without `shell:true`). `shell:true` → arguments get concatenated, not escaped (Node's own deprecation warning) — multi-word prompts silently lost most of their content to cmd.exe word-splitting. Fix: prefer `CLAUDE_CODE_EXECPATH` (points at the real `.exe`, set automatically inside a Claude Code session) — no shell needed, Node's normal argv escaping just works.
- Headless mode waits ~3s for stdin before proceeding if not explicitly closed — set `stdio: ['ignore', 'pipe', 'pipe']` to skip the wait on every call.

**Provider-agnostic client-swap idea from §4 (Vertex/Bedrock) is moot for now** — there's no paid-API code path left to swap a provider under. Revisit if a metered-API engine option gets added back later.

---

## 16. First real benchmark, the cost problem it found, and the fix plan (2026-07-07)

**What shipped this session, in order:**
1. `--tools ""` added to the `claude-code` engine (§15's client) — without it, headless calls ran as full agentic sessions (one builder call wrote a stray file to disk unprompted; a reviewer call stalled on an unanswerable permission prompt). This was invalidating every result — fixed and verified live before any benchmark numbers below were collected.
2. Bench-loop error handling — a failed/rate-limited call used to crash the entire `bench` run (hit a real subscription 429 mid-run, killed everything). Fixed to match this doc's own §8 intent: reviewer failure ships the builder's output without review and logs a note (`runner.ts`); builder failure still throws (nothing to ship that round) but the `bench` loop (`cli.ts`) now catches per-arm, logs, and moves to the next task/mode instead of exiting.
3. A full clean 3-task × 3-arm run (sonnet builder, opus reviewer, `benchmark/tasks.json`) — first trustworthy numbers.

**Results — quality:** all three arms produced a correct answer on all 3 tasks. No arm caught an actual defect the others missed; these 3 tasks were easy enough that baseline alone already nailed them. `advised` did add small, real polish twice — a one-line rationale comment on the fizzbuzz branch order, and a softer, more specific apology-email rewrite that took 3 rounds (opus didn't rubber-stamp round 1, the only arm where real back-and-forth happened) — but nothing that changed correctness.

**Results — cost, summed across all 3 tasks:**

| Arm | Total tokens | vs. baseline |
|---|---|---|
| baseline | 1,347 | 1x |
| self-review | 2,313 | 1.7x |
| advised | 19,017 | **14x** |

**Root cause, verified live (correcting an earlier wrong guess in chat — logged here so it isn't repeated):** first guess was "opus and sonnet never share cache." Retested directly: two back-to-back headless opus calls showed the *second* one hit `cache_read_input_tokens: 9999` / `cache_creation_input_tokens: 0` — full reuse. Caching across separate `claude -p` processes works fine. What actually happened in the benchmark: opus was only called 2–5 times total in the whole run, and the *first* opus call of the run eats a one-time cold-start tax (ambient CLAUDE.md/system-prompt block, ~6,000–10,000 tokens, billed as `cache_creation` not a discounted `cache_read`). This is visible in the run's own numbers — opus's cost per call dropped from $0.2666 (fizzbuzz, opus's 1st call) to $0.0886 (riddle, opus's last call), ~3x cheaper, as the cache warmed up over the run. `--system-prompt <custom>` was tested as a possible fix (replace the default CLAUDE.md-laden prompt) — verified live it does **not** help; ambient per-call context comes in through a different injection point than the system-prompt flag controls, and total tokens were the same or worse.

**Goals for next session (not yet built):**

- **Warm the reviewer's cache once before the real loop** — fire one cheap throwaway call in the reviewer's model at `bench` startup, so the cold-start tax lands on a warm-up call instead of on task 1's real numbers. Cheapest fix, do this first.
- **Escalation instead of always-advised** — self-review every round (same model, cache stays warm, already-measured 1.7x), only invoke the different/bigger reviewer on the last round or when self-review doesn't approve. Cuts opus call *count*, compounds with the warm-up fix. This revives §9/§10's escalation idea, dropped from v1 scope — worth reconsidering now there's a measured reason to want it.
- **Observability gap:** `usage.ts` only prints raw `input_tokens`; `cache_creation_input_tokens`/`cache_read_input_tokens` are captured on the `claude-code` engine's `CallResult` (`cacheReadTokens`) but never surfaced. Fix this before trusting any future token comparison — right now the printed "tokens: X in" numbers understate what actually moved by the cache-creation amount, and hide exactly the warm-up-vs-cold-start effect described above.
- **Re-run the benchmark** once the above land — current numbers are a single run, 3 tasks, `repeat: 1`, still just a directional smoke test (§13's third risk, still unvalidated).
- **Still open from earlier sections, unchanged:** Claude Code skill wrapper (§12 non-goal, fast-follow), escalation via structured marker rather than string (§9's "future" note), `saver`-mode validation (§10, §13).

---

## 17. Cost-fix work shipped: observability, warm-up, escalated mode, config, tests

Everything §16 flagged "not yet built" as a next-session goal is now built — except the confirming re-benchmark, which still needs a live subscription/Ollama run and is the immediate next step.

**What shipped, in dependency order:**

1. **Cache-token observability (do-first per §16).** The `claude-code` engine now captures `cache_creation_input_tokens`, not just `cache_read_input_tokens` — `cache_creation` is the field that *is* the one-time cold-start tax, so the old code literally couldn't see the thing that explained the 14x. `usage.ts` now prints `cache: <read> / <creation>` for any run with `claude-code` calls. Without this, no post-fix number would be trustworthy; done first on purpose.
2. **Cache warm-up at `bench` startup.** Before any arm is timed, `cli.ts` fires one throwaway call to the reviewer model so the cold-start tax lands on the warm-up, not on task 1's real numbers. Best-effort: a failed warm-up is logged, not fatal (the run just eats the cold start as before).
3. **`escalated` mode (new, 4th arm).** `runner.ts` gains a mode that does cheap self-review every round (builder critiques itself, cache stays warm) and invokes the bigger reviewer **at most once per run** — the first time self-review isn't satisfied. This bounds the expensive reviewer's *call count* (advised calls it every round), compounding with the warm-up. Added to the `bench` arm list so it can be measured head-to-head against `advised`. Revives §9/§10's escalation idea with the measured reason §16 asked for.
   - **Interpretation note:** §16 said "invoke the bigger reviewer on the last round or when self-review doesn't approve." Implemented as a hard ≤1-escalation-per-run bound (fires on the first self-review non-approval; never again that run). That's the laziest faithful reading; if a later benchmark shows self-review needs the big reviewer more than once on hard tasks, relax the bound then — not before.
4. **JSON config loader (`src/config.ts`).** `--config <path.json>`, hand-rolled validation, **zero new deps** — chose JSON over the §5/§6 YAML+zod design to keep the repo dependency-free (consistent with §15's "no metered API, stay minimal" turn). Deliberately validates only the knobs the engines actually consume today (`builder`, `reviewer`, `mode`, `consults`); §5's `effort`/`token_budget`/`direction`/`frequency`/`consult_context`/marker/`caching` are omitted until the features behind them exist — accepting them now would be config for values nothing reads. Precedence: built-in defaults < config file < individual CLI flags.
5. **First test harness.** `node:test` run through `tsx` (`npx tsx --test src/*.test.ts`), 14 tests. `runner.run()` was refactored to take an injectable `callFn` (defaulting to the real engine dispatcher) so the loop's control flow — early-break on approval, reviewer-failure-ships-without-review, the escalated ≤1 bound and feedback-flow — is unit-testable with a fake engine, no API calls. `config.ts` validation rejections are covered too.

**Verified this session:** 14/14 unit tests pass; the full CLI module graph compiles under `tsx`; an invalid `--config` file throws its validation error *before* any engine call. **Not verified:** the live re-benchmark — §16's numbers are still the last real data.

**Immediate next step (unchanged from §16, now unblocked):** run `bench` again with the warm-up + observability + `escalated` arm and record the post-fix token table here. The specific hypothesis to check: `escalated` keeps `advised`'s catches while its cache-creation total and reviewer call count drop toward `self-review`'s.

---

## 18. Multi-provider engines (2026-07-08)

Scope grew: work across providers, not just ambient Claude Code. Full design in
[`docs/specs/2026-07-08-multi-provider-engines.md`](specs/2026-07-08-multi-provider-engines.md);
this is the session log.

**What triggered it:** a `bench` run failed every arm. Root cause (found by
surfacing the error claude wrote to stdout — see the `parseClaudeResult` fix):
this machine's `claude` routes through **Google Vertex AI**
(`CLAUDE_CODE_USE_VERTEX`), which returned `429 RESOURCE_EXHAUSTED` (quota) for
both sonnet and opus. That killed the §15 assumption that these calls are
"free/subscription-only" — they're metered here. The user's response was to
generalize the tool to any provider with per-role provider choice.

**What shipped:**
- **Engine interface + registry** (`src/engines/types.ts`, `index.ts`) — one
  `CallResult` shape for all providers; `runner`/`config`/`cli` go through the
  interface, so new engines are one registry entry. This revives §4/§15's
  provider-agnostic idea, dropped when the premise was "no paid API at all".
- **`codex` engine** (`src/engines/codex.ts`) — headless `codex exec --json`
  (read-only sandbox + `-a never` = the codex analog of claude's `--tools ""`).
  Parser is fixture-tested; **not verified against an installed codex** (none on
  this machine) — flagged in-file.
- **`local` + `claude-code`** refactored behind the interface (no behavior
  change; the 429-surfacing fix retained).
- **Detection + `providers` command** — each engine self-reports; `advisor
  providers` prints the availability table.
- **Selection** (`src/selection.ts`, pure + unit-tested) — precedence flags >
  config > interactive prompt (TTY) > auto-detected default. Cross-provider
  pairing is free via the already-independent builder/reviewer configs.
- **Direct-API (key-based) engines** — designed extension point, **not built**
  (add when a keyed workload needs them; secrets via env only).

**Verified:** 29/29 unit tests; `advisor providers` correct live (claude-code ✓
Vertex, codex ✗, local ✗); unknown-engine guard exits before any call. **Not
verified:** any live codex or cross-provider run (codex not installed; claude
still 429). Test count: 16 → 29.

---

## 19. Evaluation layer — make the benchmark answer its own question (2026-07-08)

**The core problem this fixes:** the tool measured cost (tokens) but never
**quality**, so it could not actually answer "does the reviewer help, and at what
cost?" §16's "all arms were correct" was a human eyeball on 3 trivial tasks with
no headroom — which is how a 14× cost looked like pure waste. Without a quality
measure, that verdict was unfounded in either direction.

**What shipped:**
- **Grader** (`src/grader.ts`, pure + injectable) — scores an output 0–1.
  `includes` (fraction of required strings), `regex` (match/no-match), and
  `judge` (an LLM scores 0–10 against a rubric; engine injectable, so tested
  offline). Execution-based grading (run code/tests) deliberately deferred —
  running model-generated code needs a sandbox (a security boundary, §13).
- **Report** (`src/report.ts`, pure) — `aggregate` + `formatReport` produce the
  product: a per-arm quality×cost table (mean score + range, mean in/out/total
  tokens, cache-creation) and a **verdict** — best quality, cheapest-at-top-
  quality, best quality-per-token, and each arm's Δquality-vs-baseline at N×
  cost.
- **Headroom tasks** (`benchmark/tasks.json`) — every task now has a `grader`,
  plus tasks single-pass models actually slip on (no-`e` sentence, bat-and-ball
  trap, exact-word-count) so arms can *differ* and grading is meaningful.
- **`bench` wiring** — grades each arm's final output (judge graders use the
  reviewer model; a grading failure leaves the run ungraded, never aborts),
  collects records, prints the report. `runOne` now returns its `RunResult`;
  `tallyTokens` extracted from `usage.ts` and reused.
- **`--tasks <path>`** — point `bench` at your own workload; the real value is
  "which mode is worth it for *your* tasks," not the built-in set.

**Verified:** 40/40 unit tests; the report renders correctly on fixture records
(quality×cost table + verdict). **Not verified live:** a real graded `bench` run
(engines still Vertex-429; judge grading also needs a working engine) — but the
scoring/aggregation/verdict are pure and fully unit-tested, so they're correct
independent of a live run. Test count: 29 → 40.

**Why this is the highest-leverage change:** it turns the project from "prints
outputs + tokens" into "tells you, per workload, which mode gives the best
quality per token." That's the actual product. Positioning sharpens too: not
"another advisor," but *the harness that tells you whether advising is worth it
for your tasks.*

**Next (roadmap, not built):** execution-grounded code review (reviewer runs the
tests and feeds failures back — where a second pass most clearly wins, needs
sandboxing); the §9 self-uncertainty escalation marker; parallel `bench` for
wall-clock; writing report records to a JSON file for later analysis.

---

## 20. Review-driven fixes + execution-grounded core (2026-07-09)

Three independent review agents (correctness, product-skeptic, YAGNI) checked the
work. They converged on real confounds in the §19 evaluation layer; this section
records the fixes and the execution-grounded pivot the product-skeptic pushed
(and the other two corroborated).

**Methodology fixes (the eval layer was measuring itself):**
- **Independent judge.** The `judge` grader used the reviewer model (opus), which
  also shapes the `advised`/`escalated` outputs — self-enhancement on judge
  tasks. Added `--judge-engine`/`--judge-model` and a printed caveat when the
  judge coincides with an arm's builder/reviewer. `bench` also now takes a real
  judge, not a hardcoded one.
- **Honest cost proxy.** The proxy omitted cache-read — but the CLI engines
  re-read a big ambient block on EVERY call, so cache-read is what scales with
  reviewer call-count. Excluding it made a 5-call arm look ~1× a 1-call arm. Now
  `total = input + output + cacheRead + cacheCreation`, with a cacheRead column.
  (Illustratively, `advised` now reads ~5× baseline, not ~1×.)
- **`bench` honors providers.** It was hardwired to claude sonnet/opus, so it
  ignored the entire multi-provider layer and couldn't fall back to local/codex
  on the 429'd machine. Now resolved via config/flags through `planSelection`.
- **Grader false-positives.** `reasoning-riddle` matched the "9" echoed from the
  prompt; `constraint-no-e` matched the empty string. Both tightened.
  `parseJudgeScore` now prefers `N/10` / the last integer (dodges scale-echoes).
- **Cross-provider selection bug.** `--builder-engine codex` with a config of
  `{claude-code, sonnet}` used to run codex with model "sonnet"; a flag engine
  override now drops a different engine's config model and uses the default.

**Execution-grounded core (the strategic pivot — test result as ground truth):**
- **`exec` grader.** Runs the model's code against `tests` in a subprocess
  (timeout, throwaway temp dir; security ceiling documented in `grader.ts` — not
  a syscall sandbox). Score = tests pass. No LLM-judge confound.
- **`verify` mode.** A programmatic verifier is the in-loop reviewer: failures
  feed back to the builder, no LLM reviewer, no tokens. The **same** exec grader
  is BOTH the in-loop signal AND the scorer — removing both thumbs from the
  scale, on the one task class (code/math) where a second pass reliably beats
  solo. `bench` adds a `verify` arm wherever a task has an exec grader.

**YAGNI cuts:** write-only `CallResult.engine`; `DetectResult.models` → a count;
the report's redundant "best quality per token" ranking.

**Verified:** 44/44 unit tests (the exec grader runs real `node` subprocesses;
the `verify` loop is unit-tested with an injected verifier); the report renders
the honest cost columns. **Not verified live:** a full graded `bench` (claude
still 429; codex/ollama absent) — but graders, verify loop, cost, and verdict
are pure/injectable and fully tested. Test count: 41 → 44.

**Why it matters:** with honest cost + an exec grader + `verify`, the report now
shows the execution-grounded arm winning on BOTH quality and cost — the concrete,
defensible result the tool previously couldn't produce. That answers the
product-skeptic's core objection: the value is programmatic verification, and the
tool now targets and measures exactly that.

---

## 21. Robustness, JSON export, and a typecheck gate (2026-07-09)

Hardening pass + the first real live runs on Vertex (us-east5).

**Live proof (finally ran, opus in `CLOUD_ML_REGION=us-east5`):** the whole
pipeline works end-to-end on Vertex — generation, exec grading, verify loop,
error-handling (transient ECONNRESETs shipped/skipped gracefully), reproducible
n=5 verdicts. Region matters: `eu_multi_region` is 429-quota-dead for every
model; `us-east5` serves `opus` and `claude-sonnet-4-6` (not sonnet-4-5, not
sonnet-5). Every *failure* observed live was **ambient output-style
contamination** — the spawned builder inherits the caller's Explanatory style and
appends `★ Insight` / backtick prose that breaks the exec grader — never an
actual algorithm error. Both opus and sonnet-4-6 solve the test tasks reliably,
so "does review help" is still unproven for lack of a genuinely weak builder.

**Fixes shipped:**
- **`extractCode` hardened** — strips trailing prose (backtick notes, plain
  explanatory sentences, ★/─ boxes), not just decorations. This was the dominant
  false-failure source in the live runs. Still best-effort; the root cure is not
  inheriting an explanatory style in the first place.
- **CLI flag validation** — `--mode` checked against `MODES`; `--consults`/
  `--repeat` must be non-negative integers (a bad value silently ran zero
  iterations before). `MODES` is now a single exported source — config had been
  silently missing `verify`.
- **`local` call timeout** (AbortSignal) so a hung Ollama can't stall a bench;
  **codex usage summed** across turn events (was overwritten).
- **`bench --out results.json`** — writes `{meta, stats, records}` so runs
  accumulate and can be diffed over time (one-shot → real eval harness).
- **Typecheck gate** — added `tsconfig.json` + `npm run typecheck` (tsc
  `--noEmit`) and devDeps (tsx/typescript/@types/node). tsc immediately caught
  real issues tsx had silently ignored: the `stdio` option was **invalid on
  execFile** (confirming it never suppressed the stdin wait — removed), several
  `unknown`-typed `res.json()` reads, and a control-flow-narrowing bug in a test.
  All fixed; `tsc --noEmit` is clean.

**Verified:** 49/49 unit tests pass; `tsc --noEmit` exits 0; `--out` writes valid
JSON; live Vertex runs produced real reproducible verdicts. **Remaining for a
real "review helps" result:** a genuinely weak builder (local Ollama small model)
or a task the strong models actually fail — plus the still-unbuilt §9
self-uncertainty marker and direct-API engines.

---

## 22. First real "review helps" result — weak local builder + opus reviewer (2026-07-09)

The experiment the whole project was built to run. Builder = `qwen2.5-coder:1.5b`
(local Ollama, weak, free), reviewer = `opus` (Vertex us-east5); hard task
(`abbreviate`, the truncate/drop-`.0` trap); n=3, consults=2. Total opus cost
$0.47 (local builder is free).

```
arm          runs   score          meaning
baseline      3     0.00           weak model solo: 0/3 (genuinely wrong code, e.g. 1000 -> "1000M")
self-review   3     0.00           weak model reviewing itself: 0/3 (can't catch its own error)
advised       3     0.67 [0-1.00]  opus reviewer: 2/3 fixed   ← review demonstrably helps
escalated     3     0.00           one opus hint wasn't enough: 0/3
verify        3     0.33 [0-1.00]  test-failure fed back: 1/3 fixed
```

**Verified honest, not a grader artifact:** the baseline output arrived in a
clean ```` ```javascript ```` fence, so `extractCode` got clean code — and that
code is genuinely wrong. This is a real capability failure the reviewer fixed.

**Findings:**
- **Review helps when the builder is weaker than the reviewer** — solo 0/3 →
  advised 2/3. This is the tool's core thesis, finally shown on real data.
- **Self-review can't rescue a weak model** (0/3) — a critic no better than the
  author adds cost, not quality. Confirms why `advised` (a *different*, stronger
  reviewer) is the arm that matters.
- **Bounded escalation backfired on a very weak builder** (0/3 vs advised's 2/3):
  one opus hint (escalated) wasn't enough; the builder needed opus feedback
  *every* round (advised). The cost-saver assumes the builder can run with a
  single nudge — false when it's this weak. Genuinely decision-relevant.
- **Programmatic verify recovered 1/3** — feeding the exact failing assertion
  back sometimes let even the weak model self-correct, at ~1/20th advised's cost.

**Caveat:** n=3 is directional; advised's "88× baseline cost" is inflated because
the local baseline is ~free — absolute opus cost was ~$0.15/advised run. Minor
tech debt surfaced: the grader's failure *detail* prints the stack-trace tail
instead of the thrown assertion message (the score is correct; the message is
unhelpful).

---

## 23. Ambient contamination fixed at the source (2026-07-10)

The recurring benchmark polluter — the spawned `claude-code` builder appending
`★ Insight` prose (which broke the exec grader and produced false 0.00s all
session) — traced to the builder inheriting the **caller's** user-global settings,
including the output style. An "Explanatory"-styled caller styled the builder too.

Fix (confirmed by experiment on us-east5 / sonnet-4-6): pass
**`--setting-sources project,local`** so the spawned model loads only
project/local settings, never the user-global output style — it runs vanilla. An
`--append-system-prompt "no markdown"` attempt backfired (it *added* a code
fence), so it was rejected. Ordinary markdown fences still appear sometimes and
are fine — `extractCode` extracts them cleanly, so it's now a light safety net,
not the primary defense. Also fixed this session: the grader's failure detail now
surfaces the thrown assertion message rather than the stack-trace tail.

Verified: no `★` across repeated live runs through the engine; 49/49 unit tests
and `tsc --noEmit` still green. This closes ROADMAP item #2 — the top correctness
lever.

## 24. Hooks-tax fix ported + live consult visibility (2026-07-09)

Two pieces ported from a parallel local session (rest of that work parked in `git stash@{0}` on the dev machine):

**ROADMAP #2, the hook channel, with the measurement it asked for.** User-level SessionStart hooks inject their instructions as UNCACHED input into every headless `claude -p` call — both a token tax and the source of style contamination (the hook text on the dev machine literally instructs terse/caveman prose). Controlled experiment, same trivial prompt, sonnet, `--tools ""`:

| config | input | cache_new | notional $ |
|---|---|---|---|
| defaults (project dir) | 3,638 | 12,315 | $0.0862 |
| empty cwd | 3,638 | 11,857 | $0.0834 |
| `--settings {"disableAllHooks":true}` | **2** | 0 | **$0.0055** |

Fix shipped in `src/engines/claude-code.ts`: every call passes `--settings <tmpfile>` with `{"disableAllHooks": true}` (a file, not inline JSON, so the `.cmd` shell fallback can't mangle quotes). Empty-cwd isolation rejected (~2%). Remaining #2 work: a user-configured *output style* may leak through a different channel than hooks — measure contamination rate before/after per the roadmap.

**Live consult visibility.** The runner now narrates to stderr as it happens — builder pass (tokens), reviewer consult, verdict/critique first line, escalation events, verify pass/fail. stdout stays clean for piping. Explicit user requirement: seeing WHEN the advising happens, not just end-of-run totals.

Both verified: 49/49 unit tests green (stderr notes don't touch assertions), live smoke run on a local model shows the narration. Typecheck not run this session — npm registry (corporate Nexus) unreachable from the dev machine's network, so devDependencies couldn't install; CI covers it on push.

*(Merge note 2026-07-10: this entry and §23 landed from two parallel sessions solving the two halves of ROADMAP #2 — §23 closed the output-style channel with `--setting-sources project,local`, this one closed the hook channel with `disableAllHooks`. The engine now passes both flags.)*

---

## 25. Roadmap batch: stash triage, packs, per-assertion scoring, stddev (2026-07-10)

**Stash@{1} triage.** The 2026-07-09 parked WIP predated the multi-provider
rebrand, so most of it was already superseded upstream (its `escalate` mode →
`escalated`, its `checks` arrays → the grader system, its cacheCreation
tracking and stderr narration → already landed). Ported the survivors into the
current codebase instead of applying the stash: strict `isApproval` (first
line must BE "APPROVED" — "APPROVED, but…" is a critique), the `<<needs-review>>`
uncertainty marker (ROADMAP #11: escalated-mode builders append it when unsure;
a flagged round skips self-review and fires the one escalation immediately),
`--json` + stdin `-` on `run`, a per-run `usage.jsonl` append (never fatal),
npm-shim `.exe` resolution for claude outside a session, and one blind 3s retry
per engine call (covers transient 429/5xx that used to cost a whole bench arm).

**ROADMAP #4 — per-assertion exec scoring.** The exec grader no longer
concatenates code+tests and reads the exit code. Each non-empty line of `tests`
is one self-contained check; a generated harness (python/node) runs them
individually, prints `LOUPE_SCORE passed/total` + up to 3 `LOUPE_FAIL <line ->
error>` lines, and always exits 0. Score is the passing fraction; the failing
lines are the detail — which is exactly what `verify` mode feeds back to the
builder, so targeted feedback came free. Code that crashes at load still hits
the old exit-code path (score 0, stderr's useful line surfaced). Contract
change: multi-line setup inside `tests` is no longer supported — one statement
per line.

**ROADMAP #3 — task packs.** `benchmark/packs/{coding,reasoning,constraint}.json`,
run via `bench --pack <name> [--task <id>]`. All graders deterministic (regex /
includes / exec-node — no judge cost, and node not python so Windows dev
machines can grade). The honesty mechanism is `src/packs.test.ts`: every pack
task's grader must score a known-good reference solution 1.0 and a known-bad
one <1, offline. A "hard" task with a broken grader can't hide.

**ROADMAP #7 — statistical rigor.** `ArmStats.stddevScore` = sample stddev
(n−1), null under 2 graded runs; the report table shows `mean ±stddev` (min-max
range stays in the JSON) and prints a small-n warning when any graded arm has
n<5. Deliberately no confidence intervals at this scale — stddev + n is enough
to stop n=1–3 from reading as signal.

Verified: 77/77 unit tests via `npx tsx --test`; live smoke of `run - --json`
(stdin task, single JSON doc on stdout, narration on stderr, usage.jsonl line
appended, in=2 tokens confirming the §23+§24 combined contamination fix works
through the engine). `tsc` still can't run on this machine (Nexus) — CI gates
typecheck on push.

## 26. Roadmap batch: API engines, bin, diff, GitHub Action (2026-07-11)

**ROADMAP #5 — direct-API engines.** `anthropic-api` (POST /v1/messages,
`x-api-key` + `anthropic-version: 2023-06-01`) and `openai-api`
(POST /v1/chat/completions, bearer). Raw fetch, zero new runtime deps — same
reasoning as the Ollama engine; an SDK for one POST fails the dependency
ladder. Keys from env only, never stored/logged; `detect()` reports key
presence so `providers`/`setup` surface them without a network call. Pure
`parseAnthropicResponse`/`parseOpenAIResponse` are exported and fixture-tested
(text-block joining, cache-token mapping: Anthropic has read+creation, OpenAI
only `cached_tokens` → `cacheReadTokens`). Marked needs-live-verification —
no keys on this machine. Default pairing mirrors claude-code's
cheap-builder/strong-reviewer: sonnet-5 / opus-4-8.

**ROADMAP #6 — bin + build.** Node 24's native type-stripping can't run
`src/cli.ts` (imports use `.js` specifiers, node doesn't remap), so the
promised build step: `tsconfig.build.json` (tests excluded) → `dist/`,
`bin: {loupe: dist/cli.js}` (shebang already present), `files: [dist,
benchmark]` — benchmark ships because packs resolve relative to the CLI.
`prepack` builds. Blocker for actual publish: npm name `loupe` is taken
(chai's inspection lib) — scope or rename, user's call; `private: true` stays.

**ROADMAP #8 — diff.** `diffReports(a, b)` in report.ts (pure, tested):
per-arm score A → B with Δ (± for no change), meanTotalTokens with Δ%, arms
in only one file flagged instead of dropped, meta line identifies each run by
`generatedAt`/builder. CLI `diff a.json b.json` validates shape before
diffing. No separate result store built — `--out` files + `generatedAt` ARE
the store; a managed history dir is YAGNI until someone accumulates enough
runs to want it.

**ROADMAP #9 — GitHub Action.** Composite `action.yml` at repo root; runs
loupe from the action checkout (`github.action_path`) against the caller's
task file (`$GITHUB_WORKSPACE/<tasks>`) or a built-in pack. Defaults both
roles to `anthropic-api` — CI has no CLIs/subscriptions, which is why #5
preceded this. All inputs flow through `env:`, not `${{ }}` inside the
script (template-injection guard). Conditional `[ -n ... ] &&` lines are
mid-script only — safe under Actions' `bash -e`.

Verified: 86/86 tests + clean local `tsc --noEmit` (node_modules restored —
the Nexus registry gotcha bypassed with `npm ci
--registry=https://registry.npmjs.org`; lockfile URLs already pointed at
npmjs). Live: `providers` lists both new engines with key-absent detail;
`node dist/cli.js providers` proves the built artifact; `npm pack --dry-run`
= 21 files / 29.6 kB; `diff` run end-to-end on synthetic bundles; action.yml
YAML-parsed + script dry-run produced the exact expected bench command.
Not verified: live API calls (no keys), the action from a real caller repo.

## 27. Later-batch + tech-debt paydown (2026-07-11)

**ROADMAP #13 — real-$ cost.** `src/pricing.ts`: `costForCall` (longest-
substring model match against a per-MTok table; anthropic rows derive cache
rates as 0.1×/1.25× input) and `estimateRunCostUsd` (provider-reported
notionalCostUsd wins; `local` is $0; one unpriceable call → null for the run —
a partial sum would understate the expensive calls). Surfaced as a `$/task`
report column (`ArmStats.meanCostUsd`, all-or-null per arm), an `est. cost`
line in run usage, and `RunRecord.costUsd` in `--out` JSON. Prices are data
and WILL drift — the header says so.

**ROADMAP #10 — parallel bench.** `src/pool.ts` (bounded worker queue, ~10
lines, tested for peak-concurrency ≤ limit and limit-1 ordering). Bench builds
a flat unit list (task × repeat × mode) and feeds it through the pool;
`--parallel 1` (default) reproduces the old sequential behavior byte-for-byte,
N>1 switches to compact `[task=… run=… mode=…]`-tagged lines because
interleaved full outputs are unreadable. Rate-limit warning printed up front.

**Cleaner — e2e test.** `src/e2e.test.ts` drives the whole pipeline as a
system: run() across all 5 arms with a scripted fake engine (builder ships an
`a - b` bug first, fixes on feedback; reviewer critiques when it sees the bug),
REAL exec grading (node subprocess), aggregate + formatReport assertions.
Baseline scores 0, every feedback arm reaches 1.0 — the project's core claim,
now locked by a test. No network.

**Cleaner — extractCode.** Fence-preferred, validated: fenced blocks (joined,
trailing newline per block trimmed) or verbatim text. The ★-Insight/prose
regexes are deleted — §23/§24 fixed contamination at the source, so leftover
prose now fails the exec grader loudly instead of being silently trimmed by
heuristics that could also eat legitimate code.

**Cleaner — cli.ts split.** 598 → 58-line dispatcher. Commands live in
`src/commands/{run,bench,setup,providers,diff}.ts` with shared plumbing
(USAGE, flag helpers, prompts, resolveDecision, logRun, runOne) in
`commands/shared.ts`. Path anchor: `repoRoot = here/../..` — same depth from
`src/commands/` and `dist/commands/`, so packs and usage.jsonl resolve in both
layouts (verified live: providers/diff/bad-pack on src AND dist, plus a real
`run` through local qwen2.5:0.5b showing the new est. cost line).

**Cleaner — docs split.** This file (CHANGELOG.md) now holds the §15+ build
history with numbering preserved (code comments cite "design §N");
ARCHITECTURE.md is the current-design doc; design.md is a pointer stub. §0–14
pre-build spec retired to git history.

**Cleaner — Node version.** Moot: engines >=24, CI node 24, developed on
24.15. Documented as done.

Verified: full suite green (97 tests: pricing 6, pool 3, e2e 1, extractCode
rewritten, report +5) + clean `tsc --noEmit` + `npm run build`; live smoke of
providers/diff/help/bad-pack via src and dist; one real local-engine baseline
run end-to-end. Skipped deliberately: ROADMAP #12 (unwired config knobs) stays
YAGNI-gated per its own text.

## 28. Roadmap v1 closed — npm publish + README rewrite (2026-07-12)

**Roadmap v1 is fully shipped** (details in §25–§27): contamination fix, task
packs, per-assertion exec scoring, stddev + small-n warning, API engines,
`bin`/build, results diff, GitHub Action, `<<needs-review>>` marker, parallel
bench, real-$ cost, cli/docs splits, e2e test, Node alignment, extractCode
rewrite. Only #12 (unwired config knobs) carries over — still YAGNI-gated.
ROADMAP.md rewritten as v2 (close verification debt, then sharper verdicts).

**Published: `@cihlarr/loupe`.** Unscoped `loupe` is chai's inspect lib and
`loupe-cli` is taken, so scoped under the npm account (`cihlarr`).
`private:true` dropped; `publishConfig.access: public`; repository,
description, keywords added. 0.1.0 published 2026-07-12 and verified by
running `npx @cihlarr/loupe providers` straight from the registry (all 5
engines detected from the packaged `dist/`). Publishing needs the
maintainer's passkey (browser auth) — a manual step by design.

**README rewritten for the npm page** (same file serves GitHub): roadmap
section and the native-Advisor comparison removed, install-first structure
(`npm i -g @cihlarr/loupe`), npm version badge, Action snippet points at the
real `RadekCihlar/Loupe@master`, honest-limits list kept. 0.1.1 bumped to
carry it (npm never re-renders a published version). Repo flipping to public —
required for the banner/badge/repo links to render on npm.

**Action verified from a real caller (v2 roadmap #2).**
`.github/workflows/action-test.yml` consumes `uses: RadekCihlar/Loupe@master`
resolved from origin. No key secret exists yet, so the pass job installs
Ollama on the runner, pulls `qwen2.5:0.5b`, and drives the action with `local`
engines: pack task ran all 4 arms, the report rendered ($/task column
included), and `--fail-under 0` exited PASS. A second job passes a bogus
engine name and asserts the step outcome is `failure` — non-zero exit
propagates to the caller. Both green on the first dispatch (gate-pass 122s,
gate-fail 11s). Untested until a key secret exists: `env:` key pass-through.
Housekeeping: GitHub default branch switched `main` → `master` (`main` was a
stale subset; every reference — badges, `uses:` — already said master).

## 29. Codex engine live — two real bugs found, cross-provider matrix run (2026-07-12)

**Roadmap v2 #3 closed.** codex-cli 0.144.1 installed (`codex login`, ChatGPT
subscription) and the `codex` engine run live for the first time. The parser
survived contact unchanged — both written-to-spec bugs were in *spawning*:

- **stdin hang (indefinite).** `codex exec` always reads stdin for extra
  context when it isn't a TTY ("Reading additional input from stdin..."), even
  with the prompt passed as argv. execFile leaves the child's stdin an open
  pipe with no EOF → codex blocked forever (observed 80+ min, twice). Fix:
  shared `src/engines/spawn.ts` helper (`runBin`) — spawn + immediate
  `stdin.end()`. claude-code.ts moved onto it too, which also killed its ~3s
  per-call "no stdin data" wait (the old ponytail comment had misjudged that
  as cosmetic — it was per-call latency on every claude call).
- **`-m` rejected under ChatGPT auth.** ANY explicit model name — including
  the account's own config.toml default — gets "Model metadata for X not
  found" then a 400 "not supported when using Codex with a ChatGPT account".
  Omitting `-m` works. Fix: engine default model is now `'auto'`, which skips
  the flag; named models kept for API-key auth. `--ignore-user-config` added
  so ~/.codex/config.toml can't skew arms (analog of claude's
  --setting-sources). `-a never` dropped (removed upstream).

**Live pairing matrix (advised mode, LRU-cache task):** sonnet→codex approved
round 0 (correct, $0.075); qwen2.5:3B→codex approved round 1 after a real
catch (capacity-0 KeyError); qwen2.5:0.5b→codex never approved in 4 rounds —
the builder couldn't execute fixes it could describe, and round 3 shipped
byte-identical code with a fabricated changelog claiming the fixes happened.
codex critiques were concrete and correct every round. **New failure mode
found: the too-weak reviewer.** qwen2.5:0.5b→qwen2.5:3B (local only) APPROVED
round-0 code that crashes on its first cache hit (`self.cache.pop()` with no
key → TypeError). A weak reviewer is worse than no reviewer: it converts
broken output into *approved* broken output. Extends §22's "reviewer must be
stronger than the builder" with a floor on the reviewer itself.

**Verified:** 97/97 tests, clean typecheck, live smoke of both CLI engines
through `runBin` (codex 2.7s, claude 4.4s round-trip), five full live runs.

## 30. Roadmap batch: significance + cost-aware verdict, reviewer probe, hard pack (2026-07-12)

**ROADMAP v2 #4, #5, #6, #11 shipped in one batch.**

- **Cost-aware verdict (#5).** When a strictly-lower-scoring arm sits within
  ε (0.02) of the best AND is cheaper, the verdict quantifies the trade:
  "self-review matches advised within 0.01 at 0.1× its tokens — the
  cost-aware pick". Report-only change; the data was already collected.
- **Significance marker (#4).** Welch-style top-vs-runner-up read from
  mean/stddev/n per arm: t≥2 → "clear at this n", else "inconclusive at this
  n, run ~N more repeats" (N from solving t=2 at the observed variance), with
  explicit degradation when an arm has <2 graded runs. Own ~20 lines of math,
  no dependency.
- **Reviewer catch-rate probe (#11).** New `loupe probe` command +
  `benchmark/probe.json`: 5 planted-defect + 5 correct outputs (one fixture
  is the EXACT output a 3B reviewer approved live in §29) sent through the
  runner's real reviewer prompt (now exported — a probe on a different
  prompt measures nothing). Reports catch rate, false-alarm rate, and a
  verdict: trustworthy / unreliable / over-critical / rubber-stamp, the last
  with a loud "worse than no reviewer" warning. Live-verified both
  directions: codex/auto 5/5 caught, 0 false alarms → trustworthy;
  qwen2.5:0.5b 0/5 → rubber-stamp.
- **`hard` pack (#6).** Four edge-case-dense exec(node) tasks where strong
  builders have real headroom: semver prerelease precedence (numeric<alpha,
  prefix rule), ISO-8601 duration (months-vs-minutes M trap, dangling T),
  interval merging (touching intervals + input must not be mutated), RFC-4180
  CSV quoting (doubled quotes, trailing empties). Ground truth proven both
  ways in packs.test.ts: references score 1.0, plausible-buggy solutions
  (lexical semver, any-M-is-minutes, in-place sort, split(',')) score <1.

**Verified:** 117/117 tests (was 98), clean typecheck, probe live-run against
two real reviewers.

## 31. Lean protocol + prompt caching — cheaper requests between models (2026-07-13)

**Ask:** "have the request between models be cheaper" while keeping quality.
Two layers shipped; call count was already covered (escalated / verify).

- **`--lean` (run + bench).** Round ≥1 re-reviews send the reviewer its own
  prior critique + a line-diff of the revision (new `src/textdiff.ts`, ~70
  lines, LCS, zero deps) instead of the full output, and runaway critiques
  are capped at 1500 chars before re-entering the builder prompt. Round 0
  always uses the standard full prompt — so `probe` keeps measuring the real
  thing — and verify-mode feedback (failing tests = ground truth) is never
  capped. Opt-in; flip the default only after `bench --lean` A/Bs prove
  quality parity per workload (`loupe diff fat.json lean.json` is the
  harness, zero new report machinery).
- **The guard that a live run forced.** First live A/B (local 3B, short
  output): the delta prompt came out BIGGER than the standard one — 451 vs
  291 reviewer tokens — because the echoed critique outweighed the diff
  savings. Economy is therefore judged on the WHOLE prompt: build both,
  send the shorter. Lean can only cut tokens, never add. Post-guard live
  run confirmed the win where it should exist: round-1 reviewer 380 tokens
  vs 440 at round 0, on a GROWN output, with approval on the revision.
- **Prompt caching (`anthropic-api`).** The runner now tags every call with
  the length of its stable prompt prefix (task statement — byte-identical
  across a run's rounds); the anthropic-api engine splits it into a
  `cache_control: ephemeral` block (`buildAnthropicBody`, exported +
  parse-tested like the rest of that engine). Other engines ignore the
  metadata; prompt stays one plain string everywhere — no interface churn
  beyond an optional `CallOpts` third arg. No-op below the model's minimum
  cacheable prefix (~1024 tokens): pack tasks won't cache, long real-world
  tasks will. Live proof folds into ROADMAP #1 (needs a key).
- Dropped `callLocal`'s dead `host` param (never passed by any caller) — it
  collided with the new optional `CallOpts`.

**Verified:** 133/133 tests (was 117), clean typecheck, three live lean runs
on local qwen2.5:3B including one multi-round delta-path run.

## 32. Ship-0.2.0 batch: first-run polish, reviewer matrix, `recommend`, lean A/B evidence (2026-07-13)

Prompted by a user-journey audit ("check everything a user can see and have
issues with") ahead of publishing 0.2.0.

- **First-run polish.** `loupe help` and `setup`'s epilogue taught the dev
  invocation (`tsx src/cli.ts …`) to npm users who have neither tsx nor src/ —
  every USAGE line now says `loupe …`. `usage.jsonl` moved from the package
  dir (root-owned for mac/linux global installs → a warning every run) to the
  working directory, `$LOUPE_LOG` overrides. `setup`'s no-provider help now
  lists the API-key route first. `engines` relaxed to `>=20` after checking
  the runtime surface (fetch, AbortSignal.timeout, readline/promises — all
  Node 18/20-era; nothing 24-only).
- **`--lean` parse bug (same-day fix).** `--lean` wasn't registered as a
  boolean flag, so `loupe run --lean "task"` swallowed the task as the flag's
  value and silently disabled lean. Parser extracted to `src/cli-args.ts`
  (importing cli.ts executes its entry point — untestable) + regression tests.
- **Reviewer matrix (ROADMAP #8).** `bench --reviewers "engine/model,…"`:
  advised arm per candidate vs a shared baseline control. Zero new report
  machinery — RunRecord.mode was already a free-form string, so arms are
  labeled `advised@engine/model` and aggregate/formatReport/significance all
  just work. Ends with a "Matrix pick": cheapest reviewer within ε of the
  best, or none when baseline matches them.
- **`loupe recommend`.** One command from candidates to a configured pairing:
  probe gate first (a rubber-stamp approves everything, which is both
  top-quality-by-default and nearly free — it MUST be eliminated before cost
  enters the picture), mini-bench the survivors, write the winner (or an
  honest baseline config) to loupe.config.json; `--force` to overwrite.
- **Lean A/B evidence (why lean stays opt-in).** coding pack, 3B self-pair,
  n=8/arm: advised +0.07 score at −39% tokens; but baseline/verify (protocol-
  invariant arms) moved ±0.10 — the noise floor — and self-review dropped
  −0.30, beyond noise: a weak model re-reviewing its own diff does worse.
  Default unchanged; README states the numbers.
- **Reach.** action.yml got Marketplace branding (icon search / purple);
  README got a real captured session transcript and the `recommend` pitch.

**Verified:** full suite + typecheck (count in CI), live matrix + recommend
runs on local models, lean A/B via two full bench runs + `loupe diff`.
