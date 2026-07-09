<p align="center">
  <img src="assets/loupe-banner.svg" alt="loupe — a closer look at what your model made" width="720">
</p>

# loupe

**A builder + reviewer loop for LLMs — and a harness that tells you whether the review is actually worth it.**

One model does the work; another takes a closer look. loupe runs that loop across providers (Claude, Codex, local Ollama), with any model in either role, and — the part that matters — **measures** whether the second look improves quality, and at what token cost. More calls aren't free; a reviewer only earns its keep if it beats the cheaper option.

> Not the built-in `advisor()` tool. loupe is standalone and scriptable — run it from a script, a CI job, or against your own task set. ([why not the native tool](docs/design.md#2-decision-fully-custom-orchestrator-no-native-advisor-tool-adr))

## Why loupe

"Add a reviewer model" sounds obviously good. Is it? loupe answers that **for your tasks**, with a quality×cost verdict instead of vibes. A real result it produced — weak local builder (`qwen2.5-coder:1.5b`) + `opus` reviewer, a truncation-rule coding task, n=3:

| arm | score | what happened |
|---|---|---|
| baseline (solo) | 0.00 | the weak model wrote wrong code every time |
| self-review | 0.00 | it can't catch its own bug |
| **advised** (opus reviews) | **0.67** | a stronger reviewer fixed 2 of 3 |
| verify (run the tests) | 0.33 | feeding the failing test back fixed 1 of 3 |

Review helps **when the reviewer is stronger than the builder** — and self-review or one-shot escalation don't. (On tasks a strong model already nails, every review mode ties at "no gain, higher cost" — also worth knowing before you pay for it.) That's the call loupe makes measurable.

## Quickstart

```sh
git clone <this repo> && cd loupe
npm install
npx tsx src/cli.ts setup            # detect providers, pick + verify, write loupe.config.json
npx tsx src/cli.ts run "your task"  # auto-loads loupe.config.json — no flags needed
```

`setup` finds what's usable (Claude Code / Codex / Ollama), lets you pick the builder + reviewer, does a live test call to confirm, and saves it. After that, `run` and `bench` just work.

## Modes

- **baseline** — one pass, no reviewer (the control).
- **self-review** — the builder critiques its own output.
- **advised** — a *different* reviewer model critiques every round.
- **escalated** — cheap self-review, escalate to the bigger reviewer at most once.
- **verify** — no LLM reviewer: run the task's tests, feed failures back. Ground truth.

`self-review` is the control that isolates whether the *second model* helped vs. whether *any* extra iteration would have — so `advised` only counts if it beats `self-review`, not just `baseline`.

## Engines — any, either role, mixable

`claude-code` (Claude CLI) · `codex` (OpenAI Codex CLI) · `local` (Ollama). Cross-provider is fine: Claude builds, Codex reviews, whatever you like. `npx tsx src/cli.ts providers` shows what's usable on your machine.

## Benchmark + verdict

```sh
npx tsx src/cli.ts bench --tasks ./my-tasks.json --repeat 5 --out results.json --fail-under 0.8
```

Grades every arm, prints a quality×cost table + verdict, saves the full data to JSON, and — with `--fail-under` — exits non-zero if the best arm can't clear your bar (a CI quality gate).

Graders per task:

- `includes` / `regex` — deterministic checks for known answers or hard constraints.
- `judge` — an LLM scores against a rubric (use an independent `--judge-engine` to avoid self-bias).
- `exec` — run the code against tests. Ground truth, no LLM-judge confound. Any task with an `exec` grader also gets a **`verify`** arm.

## Develop

```sh
npm test            # unit tests, no network
npm run typecheck   # tsc --noEmit
```

## Requirements

- Node ≥ 24
- At least one provider (check with `npx tsx src/cli.ts providers`):
  - Claude Code CLI — installed + `claude login`
  - OpenAI Codex CLI — installed + `codex login`
  - [Ollama](https://ollama.com) — running, with a pulled model

## Status & honest limits

Works end-to-end, verified live: multi-provider, exec grading, the verify loop, real error handling, reproducible verdicts, 49 unit tests + a clean typecheck. Known limits: `judge` grading needs an independent model to avoid self-enhancement bias; the `codex` engine is written to the published spec but not yet run against an installed codex; direct-API (key-based) engines are a designed extension point, not built. Full design + build history: [`docs/design.md`](docs/design.md).

## License

MIT — see [LICENSE](LICENSE).
