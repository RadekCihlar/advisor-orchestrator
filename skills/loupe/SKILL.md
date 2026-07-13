---
name: loupe
description: Use when the user invokes /loupe, or asks for the full recipes of the cross-model builder+reviewer loop — which model pairing, mode, and flags to use for delegating a task to one model with another as judge.
---

# Loupe Delegation Recipes

Run a builder+reviewer loop across models via the loupe CLI. One model builds, another judges "is this done?", loop until approved. CLI lives at `${CLAUDE_PLUGIN_ROOT}/src/cli.ts`.

## Recipes

| Situation | Command core |
|---|---|
| Quality-critical, self-contained output | `--mode advised --builder-engine claude-code --builder-model opus --reviewer-engine local --reviewer-model <ollama>` |
| Boilerplate / draft / bulk text, cheap | `--mode escalated --builder-engine local --builder-model <ollama> --reviewer-engine claude-code --reviewer-model sonnet` |
| "Second opinion on this" | `--mode advised --builder-engine claude-code --builder-model sonnet --reviewer-engine claude-code --reviewer-model opus` |
| Token-frugal but checked (default) | `--mode escalated --builder-engine claude-code --builder-model opus --reviewer-engine local --reviewer-model <ollama>` |
| Code task with runnable tests | `--mode verify` via bench task with an `exec` grader — ground truth, no LLM judge |

Full form:

```sh
npx tsx "${CLAUDE_PLUGIN_ROOT}/src/cli.ts" run "<fully self-contained task>" --consults 2 <recipe flags>
```

## Rules

- Task prompt must be fully self-contained — engine calls are toolless text completions with no session context. Inline everything the builder needs.
- Pick the Ollama model from `GET http://localhost:11434/api/tags` — largest pulled model, never guess. A ≤1b model rubber-stamps; warn the user and prefer claude-code/sonnet as judge instead.
- Deliverable prints after the `--- final output ---` line; the usage block has rounds and token totals.
- Report back: rounds, judge, verdict per round, token totals — the user wants to SEE the advising.
- Never baseline mode for delegation (no judge). `--consults 3` for gnarly tasks.
- `escalated` calls the bigger reviewer at most once per run. `setup` writes `loupe.config.json` (auto-loaded) if the user wants standing defaults.
- Add `--lean` on multi-round advised runs to cut re-review tokens (round ≥1 sends the judge its prior critique + a diff instead of the full output). Skip it for self-review pairings — measured worse there.
- Unsure which judge? `recommend --reviewers "codex/auto,local/<ollama>"` probe-gates candidates and writes the cheapest trustworthy pick to loupe.config.json.

## Checklist

Task self-contained · recipe picked, not defaulted blindly · Ollama model checked via /api/tags · verdicts and tokens reported back.
