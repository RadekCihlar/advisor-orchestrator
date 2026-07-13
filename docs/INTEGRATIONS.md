# Using loupe from your agent, editor, or statusline

loupe is a CLI first — anything that can run a command can use it. On top of
that it speaks **MCP** (`loupe mcp`, stdio), so every MCP-capable client gets
the builder+reviewer loop as native tools with zero glue code.

The machine running loupe still needs at least one provider: an API key in
the env, a logged-in CLI (`claude` / `codex`), or Ollama with a pulled model.
`loupe providers` shows what's usable.

## MCP — one server, every client

`loupe mcp` serves four tools over stdio:

- **loupe_run** — delegate a self-contained task: one model builds, another
  reviews each round until approved. Returns final output, per-round
  verdicts, token usage (JSON).
- **loupe_probe** — measure a reviewer's defect catch rate before trusting
  it (rubber-stamp detection).
- **loupe_recommend** — probe-gate candidate reviewers, mini-bench the
  survivors, write the cheapest trustworthy pick to `loupe.config.json`.
- **loupe_stats** — local run history: runs, tokens, $, per-pairing rates.

### Claude Code

```sh
claude mcp add loupe -- npx -y @cihlarr/loupe mcp
```

(Or install the [plugin](../README.md#claude-code-plugin) instead — it adds a
delegation hook + `/loupe` recipes on top of the same CLI.)

### Codex CLI

```sh
codex mcp add loupe -- npx -y @cihlarr/loupe mcp
```

or in `~/.codex/config.toml`:

```toml
[mcp_servers.loupe]
command = "npx"
args = ["-y", "@cihlarr/loupe", "mcp"]
```

### Cursor

`~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (per-project):

```json
{
  "mcpServers": {
    "loupe": { "command": "npx", "args": ["-y", "@cihlarr/loupe", "mcp"] }
  }
}
```

### Claude Desktop

`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "loupe": { "command": "npx", "args": ["-y", "@cihlarr/loupe", "mcp"] }
  }
}
```

### Any other MCP client

Stdio transport, command `npx -y @cihlarr/loupe mcp` (or `loupe mcp` if
installed globally). Newline-delimited JSON-RPC; protocol `2024-11-05`.

## No MCP? Plain CLI contract

For agents that only run shell commands, paste this into your agent
instructions (AGENTS.md, .cursorrules, system prompt):

```text
To delegate a task to one model with another model reviewing it, run:
  loupe run "<fully self-contained task>" --json
The task must contain ALL context (these are toolless completions). stdout is
one JSON document: { finalOutput, rounds[], usage }. Each round has the
reviewer's verdict — report rounds and verdicts back to the user.
Useful flags: --mode advised|escalated, --builder-engine/-model,
--reviewer-engine/-model (engines: claude-code, codex, local, anthropic-api,
openai-api), --consults N, --lean. `loupe providers` lists what's available;
never guess an Ollama model name — check http://localhost:11434/api/tags.
```

## Statusline / scripts

`loupe stats --json` prints one stable JSON document (reads `usage.jsonl`
from the working directory, or `$LOUPE_LOG`):

```json
{ "runs": 115, "totalTokens": 534027, "totalCostUsd": 1.11, "pricedRuns": 115,
  "pairings": [ { "pairing": "local/qwen2.5:3B → codex/auto [advised]",
                  "runs": 3, "meanRounds": 2.7, "approvedEarlyRate": 0.33,
                  "flaggedRate": 0, "totalTokens": 121566 } ],
  "last": { "ts": "…", "mode": "advised", "builder": "…", "reviewer": "…", "rounds": 2 } }
```

Statusline one-liners:

```sh
# jq
loupe stats --json | jq -r '"🔍 \(.runs) runs · \(.totalTokens) tok · $\(.totalCostUsd // 0)"'

# node (no jq)
loupe stats --json | node -e "const s=JSON.parse(require('fs').readFileSync(0));console.log(\`🔍 \${s.runs} runs · \${s.totalTokens} tok\`)"
```

`last` is statusline gold: show `last.mode` + `last.rounds` to see at a
glance whether your most recent delegation needed the reviewer.

## Ollama

The `local` engine talks to Ollama at `localhost:11434` — a free builder or
reviewer for any of the above. Two cautions, both measured live: models ≤1b
tend to **rubber-stamp** as reviewers (run `loupe probe` first — approving
broken code is worse than no review), and a reviewer weaker than the builder
actively subtracts quality. `loupe recommend` automates exactly this check.
