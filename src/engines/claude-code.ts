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
import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBin } from './spawn.js';
import type { CallResult, DetectResult, Engine } from './types.js';

const execFileAsync = promisify(execFile);

// Ambient-contamination fix (ROADMAP #2), measured live 2026-07-09: user-level
// SessionStart hooks inject their instructions as UNCACHED input tokens into
// every headless call — on this machine ~3.6k tokens/call of style rules that
// both cost real tokens and steer the builder/reviewer's prose (the exact
// contamination extractCode band-aids around). Same trivial prompt, sonnet:
//   defaults:            in=3638  cache_new=12315  cost=$0.0862
//   disableAllHooks:     in=2     cache_new=0      cost=$0.0055   (~15x)
// (Empty-cwd isolation was also tested: ~2% difference, rejected.) Passed as a
// settings FILE, not inline JSON, so the .cmd shell:true fallback can't mangle
// the quotes. Note: this kills hook-injected style; a user-configured output
// style may still leak through other channels — measure per ROADMAP #2.
const SETTINGS_PATH = join(tmpdir(), 'loupe-claude-settings.json');
writeFileSync(SETTINGS_PATH, '{"disableAllHooks": true}');

// CallResult is the shared shape in ./types.ts. claude reports the fullest
// usage of any engine: both cacheReadTokens (discounted reuse) and
// cacheCreationTokens (the one-time cold-start tax that explained the 14x
// benchmark finding). notionalCostUsd is claude -p's own figure — a REAL
// metered cost on Vertex/Bedrock, ~$0 on a Claude.ai subscription.

// Prefer a real binary spawned WITHOUT a shell, so Node's normal argv
// escaping just works. Resolution order:
// 1. CLAUDE_CODE_EXECPATH (set automatically inside a Claude Code session)
// 2. the .exe behind the npm-global shim (standalone shells don't have the
//    env var — this repo's whole point is running outside a session)
// 3. last resort: the .cmd shim, which requires shell:true — that does NOT
//    safely escape args (Node's own deprecation warning says so) and mangles
//    multi-word prompts.
function resolveClaudeBin(): { bin: string; needsShell: boolean } {
  if (process.env.CLAUDE_CODE_EXECPATH) return { bin: process.env.CLAUDE_CODE_EXECPATH, needsShell: false };
  if (process.platform === 'win32') {
    const npmExe = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
    if (existsSync(npmExe)) return { bin: npmExe, needsShell: false };
    return { bin: 'claude.cmd', needsShell: true };
  }
  return { bin: 'claude', needsShell: false };
}
const { bin: CLAUDE_BIN, needsShell: NEEDS_SHELL } = resolveClaudeBin();

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
  // runBin (not execFile) closes stdin up front — execFile's open stdin pipe
  // cost a ~3s "no stdin data" wait on EVERY call (and hangs codex outright;
  // see spawn.ts). claude writes its result JSON to stdout whether it exits 0
  // or non-zero (is_error:true for e.g. an upstream 429), so parse stdout
  // regardless of exit code — parseClaudeResult surfaces the descriptive
  // error ("claude -p error (429): Quota exceeded ...") either way.
  const { stdout, stderr, code } = await runBin(
    CLAUDE_BIN,
    // --setting-sources project,local drops the caller's USER-global settings
    // (notably the output style) so the spawned model runs vanilla. Without it,
    // an "Explanatory"-styled caller makes the builder append `★ Insight` prose
    // that pollutes benchmarks and breaks the exec grader. Deterministic fix at
    // the source — beats hoping a prompt instruction is obeyed. --settings
    // SETTINGS_PATH closes the complementary hook channel (see above) —
    // project/local hooks would still fire without it.
    ['-p', prompt, '--model', model, '--output-format', 'json', '--tools', '', '--setting-sources', 'project,local', '--settings', SETTINGS_PATH],
    NEEDS_SHELL,
  );
  try {
    return parseClaudeResult(stdout);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('claude -p error')) throw err;
    // stdout wasn't the expected JSON — a real launch/runtime failure.
    throw new Error(`claude -p failed (exit ${code}): ${(stderr || stdout || 'no output').slice(0, 400)}`);
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
