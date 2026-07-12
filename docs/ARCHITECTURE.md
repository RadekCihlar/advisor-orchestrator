# loupe — Architecture (current design)

What the code does **today**. History and rationale for how it got here:
[`CHANGELOG.md`](CHANGELOG.md) (cited from code comments as "design §N").

## Purpose

One model builds, another reviews, the builder revises — and loupe **measures**
whether that second look improves quality and at what token cost, per workload.
The findings it exists to protect (from real runs): review helps only when the
reviewer is stronger than the builder; self-review can't rescue a weak model;
strong models on easy tasks gain nothing from review; running the task's tests
(`verify`) is the cheapest reliable check for code.

## Why not Anthropic's native Advisor tool (ADR)

Considered and rejected (originally design §2, preserved in CHANGELOG header
context): the beta `advisor_20260301` tool hard-enforces direction server-side
(reviewer must be ≥ builder), sends the whole transcript every consult, and is
an Anthropic-beta coupling. loupe instead makes **two plain, toolless
completions per cycle** — any model in either role, any provider, and the
reviewer sees only the task + latest output, so consult cost stays bounded.
Traded away: the native tool's mid-generation self-triggering; replaced by an
explicit uncertainty marker (`<<needs-review>>`, `src/runner.ts`) that works in
every direction.

## Module map

```
src/cli.ts               thin dispatcher: parseArgs + route to commands/*
src/commands/
  shared.ts              USAGE, flag helpers, config auto-load, interactive
                         role prompts, resolveDecision, logRun, runOne
  run.ts | bench.ts | setup.ts | providers.ts | diff.ts
src/runner.ts            the revision loop; 5 modes (below); callFn injectable
src/engines/
  types.ts               Engine interface: detect() / call() / defaultModels
  index.ts               runtime registry + retryOnce + detectAll
  claude-code.ts         headless `claude -p` (subscription auth)
  codex.ts               `codex exec --json` (JSONL parse)
  local.ts               Ollama HTTP (free)
  anthropic-api.ts       direct /v1/messages, ANTHROPIC_API_KEY
  openai-api.ts          direct /v1/chat/completions, OPENAI_API_KEY
src/selection.ts         pure engine/model resolution (flags > config > detect)
src/config.ts            loupe.config.json load + validation
src/grader.ts            includes | regex | judge | exec graders; extractCode
src/report.ts            aggregate → ArmStats; formatReport; diffReports
src/pricing.ts           per-provider $ table; estimateRunCostUsd
src/pool.ts              bounded-concurrency runner (bench --parallel)
src/usage.ts             per-run token tally + printUsage
```

Adding an engine = one file + one `REGISTRY` entry in `src/engines/index.ts`;
nothing else learns provider names.

## Modes (arms)

| Mode | Loop | What it isolates |
|---|---|---|
| `baseline` | builder, 1 pass | the floor |
| `self-review` | builder critiques its own output | "any iteration helps" vs "the second model helps" |
| `advised` | different reviewer every round | the second model's full effect |
| `escalated` | self-review each round; big reviewer at most once, on first non-approval or `<<needs-review>>` | advised-grade catches at self-review cost |
| `verify` | programmatic verifier (task's tests) as the reviewer | ground truth, no LLM opinion |

`advised` only counts if it beats `self-review`; `verify` exists only where an
`exec` grader does.

## Grading

- `includes` / `regex` — deterministic, free.
- `judge` — LLM scores 0–10 against a rubric; keep the judge independent of
  the arms (self-enhancement bias; bench warns on collision).
- `exec` — output code + task's `tests` run per-assertion (LOUPE_SCORE
  harness): score = fraction passing, failing lines become verify-mode
  feedback. `extractCode` is fence-preferred: fenced blocks are the code, no
  fences means the text is the code verbatim (prose-stripping heuristics were
  deleted once the contamination was fixed at the source — CHANGELOG §23/§24).
  Pack tasks' graders are proven against reference solutions in
  `src/packs.test.ts` offline.

## Cost accounting

Tokens are the primary, always-comparable metric. The cost proxy counts ALL
moved tokens (in + out + cacheRead + cacheCreation) because CLI engines re-read
a large ambient block per call — cacheRead scales with call count. Dollars are
derived (`src/pricing.ts`): `local` $0, `claude-code` uses its own reported
notional cost, direct-API engines use a pricing table (drift expected — treat
as data), anything unpriceable is `null`, never a silent guess. `bench` shows
mean ±stddev per arm with a small-n warning, `--fail-under` is the CI gate,
`--out` bundles are diffable with `loupe diff`.

## Contamination guarantees

The spawned `claude-code` engine runs vanilla: `--tools ""` (no agentic
toolset), `--setting-sources project,local` (drops the caller's user-global
output style), and `--settings {disableAllHooks:true}` (kills hook-injected
prose). Measured effect: in=3638 → 2 tokens on a trivial prompt
(CHANGELOG §23/§24).

## Non-goals

Pairwise only (no >2-model panels), CLI+JSON only (no GUI), builder stays a
toolless call (not an agent framework).
