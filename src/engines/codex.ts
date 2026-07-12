// OpenAI Codex CLI engine, via headless `codex exec`. Authes over HTTPS through
// codex's own login (ChatGPT subscription) or OPENAI_API_KEY — no key stored by
// us. Mirrors the claude-code engine's shape.
//
// Flags (verified against codex-cli 0.144.1, 2026-07-12):
//   exec                 non-interactive subcommand
//   --json               newline-delimited JSON (JSONL) event stream on stdout
//   -m <model>           model override
//   -s read-only         read-only sandbox — prevents file writes (codex's
//                        analog of claude's `--tools ""`; it defaults to
//                        read-only but we set it explicitly)
//   --skip-git-repo-check allow running outside a git repo
//   --ephemeral          don't persist session files
//   --ignore-user-config don't load ~/.codex/config.toml (auth still works) —
//                        codex's analog of claude's --setting-sources: user
//                        config must not skew benchmark arms
// (`-a never` was removed upstream — exec no longer takes an approval flag.)
//
// LIVE-VERIFIED 2026-07-12 (ChatGPT-subscription auth): any explicit `-m`
// value — including the exact model name from the user's own config.toml
// default — gets "Model metadata for `X` not found... fallback metadata" then
// a 400 "not supported when using Codex with a ChatGPT account." Omitting -m
// entirely works (server picks the account's default). Root cause is in
// codex-cli's local model-metadata table, not this code. Model 'auto' is the
// escape hatch: skip -m and let codex choose. Real model names presumably
// still work under OPENAI_API_KEY auth (untested here) — kept as an option.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { runBin } from './spawn.js';
import type { CallResult, DetectResult, Engine } from './types.js';

const execFileAsync = promisify(execFile);

// Windows npm installs `codex` as a .cmd shim, which spawn() can't launch bare
// (ENOENT — found live, design §28). Same story as claude.cmd: prefer the real
// .exe the npm package vendors so argv escaping works without a shell; fall
// back to the .cmd shim with shell:true (which mangles multi-word prompts —
// last resort only).
function resolveCodexBin(): { bin: string; needsShell: boolean } {
  if (process.platform === 'win32') {
    const npmExe = join(
      process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex',
      'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe',
    );
    if (existsSync(npmExe)) return { bin: npmExe, needsShell: false };
    return { bin: 'codex.cmd', needsShell: true };
  }
  return { bin: 'codex', needsShell: false };
}
const { bin: CODEX_BIN, needsShell: NEEDS_SHELL } = resolveCodexBin();

// Parse codex exec's JSONL event stream into a CallResult, or throw a
// descriptive error on a failure event. Exported for unit testing.
export function parseCodexOutput(stdout: string): CallResult {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  let text = '';
  let usage: CallResult['usage'] = null;

  for (const line of lines) {
    let ev: {
      type?: string;
      item?: { type?: string; text?: string };
      usage?: { input_tokens?: number; cached_input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number };
      error?: { message?: string };
      message?: string;
    };
    try {
      ev = JSON.parse(line);
    } catch {
      continue; // ignore any non-JSON progress line
    }

    if (ev.type === 'turn.failed' || ev.type === 'error') {
      throw new Error(`codex exec error: ${ev.error?.message ?? ev.message ?? line}`);
    }
    if (ev.type === 'item.completed' && ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') {
      text = ev.item.text; // keep the last agent message
    }
    if (ev.type === 'turn.completed' && ev.usage) {
      // Sum across turns (a multi-turn exec emits several turn.completed events);
      // reasoning tokens are billed as output, so fold them in.
      const u: NonNullable<CallResult['usage']> = usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
      usage = {
        inputTokens: u.inputTokens + (ev.usage.input_tokens ?? 0),
        outputTokens: u.outputTokens + (ev.usage.output_tokens ?? 0) + (ev.usage.reasoning_output_tokens ?? 0),
        cacheReadTokens: (u.cacheReadTokens ?? 0) + (ev.usage.cached_input_tokens ?? 0),
      };
    }
  }

  return { text, usage, notionalCostUsd: null };
}

async function callCodex(model: string, prompt: string): Promise<CallResult> {
  const modelArgs = model === 'auto' ? [] : ['-m', model];
  // runBin (not execFile): codex blocks forever on an open stdin pipe — see
  // spawn.ts. codex may also exit non-zero yet still have streamed events to
  // stdout (a turn.failed/error event) — parseCodexOutput surfaces that real
  // reason regardless of exit code, so the code itself doesn't need branching.
  const { stdout } = await runBin(
    CODEX_BIN,
    ['exec', '--json', ...modelArgs, '-s', 'read-only', '--skip-git-repo-check', '--ephemeral', '--ignore-user-config', prompt],
    NEEDS_SHELL,
  );
  return parseCodexOutput(stdout);
}

async function detect(): Promise<DetectResult> {
  try {
    await execFileAsync(CODEX_BIN, ['--version'], { shell: NEEDS_SHELL });
    return { available: true, detail: 'codex on PATH' };
  } catch {
    return { available: false, detail: 'not installed' };
  }
}

export const codexEngine: Engine = {
  name: 'codex',
  detect,
  call: callCodex,
  defaultModels: { builder: 'auto', reviewer: 'auto' }, // 'auto' skips -m; see live-verified note above
};
