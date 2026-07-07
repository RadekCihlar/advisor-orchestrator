# advisor-orchestrator

A configurable **builder + reviewer** loop for Claude models: one model does the
work, another checks in on it — how often, how much it costs, and which model
plays which role are all yours to set.

Inspired by Anthropic's [Advisor tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/advisor-tool),
but generalized past its one hard limit: the official tool only lets a
*weaker* model consult a *stronger* one. This project adds the reverse and
peer-review directions on top, via a second execution engine, behind the same
config file.

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
  mode: on-checkpoint            # every-turn | every-n-turns | on-checkpoint |
                                  # on-low-confidence | before-finish
  max_consults_per_run: 5

token_budget: low                # high | medium | low | saver
```

- **Bidirectional.** `builder-to-reviewer` (cheap model builds, strong model
  reviews) runs on Anthropic's native Advisor tool directly. `reviewer-to-builder`
  and `peer` (any other pairing or direction) run on a hand-rolled two-call
  orchestrator, since the native tool structurally can't do those directions.
- **Configurable frequency.** Check in every turn, every N turns, only at
  checkpoints, only when the builder flags its own uncertainty, or only
  before declaring the task done.
- **Configurable cost.** `high` / `medium` / `low` token budgets, plus a
  `saver` mode that bets a cheaper builder + occasional cheap review nets a
  *lower* total cost than running the builder alone at full effort — flagged
  in the design doc as a hypothesis to validate per-workload, not a free lunch.
- **Auto-escalation.** When the builder isn't confident, it can trigger a
  review itself rather than waiting for a scheduled check-in.

## Why two engines

| | Native (Anthropic Advisor tool) | Custom orchestrator |
|---|---|---|
| Direction | Weaker builder → stronger reviewer **only** (server-enforced) | Any pairing, any direction |
| Mechanism | One `/v1/messages` call, reviewer runs server-side mid-generation | Two independent calls, orchestrated client-side |
| "Ask when unsure" | Built in — the builder decides | Hand-rolled marker + policy engine |
| Maturity | Anthropic-maintained (beta) | Ours to maintain |

Full comparison and reasoning: [`docs/design.md` §2](docs/design.md#2-decision-hybrid-of-native-advisor-tool--custom-orchestrator-adr).

## Roadmap

See [`docs/design.md` §15](docs/design.md#15-suggested-build-order-if-greenlit) for the suggested build order:
config loader → API client → native-path runner → usage tracking → custom-path
runner → frequency policies → escalation marker → cost-saver benchmark harness.

## Requirements (once built)

- Node ≥ 24
- An Anthropic Console API key with billing enabled — **not** the same thing
  as a claude.ai Pro/Max subscription; this calls the raw Messages API

## License

MIT — see [`LICENSE`](LICENSE).
