# advisor-orchestrator

A configurable **builder + reviewer** loop for Claude models: one model does the
work, another checks in on it — how often, how much it costs, and which model
plays which role are all yours to set.

Inspired by Anthropic's [Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool),
but **not built on it**. No beta API dependency, no server-enforced
"reviewer must be smarter than builder" rule. Every consult is just our own
small, independent call to the Messages API — one engine, works for any
pairing in either direction.

> **Status: design stage.** No code yet — see [`docs/design.md`](docs/design.md)
> for the full plan (architecture, config schema, sequence diagrams, build
> order). This repo exists so the plan has a home before the first line of
> code lands.

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

## Roadmap

See [`docs/design.md` §14](docs/design.md#14-suggested-build-order-if-greenlit) for the suggested build order:
config loader → API client → single consult-cycle runner → usage tracking →
frequency policies → escalation marker → direction coverage → cost-saver
benchmark harness.

## Requirements (once built)

- Node ≥ 24
- An Anthropic Console API key with billing enabled — **not** the same thing
  as a claude.ai Pro/Max subscription; this calls the raw Messages API

## License

MIT — see [`LICENSE`](LICENSE).
