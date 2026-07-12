<p align="center">
  <img src="assets/loupe-banner.svg" alt="loupe — a closer look at what your model made" width="720">
</p>

# loupe

[![ci](https://github.com/RadekCihlar/Loupe/actions/workflows/ci.yml/badge.svg)](https://github.com/RadekCihlar/Loupe/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40cihlarr%2Floupe)](https://www.npmjs.com/package/@cihlarr/loupe)

**One model builds, another takes a closer look — and loupe measures whether that second look is actually worth it.**

"Add a reviewer model" sounds obviously good. Is it? More calls aren't free — a reviewer only earns its keep if it beats the cheaper option. loupe runs the builder → reviewer revision loop across providers (Claude, OpenAI, Codex CLI, local Ollama — any model in either role), grades every strategy on **your** tasks, and hands you a quality × cost verdict instead of vibes.

A real result it produced — weak local builder (`qwen2.5-coder:1.5b`) + `opus` reviewer, a truncation-rule coding task, n=3:

| arm | score | what happened |
|---|---|---|
| baseline (solo) | 0.00 | the weak model wrote wrong code every time |
| self-review | 0.00 | it can't catch its own bug |
| **advised** (opus reviews) | **0.67** | a stronger reviewer fixed 2 of 3 |
| verify (run the tests) | 0.33 | feeding the failing test back fixed 1 of 3 |

Review helps **when the reviewer is stronger than the builder** — self-review can't rescue a weak model, and strong models on easy tasks gain nothing from review, just added cost. loupe turns that folklore into a per-workload measurement.

## Install

```sh
npm i -g @cihlarr/loupe        # or one-off: npx @cihlarr/loupe <command>
```

Needs **Node ≥ 24** and at least one provider:

- `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` in the env — direct API, no CLI needed, works in CI and services
- Claude Code CLI (`claude login`) · OpenAI Codex CLI (`codex login`) · [Ollama](https://ollama.com) running with a pulled model

```sh
loupe providers                # shows what's usable on your machine
```

## Quickstart

```sh
loupe setup                    # pick builder + reviewer from detected providers, live-verify, save loupe.config.json
loupe run "your task"          # runs the revision loop — auto-loads loupe.config.json, no flags needed
```

`run` extras: pass `-` as the task to read it from stdin (long/multiline tasks); `--json` puts one machine-readable JSON document on stdout with the human narration on stderr. Every completed run appends a line to `usage.jsonl` — a local run history.

## Modes

- **baseline** — one pass, no reviewer (the control).
- **self-review** — the builder critiques its own output.
- **advised** — a *different* reviewer model critiques every round.
- **escalated** — cheap self-review, escalate to the bigger reviewer at most once.
- **verify** — no LLM reviewer: run the task's tests, feed failures back. Ground truth.

`self-review` is the control that isolates whether the *second model* helped vs. whether *any* extra iteration would have — so `advised` only counts if it beats `self-review`, not just `baseline`.

## Engines — any, either role, mixable

`anthropic-api` / `openai-api` (direct HTTP, key from env) · `claude-code` (Claude CLI, subscription auth) · `codex` (OpenAI Codex CLI) · `local` (Ollama, free). Cross-provider is fine: Claude builds, a local model reviews, whatever you like.

## Benchmark + verdict

```sh
loupe bench --pack coding --repeat 5 --out results.json --fail-under 0.8
loupe bench --tasks ./my-tasks.json --task my-task-id   # or your own file / one task
```

Grades every arm, prints a quality × cost table (mean ±stddev per arm, `$`/task where priceable, a warning when n is too small to conclude) + verdict, saves the full data to JSON, and — with `--fail-under` — exits non-zero if the best arm can't clear your bar.

Built-in packs: `coding` (exec-graded, multi-assertion), `reasoning`, `constraint` — all deterministic graders, each proven against a reference solution offline. Point `--tasks` at your own workload to learn which mode wins for *it*.

Graders per task:

- `includes` / `regex` — deterministic checks for known answers or hard constraints.
- `judge` — an LLM scores against a rubric (use an independent `--judge-engine` to avoid self-bias).
- `exec` — run the code against tests. Ground truth, no LLM-judge confound. Each non-empty line of `tests` is one self-contained check: score = fraction passing, and the failing lines are the feedback `verify` mode sends back to the builder. Any task with an `exec` grader also gets a **`verify`** arm.

Compare two saved runs — did a prompt/model/config change help?

```sh
loupe diff before.json after.json   # per-arm Δscore + Δtokens
```

### CI gate (GitHub Action)

This repo is also a composite action — gate PRs on a quality bar:

```yaml
- uses: RadekCihlar/Loupe@master
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  with:
    tasks: benchmark/my-tasks.json   # or pack: coding
    fail-under: '0.8'
```

Defaults to the key-based `anthropic-api` engine for both roles (CI has no provider CLIs); see [`action.yml`](action.yml) for all inputs.

## Claude Code plugin

This repo doubles as a Claude Code plugin: a SessionStart hook teaches every session to delegate write-then-judge asks ("have opus write it, let ollama judge it", "second opinion from a cheaper model") to the loupe CLI instead of hand-rolling API calls — and to report rounds, verdicts, and tokens back. `/loupe` carries the full recipe table.

```sh
claude plugin marketplace add RadekCihlar/Loupe
claude plugin install loupe@loupe
```

## Develop

```sh
git clone https://github.com/RadekCihlar/Loupe && cd Loupe
npm install
npm test                       # unit + end-to-end pipeline tests, no network
npm run typecheck
npx tsx src/cli.ts <command>   # run from source
```

## Status & honest limits

Works end-to-end, verified live: multi-provider (including live codex ↔ local ↔ claude cross-provider runs), per-assertion exec grading, the verify loop, real error handling, reproducible verdicts, 97 tests + a clean typecheck. Known limits: `judge` grading needs an independent model to avoid self-enhancement bias; under ChatGPT-subscription auth the codex CLI rejects every explicit `-m` model name, so the `codex` engine defaults to model `auto` (omits `-m`, the account picks — named models are for API-key auth); the `anthropic-api`/`openai-api` engines are parse-tested against the published response shapes but not yet run against live keys; the `$` column comes from a pricing table that drifts (`src/pricing.ts`). Current design: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) · build history: [`docs/CHANGELOG.md`](docs/CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE).
