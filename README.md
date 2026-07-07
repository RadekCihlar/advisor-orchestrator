# advisor-orchestrator

A configurable **builder + reviewer** loop for Claude models: one model does the
work, another checks in on it — how often, how much it costs, and which model
plays which role are all yours to set.

Inspired by Anthropic's [Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool),
but **not built on it**. No beta API dependency, no server-enforced
"reviewer must be smarter than builder" rule. Every consult is just our own
small, independent call to the Messages API — one engine, works for any
pairing in either direction.

> **Status: v1 built, benchmarked once.** No Anthropic Console API key
> anywhere — two engines, both free of metered per-token billing: a local
> Ollama model, or headless Claude Code (`claude -p`) riding this machine's
> existing subscription login. First real 3-task benchmark found `advised`
> mode costs **14x** baseline for no quality gain on easy tasks — root cause
> is a cache cold-start tax on the reviewer's first call, not the pattern
> itself. Fix planned, not yet built. See [`docs/design.md` §16](docs/design.md#16-first-real-benchmark-the-cost-problem-it-found-and-the-fix-plan-2026-07-07)
> for the full write-up and next steps.

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

## Usage

```sh
# single run, three modes
npx tsx src/cli.ts run "<task>" --mode baseline                          # 1-pass, no reviewer
npx tsx src/cli.ts run "<task>" --mode self-review --consults 2          # builder critiques itself
npx tsx src/cli.ts run "<task>" --mode advised --consults 2 \
  --builder-model sonnet --reviewer-model opus                          # different reviewer model

# both engines work in either role
npx tsx src/cli.ts run "<task>" --builder-engine local --builder-model llama3.1

# benchmark/tasks.json through all 3 arms — directional smoke test, not
# statistically meaningful at this sample size
npx tsx src/cli.ts bench --consults 2 --repeat 1
```

**Why three modes, not two.** `baseline` (1-pass) vs `advised` (N-pass + reviewer) alone can't tell you whether the *second model* helped, or whether *any* N-pass revision would've helped — that's confounded. `self-review` isolates it: same model revises against its own critique, same number of passes, no second model. `advised` only means something if it beats `self-review`, not just `baseline`.

**Known quirks (found while building, not built around):**
- Neither engine is truly free of overhead: `local` costs your own compute; `claude-code` rides this session's ambient CLAUDE.md/memory/hooks context on every call (observed 3.5k–10k+ tokens on trivial prompts) — subscription-covered, not billed separately, but real usage against your subscription's rate limits.
- `--bare` looked like the fix for that (isolate each call) — it isn't: it forces API-key-only auth and breaks OAuth/subscription login entirely. Not used.
- `--tools ""` is mandatory, not optional — without it a "call" is a full agentic session with file/bash access, not a text completion. Verified live: a builder call wrote a stray file to disk unprompted; a reviewer call stalled on an unanswerable permission prompt.
- On Windows, spawning `claude` needs the real `.exe` (via `CLAUDE_CODE_EXECPATH`, set automatically inside a Claude Code session) — the `claude.cmd` shim needs `shell:true`, which does not safely escape arguments and mangles multi-word prompts.
- A failed/rate-limited call used to crash the whole `bench` run. Fixed: reviewer failure ships the builder's output without review; builder failure is caught per-arm in the `bench` loop and logged, run continues.
- Cross-model review (`advised`) costs ~14x a solo baseline pass in the one real benchmark run so far — mostly a one-time cache cold-start tax on the reviewer's first call, not per-call overhead. See [`docs/design.md` §16](docs/design.md#16-first-real-benchmark-the-cost-problem-it-found-and-the-fix-plan-2026-07-07) — fix (cache warm-up + escalation) is planned, not yet built.

## Requirements

- Node ≥ 24
- Either: [Ollama](https://ollama.com) running locally with a pulled model, or Claude Code CLI installed + logged in (`claude /login`) on the machine running this
- No Anthropic Console API key, no separate billing setup

## License

MIT — see [`LICENSE`](LICENSE).
