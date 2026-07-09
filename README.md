# advisor-orchestrator

A configurable **builder + reviewer** loop for Claude models: one model does the
work, another checks in on it — how often, how much it costs, and which model
plays which role are all yours to set.

Inspired by Anthropic's [Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool),
but **not built on it**. No beta API dependency, no server-enforced
"reviewer must be smarter than builder" rule. Every consult is just our own
small, independent call to the Messages API — one engine, works for any
pairing in either direction.

> **Status: v1 built; the cost-fix work has landed — re-benchmark pending.**
> No Anthropic Console API key anywhere — two engines, both free of metered
> per-token billing: a local Ollama model, or headless Claude Code
> (`claude -p`) riding this machine's existing subscription login. The first
> real 3-task benchmark found `advised` mode cost **14x** baseline for no
> quality gain on easy tasks — root cause was a cache cold-start tax on the
> reviewer's first call, not the pattern itself. Now built in response:
> cache warm-up at `bench` startup, a new `escalated` mode that bounds the
> expensive reviewer to ≤1 call per run, and cache-token observability so the
> effect is visible; plus a JSON config loader and unit tests. The confirming
> re-benchmark is still to run. See [`docs/design.md` §16](docs/design.md#16-first-real-benchmark-the-cost-problem-it-found-and-the-fix-plan-2026-07-07)
> (root cause) and [§17](docs/design.md#17-cost-fix-work-shipped-observability-warm-up-escalated-mode-config-tests) (what shipped).

## `advisor()` vs. this repo

Claude Code ships a built-in `advisor()` tool — free, zero setup, already
does asymmetric-priced executor+advisor consults. **If you're working
interactively in Claude Code, use that. Don't use this repo for that case —
it'd be redundant.**

`advisor()` only exists *inside a live Claude Code session*, though. It can't
be called from a script, a CI job, or a background service. That's the actual
reason this repo exists: **standalone, scriptable, runnable outside Claude
Code entirely.** (An earlier draft of this doc eyed a Google Vertex AI target —
dropped once the requirement became "no metered API at all"; see
[`docs/design.md` §15](docs/design.md#15-implementation-pivot--no-metered-api-two-free-engines-superseded-24-client-details).)

## The idea

```yaml
builder:
  model: claude-sonnet-5
  effort: medium

reviewer:
  model: claude-opus-4-8
  effort: high
  max_tokens: 2048

direction: builder-to-reviewer   # or: reviewer-to-builder, peer

frequency:
  mode: every-revision           # every-revision | on-low-confidence | before-finish
  max_consults_per_run: 5

token_budget: low                # high | medium | low | saver
```

- **Bidirectional.** `builder-to-reviewer`, `reviewer-to-builder`, `peer` —
  same mechanism (two plain calls) regardless of direction. Any two model IDs,
  either role.
- **Small calls, on purpose.** `consult_context: latest-revision` (default) sends
  the reviewer just the task + the builder's latest output — cost per consult
  stays flat regardless of how long the run has been going, instead of
  resending the whole transcript every time.
- **Configurable frequency.** Review every revision, only when the builder
  flags its own uncertainty, or only before declaring the task done. (No
  "every N turns" — there's no multi-step agent loop to count turns in; the
  builder is a toolless call, not an agent. See design doc §1.)
- **Configurable cost.** `high` / `medium` / `low` token budgets, plus a
  `saver` mode that bets a cheaper builder + occasional cheap review nets a
  *lower* total cost than running the builder alone at full effort — flagged
  in the design doc as a hypothesis to validate per-workload, not a free lunch.
- **Auto-escalation.** When the builder isn't confident, it emits a marker
  that triggers an out-of-schedule review — cruder than in-band mid-generation
  triggering, but works identically in every direction.

## Why not the native Advisor tool

| Concern | Native Advisor tool | This project |
|---|---|---|
| Direction | Weaker builder → stronger reviewer **only** (server-enforced, 400s otherwise) | Any pairing, any direction |
| Context per consult | Whole transcript, automatically, every time | We choose — default is just the latest turn |
| Dependency | Anthropic beta feature, can change | Plain Messages API, no beta header |

Full reasoning: [`docs/design.md` §2](docs/design.md#2-decision-fully-custom-orchestrator-no-native-advisor-tool-adr).

## Quickstart

```sh
git clone <this repo> && cd advisor-orchestrator
npm install
npx tsx src/cli.ts setup            # detect providers, pick + verify, write advisor.config.json
npx tsx src/cli.ts run "your task"  # auto-loads advisor.config.json — no flags needed
```

`setup` checks what's usable on your machine (Claude Code / Codex / Ollama), lets
you choose the builder + reviewer, does a live test call to confirm it works, and
saves the choice. After that, `run`/`bench` pick up `advisor.config.json`
automatically. (`advisor.config.json` is git-ignored — it's your local setup.)

## Usage

```sh
# single run, four modes
npx tsx src/cli.ts run "<task>" --mode baseline                          # 1-pass, no reviewer
npx tsx src/cli.ts run "<task>" --mode self-review --consults 2          # builder critiques itself
npx tsx src/cli.ts run "<task>" --mode advised --consults 2 \
  --builder-model sonnet --reviewer-model opus                          # different reviewer, every round
npx tsx src/cli.ts run "<task>" --mode escalated --consults 3 \
  --builder-model sonnet --reviewer-model opus                          # self-review; reviewer at most once

# config file instead of flags (JSON); flags still override it
npx tsx src/cli.ts run "<task>" --config advisor.config.json

# which providers are usable on this machine
npx tsx src/cli.ts providers

# any engine in either role — claude-code, codex, or local
npx tsx src/cli.ts run "<task>" --builder-engine local --builder-model llama3.1

# cross-provider: one provider builds, another reviews (and vice versa)
npx tsx src/cli.ts run "<task>" \
  --builder-engine claude-code --builder-model sonnet \
  --reviewer-engine codex       --reviewer-model gpt-5-codex

# leave engines unset → prompts in a terminal, auto-detects a default otherwise
npx tsx src/cli.ts run "<task>"

# grade all 4 arms on the task set and print a quality×cost verdict
npx tsx src/cli.ts bench --consults 2 --repeat 3

# ...against YOUR own tasks — which mode is worth it for your workload — and
# save the full quality×cost data to JSON for later comparison
npx tsx src/cli.ts bench --tasks ./my-tasks.json --repeat 3 --out results.json

# unit tests (no engine calls) + typecheck
npm test            # tsx --test src/*.test.ts src/engines/*.test.ts
npm run typecheck   # tsc --noEmit
```

`--config` reads a JSON file with any subset of `{ builder, reviewer, mode, consults }` — only the knobs the engines actually consume today (the fuller YAML in "The idea" above is the design target, not all wired yet). Precedence: built-in defaults < config file < individual CLI flags.

**Grading & the verdict — what makes `bench` actually useful.** Each task can carry a `grader`, so `bench` scores every arm's output 0–1 and prints a **quality×cost table + verdict** (e.g. *"advised: +0.33 quality vs baseline at 5.7× its cost; self-review gets +0.25 at 2×"*). Without a quality measure you only see tokens and must eyeball quality — which is exactly how the first run mistook "14× cost for no gain" (the tasks had no headroom, so no arm *could* differ). Grader types in `tasks.json`:
- `{ "type": "includes", "must": ["391"], "caseInsensitive": true }` — fraction of required strings present.
- `{ "type": "regex", "pattern": "0\\.05|5\\s*cent", "flags": "i" }` — 1 if it matches, else 0.
- `{ "type": "judge", "rubric": "what a good answer must do" }` — an LLM scores 0–10, normalized; costs a call. Set `--judge-engine`/`--judge-model` to a model that is NOT one of the arms — otherwise judge-graded scores for those arms are self-enhancement-biased (`bench` warns you).
- `{ "type": "exec", "language": "python", "tests": "assert count_vowels('hi')==1" }` — appends `tests` to the model's code, runs it, scores 1 if it exits 0. Ground truth, no LLM-judge confound. (Runs untrusted code in a subprocess with a timeout — see the security note in `grader.ts`; for untrusted inputs at scale, run inside a container.)

Use `includes`/`regex` for known-answer or hard-constraint tasks, `judge` for open-ended quality, and `exec` for code. Any task with an `exec` grader also gets a **`verify` arm**: a builder → run-tests → fix loop with **no LLM reviewer**, where the test result is both the in-loop signal and the score. That's the pattern that most reliably beats a solo pass, and it removes the LLM-judge confound entirely.

**Why these modes.** `baseline` (1-pass) vs `advised` (N-pass + reviewer) alone can't tell you whether the *second model* helped, or whether *any* N-pass revision would've helped — that's confounded. `self-review` isolates it: same model revises against its own critique, same number of passes, no second model. `advised` only means something if it beats `self-review`, not just `baseline`. `escalated` is the cost-aware variant born from the 14x finding: self-review every round, but call the bigger reviewer at most once (the first time self-review isn't satisfied). It only means something if it keeps `advised`'s catches at closer to `self-review`'s cost. And `verify` (code tasks only) drops the LLM reviewer entirely for a programmatic test loop — ground truth, not another model's opinion, and the arm most likely to actually win.

**Known quirks (found while building, not built around):**
- No engine is truly free of overhead: `local` costs your own compute; `claude-code` rides ambient CLAUDE.md/memory/hooks context on every call (observed 3.5k–10k+ tokens on trivial prompts). Whether that's a *real* charge depends on how `claude` is authed — ~$0 on a Claude.ai subscription, but genuinely metered (with quotas) when routed through Vertex/Bedrock. Verified the hard way: on a Vertex-routed machine a benchmark run hit a real `429 RESOURCE_EXHAUSTED` quota error (now surfaced clearly instead of as a generic "Command failed").
- `--bare` looked like the fix for that (isolate each call) — it isn't: it forces API-key-only auth and breaks OAuth/subscription login entirely. Not used.
- `--tools ""` is mandatory, not optional — without it a "call" is a full agentic session with file/bash access, not a text completion. Verified live: a builder call wrote a stray file to disk unprompted; a reviewer call stalled on an unanswerable permission prompt.
- On Windows, spawning `claude` needs the real `.exe` (via `CLAUDE_CODE_EXECPATH`, set automatically inside a Claude Code session) — the `claude.cmd` shim needs `shell:true`, which does not safely escape arguments and mangles multi-word prompts.
- A failed/rate-limited call used to crash the whole `bench` run. Fixed: reviewer failure ships the builder's output without review; builder failure is caught per-arm in the `bench` loop and logged, run continues.
- Cross-model review (`advised`) cost ~14x a solo baseline pass in the one real benchmark run so far — mostly a one-time cache cold-start tax on the reviewer's first call, not per-call overhead. See [`docs/design.md` §16](docs/design.md#16-first-real-benchmark-the-cost-problem-it-found-and-the-fix-plan-2026-07-07). The fix (cache warm-up + the `escalated` mode + cache-token observability) is now built ([§17](docs/design.md#17-cost-fix-work-shipped-observability-warm-up-escalated-mode-config-tests)); the re-benchmark to confirm the new numbers has not been run yet.
- **Multi-provider:** engines are a registry (`claude-code`, `codex`, `local`); `advisor providers` shows what's detected; builder and reviewer can be different providers (Claude builds / Codex reviews, or the reverse). Direct-API (key-based) engines are a designed extension point, not yet built. The `codex` engine is coded against the documented `codex exec --json` schema but **not yet verified against an installed codex** — confirm before trusting its numbers. See [`docs/specs/2026-07-08-multi-provider-engines.md`](docs/specs/2026-07-08-multi-provider-engines.md).

## Requirements

- Node ≥ 24
- At least one provider CLI usable (check with `npx tsx src/cli.ts providers`):
  - Claude Code CLI installed + logged in (`claude /login`), or
  - OpenAI Codex CLI installed + logged in (`codex`), or
  - [Ollama](https://ollama.com) running locally with a pulled model
- No Anthropic Console API key, no separate billing setup

## License

MIT — see [`LICENSE`](LICENSE).
