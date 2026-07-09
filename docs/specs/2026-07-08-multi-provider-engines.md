# Multi-Provider Engines — Design Spec (2026-07-08)

## Goal

Make `advisor-orchestrator` work across model providers, not just ambient Claude
Code:

- **Any provider** — Anthropic (`claude`), OpenAI (`codex`), local (Ollama), and
  an interface that lets more drop in later.
- **Auto-detect + override** — detect which providers are usable on the machine;
  when a role's engine isn't specified, prompt for it interactively (TTY) or fall
  back to a default (non-TTY); flags/config always override.
- **Cross-provider pairing** — builder on provider A, reviewer on provider B, and
  vice versa (e.g. Claude builds / Codex reviews).
- **CLI/subscription now, API later** — use each provider's own CLI, which authes
  over HTTPS via its existing subscription/login (no API keys in our code). Add
  direct-API (key-based) engines later **without touching the runner**.

## Non-goals (this feature)

- Not building direct-API engines yet — only the extension point for them.
- No model-alias translation layer — per-engine default constants only; users
  pass provider-native model names.
- No interactive TUI — a thin stdlib `readline` prompt only.
- No >2-provider council; still pairwise.
- No cross-provider `bench` arms yet (possible later; out of scope here).

## Current state (baseline this builds on)

- `runner.run()` is engine-agnostic and takes independent `builder`/`reviewer`
  `EngineConfig`s → **cross-provider pairing is nearly free**.
- Engines today: `local` (Ollama HTTP), `claude-code` (spawn `claude -p`),
  dispatched by a `call()` switch in `src/engines/index.ts`.
- This session already added: `escalated` mode, JSON config loader
  (`{builder, reviewer, mode, consults}`), cache-token observability, and
  `parseClaudeResult` (surfaces real upstream errors like the Vertex 429).
- **Machine reality:** only `claude` is installed (Vertex-routed, currently
  429-quota'd). No `codex`, no Ollama, no API keys. So codex/local/API paths get
  fixture tests + a live-verify note — they can't be exercised end-to-end here.

## Architecture

### Engine interface (the Hybrid backbone)

```ts
export interface DetectResult {
  available: boolean;
  detail: string;      // "claude on PATH (Vertex)" | "not installed" | "ollama: 3 models"
  models?: string[];   // when enumerable (Ollama)
}

export interface Engine {
  name: string;                                        // 'claude-code' | 'codex' | 'local'
  detect(): Promise<DetectResult>;
  call(model: string, prompt: string): Promise<CallResult>;
  defaultModels: { builder?: string; reviewer?: string };
}
```

### Unified `CallResult` (replaces today's union)

```ts
export interface CallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;     // claude cache_read / codex cached_input
    cacheCreationTokens?: number; // claude only
  } | null;
  notionalCostUsd: number | null; // claude reports it; codex/local → null
  engine: string;                 // which engine produced this (useful in cross-provider runs)
}
```

Optional cache fields let one shape cover every provider. `usage.ts` already
narrows cache fields with `in`, so it simplifies rather than breaks.

### Registry + dispatch

```ts
const REGISTRY: Record<string, Engine> = {
  'claude-code': claudeCodeEngine,
  codex: codexEngine,
  local: localEngine,
};
export function getEngine(name: string): Engine { /* throw on unknown */ }
export async function call(cfg: EngineConfig, prompt: string): Promise<CallResult> {
  return getEngine(cfg.engine).call(cfg.model, prompt);
}
```

Adding an API engine later = one entry here. `runner`/`config` never change.

## Engines

### `claude-code` (refactor existing)

Wrap current `callClaudeCode` + `parseClaudeResult` behind `Engine` (keeps the
429-surfacing fix). `detect`: `command -v claude`, note Vertex if
`CLAUDE_CODE_USE_VERTEX`. `defaultModels: { builder: 'sonnet', reviewer: 'opus' }`.

### `codex` (new)

Command (grounded in the OpenAI Codex CLI docs, 2026-07):

```
codex exec --json -m <model> -s read-only -a never --skip-git-repo-check --ephemeral "<prompt>"
```

- `-s read-only` + `-a never` prevent it acting as an agent (Codex analog of
  claude's `--tools ""`); `--skip-git-repo-check` runs outside a repo;
  `--ephemeral` avoids persisted session files (stateless calls).
- Parse stdout **JSONL** (one JSON event per line):
  - **final text** = the `item.completed` event carrying an `agent_message` item
    → its `text`. Fallback: pass `--output-last-message <tmpfile>` and read it.
  - **usage** = `turn.completed` event's `usage` → `inputTokens=input_tokens`,
    `outputTokens=output_tokens`, `cacheReadTokens=cached_input_tokens`
    (`reasoning_output_tokens` folded into output or noted separately).
  - **error** = `turn.failed` / `error` event → throw
    `Error("codex exec error: <message>")` (mirrors `parseClaudeResult`).
- `notionalCostUsd: null` (Codex CLI reports no cost).
- `detect`: `command -v codex`. `defaultModels: { builder: 'gpt-5-codex',
  reviewer: 'gpt-5-codex' }` — **version-dependent constant**.
- **NEEDS LIVE VERIFICATION** at implementation: exact event field names and the
  final-message extraction, against the installed Codex version (not installed on
  this machine; CLI schemas drift).

### `local` (Ollama, refactor existing)

Wrap `callLocal`. `detect`: `GET http://localhost:11434/api/tags` (200 →
available, list models). No universal default model (depends on what's pulled) →
`defaultModels` empty; model must be specified.

### API engines (extension point — NOT built)

Documented only: `anthropic-api` (`POST /v1/messages`, `ANTHROPIC_API_KEY`),
`openai-api` (`POST /v1/responses`, `OPENAI_API_KEY`). `detect` via key-env
presence. **Secrets via env only, never stored/logged.** Added when a keyed
workload actually needs them.

## Detection + `providers` command

`advisor providers` runs every registry engine's `detect()` and prints a table:

```
claude-code  ✓  claude on PATH (Vertex)
codex        ✗  not installed
local        ✗  ollama not running
```

## Selection UX (auto-detect + prompt)

Precedence, resolved **per role**: **flags > config file > interactive prompt
(TTY) > default**.

- If a role's engine is unspecified:
  - `process.stdin.isTTY` → `readline` (stdlib) lists detected providers, user
    picks engine (+ model, defaulting to `engine.defaultModels[role]`).
  - non-TTY (CI/pipe) → default = first **available** engine (prefer
    `claude-code`); print the chosen pairing.
- `self-review` mode: reviewer := builder (no reviewer prompt).
- **Pure resolver** `resolveSelection({ flags, config, detected, isTTY, mode })`
  → `{ builder, reviewer }` or `{ needsPrompt: [...] }`. All decision logic here,
  unit-testable with zero I/O; the `readline` layer is a thin shell around it.

## Config schema extension

`config.json` already carries `builder`/`reviewer` `{ engine, model }`. Extend the
validated `engine` enum to include `codex` (and future API names). No structural
change to the loader.

## Cross-provider pairing

Free via independent role configs:

```sh
advisor run "task" --builder-engine claude-code --builder-model sonnet \
                   --reviewer-engine codex       --reviewer-model gpt-5-codex
# and the reverse: codex builds, claude reviews
```

## Error handling

Each engine's `call` throws a descriptive `Error` on upstream failure (the
`parseClaudeResult` pattern; codex `turn.failed`/`error` maps the same way).
`runner` behavior is unchanged: reviewer error → ship builder output without
review; builder error → propagate to the `bench` per-arm catch.

## Testing

- `resolveSelection`: flags override config; config fallback; TTY→`needsPrompt`;
  non-TTY→default; `self-review` skips reviewer prompt; unknown engine errors.
- `codex` parser: fixture JSONL (success w/ usage; `turn.failed`) → asserts
  text/usage/throw.
- `claude-code` parser: existing tests stay.
- `detect()`: kept thin; light/mocked checks only.
- **No end-to-end multi-provider test possible here** (only claude present, and
  it's 429'd) — call this out in the PR/handoff.

## Build order

1. Unify `CallResult`; add `Engine` interface + registry; refactor `claude-code`
   and `local` behind it — **no behavior change**, existing tests stay green.
2. `resolveSelection` pure resolver + tests.
3. Detection + `providers` command.
4. Interactive `readline` prompt in `cli`; non-TTY default.
5. `codex` engine + fixture tests.
6. Wire `codex` into registry + config enum + README/design docs.
7. (later) API engines.

## Risks / caveats

- **Codex unverified live** — not installed here; fixture-tested only. Verify the
  event schema + flags at implementation against the installed version.
- **Vertex 429** currently blocks live `claude` runs — orthogonal to this
  feature, but it means no live smoke test until quota resets / another provider
  is installed.
- **Version drift** — codex default model (`gpt-5-codex`) and JSONL event names
  can change; isolate them as constants.
