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
//
// --tools "" is mandatory, not optional: without it, a "call" is a full
// agentic session with file/bash access, not a text completion. Verified
// live: without --tools "", a builder call actually wrote a file to disk
// unprompted, and a reviewer call stalled on an unresolvable permission
// prompt ("needs approval, waiting on you") since headless mode can't
// answer interactive dialogs. --allowedTools ""/--disallowedTools with an
// explicit tool-name list both failed to fully block this (empty
// --allowedTools still let Write through; --disallowedTools missed
// PowerShell, a tool name distinct from Bash on this platform). --tools ""
// is the one flag documented to disable the entire toolset outright.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CallResult, DetectResult, Engine } from './types.js';

const execFileAsync = promisify(execFile);

// CallResult is the shared shape in ./types.ts. claude reports the fullest
// usage of any engine: both cacheReadTokens (discounted reuse) and
// cacheCreationTokens (the one-time cold-start tax that explained the 14x
// benchmark finding). notionalCostUsd is claude -p's own figure — a REAL
// metered cost on Vertex/Bedrock, ~$0 on a Claude.ai subscription.

// Prefer the real binary via CLAUDE_CODE_EXECPATH (set when running inside a
// Claude Code session) — spawning it directly needs no shell, so Node's
// normal argv escaping just works. Fallback (claude.cmd on Windows) requires
// shell:true, which does NOT safely escape args (Node's own deprecation
// warning says so) — multi-word prompts get mangled under that path. Prefer
// the env var whenever it's present.
const CLAUDE_BIN = process.env.CLAUDE_CODE_EXECPATH || (process.platform === 'win32' ? 'claude.cmd' : 'claude');
const NEEDS_SHELL = process.platform === 'win32' && CLAUDE_BIN.toLowerCase().endsWith('.cmd');

// Turns claude -p's JSON stdout into a CallResult, or throws a DESCRIPTIVE
// error when the payload reports failure. claude writes this same JSON to
// stdout whether it exits 0 (is_error:false) or non-zero (is_error:true — e.g.
// an upstream 429 quota error), so both the normal path and the execFile-
// rejection path below route through here. That keeps the real cause (quota,
// auth, bad model) visible instead of collapsing into execFile's generic
// "Command failed: claude -p ...", which is what hid a Vertex 429 during a
// benchmark run. Exported for unit testing without spawning a process.
export function parseClaudeResult(stdout: string): CallResult {
  const data = JSON.parse(stdout);
  if (data.is_error) {
    const status = data.api_error_status ? ` (${data.api_error_status})` : '';
    throw new Error(`claude -p error${status}: ${data.result ?? 'unknown error'}`);
  }
  return {
    text: data.result ?? '',
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
        }
      : null,
    notionalCostUsd: data.total_cost_usd ?? null,
  };
}

export async function callClaudeCode(model: string, prompt: string): Promise<CallResult> {
  try {
    const { stdout } = await execFileAsync(
      CLAUDE_BIN,
      ['-p', prompt, '--model', model, '--output-format', 'json', '--tools', ''],
      // ponytail: execFile leaves stdin open, so headless mode prints a ~3s
      // "no stdin data" warning then proceeds. Truly closing stdin needs
      // spawn + stdin.end(); not worth the rewrite for a cosmetic warning.
      { maxBuffer: 10 * 1024 * 1024, shell: NEEDS_SHELL },
    );
    return parseClaudeResult(stdout);
  } catch (err) {
    // On an API error claude exits non-zero, so execFile rejects — but it has
    // already written the error JSON to stdout. Re-parse it so the caller sees
    // e.g. "claude -p error (429): Quota exceeded ..." instead of the generic
    // "Command failed". Fall back to the original error if stdout isn't the
    // expected JSON (a real spawn failure: ENOENT, etc).
    const out = (err as { stdout?: string }).stdout;
    if (out) {
      try {
        return parseClaudeResult(out);
      } catch (parsed) {
        if (parsed instanceof Error && parsed.message.startsWith('claude -p error')) throw parsed;
      }
    }
    throw err;
  }
}

async function detect(): Promise<DetectResult> {
  try {
    await execFileAsync(CLAUDE_BIN, ['--version'], { shell: NEEDS_SHELL });
    const via = process.env.CLAUDE_CODE_USE_VERTEX
      ? ' (Vertex)'
      : process.env.CLAUDE_CODE_USE_BEDROCK
        ? ' (Bedrock)'
        : '';
    return { available: true, detail: `claude on PATH${via}` };
  } catch {
    return { available: false, detail: 'claude not installed' };
  }
}

export const claudeCodeEngine: Engine = {
  name: 'claude-code',
  detect,
  call: callClaudeCode,
  defaultModels: { builder: 'sonnet', reviewer: 'opus' },
};
