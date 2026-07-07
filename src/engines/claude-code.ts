// Reviewer/builder engine via headless Claude Code (`claude -p`) — rides
// this machine's existing Claude Code subscription auth. No Anthropic
// Console API key, no separate metered billing.
//
// NOT using --bare: verified live that --bare forces API-key-only auth
// ("OAuth and keychain are never read" per `claude --help`) — it breaks the
// exact subscription auth this engine exists for. Trade-off accepted: each
// call loads ambient CLAUDE.md/memory context (observed ~52k cache-read
// tokens on a trivial prompt), which is real overhead but doesn't cost real
// money on a subscription plan.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface CallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | null;
  // What this call would cost at metered API rates. NOT an actual separate
  // charge — real cost is this session's Claude subscription usage.
  notionalCostUsd: number | null;
}

// Prefer the real binary via CLAUDE_CODE_EXECPATH (set when running inside a
// Claude Code session) — spawning it directly needs no shell, so Node's
// normal argv escaping just works. Fallback (claude.cmd on Windows) requires
// shell:true, which does NOT safely escape args (Node's own deprecation
// warning says so) — multi-word prompts get mangled under that path. Prefer
// the env var whenever it's present.
const CLAUDE_BIN = process.env.CLAUDE_CODE_EXECPATH || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
const NEEDS_SHELL = process.platform === 'win32' && CLAUDE_BIN.toLowerCase().endsWith('.cmd');

export async function callClaudeCode(model: string, prompt: string): Promise<CallResult> {
  const { stdout } = await execFileAsync(
    CLAUDE_BIN,
    ['-p', prompt, '--model', model, '--output-format', 'json'],
    {
      maxBuffer: 10 * 1024 * 1024,
      shell: NEEDS_SHELL,
      // avoid the ~3s "no stdin data" wait headless mode does when stdin
      // isn't explicitly closed
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const data = JSON.parse(stdout);
  if (data.is_error) {
    throw new Error(`claude -p error: ${data.result ?? 'unknown'}`);
  }

  return {
    text: data.result ?? '',
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
        }
      : null,
    notionalCostUsd: data.total_cost_usd ?? null,
  };
}
