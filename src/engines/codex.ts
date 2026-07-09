// OpenAI Codex CLI engine, via headless `codex exec`. Authes over HTTPS through
// codex's own login (ChatGPT subscription) or OPENAI_API_KEY — no key stored by
// us. Mirrors the claude-code engine's shape.
//
// Flags (from the Codex CLI docs, 2026-07):
//   exec                 non-interactive subcommand
//   --json               newline-delimited JSON (JSONL) event stream on stdout
//   -m <model>           model override
//   -s read-only         read-only sandbox — prevents file writes (codex's
//                        analog of claude's `--tools ""`; it defaults to
//                        read-only but we set it explicitly)
//   -a never             never pause for approval (required for headless)
//   --skip-git-repo-check allow running outside a git repo
//   --ephemeral          don't persist session files
//
// NEEDS LIVE VERIFICATION: codex is not installed on the machine this was
// written on, and CLI event schemas drift. Before trusting benchmark numbers,
// run one real `codex exec --json` and confirm the event/field names parsed
// below (item.completed/agent_message, turn.completed.usage) still match. The
// parser is exported and unit-tested against captured-shape fixtures.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CallResult, DetectResult, Engine } from './types.js';

const execFileAsync = promisify(execFile);

// ponytail: bare name resolves via PATH. If Windows shim issues surface (as they
// did for claude.cmd), mirror claude-code.ts's CLAUDE_CODE_EXECPATH handling.
const CODEX_BIN = 'codex';

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
  try {
    const { stdout } = await execFileAsync(
      CODEX_BIN,
      ['exec', '--json', '-m', model, '-s', 'read-only', '-a', 'never', '--skip-git-repo-check', '--ephemeral', prompt],
      { maxBuffer: 10 * 1024 * 1024 },
    );
    return parseCodexOutput(stdout);
  } catch (err) {
    // Like claude, codex may exit non-zero yet still stream events to stdout;
    // re-parse to surface the real reason instead of "Command failed".
    const out = (err as { stdout?: string }).stdout;
    if (out) {
      try {
        return parseCodexOutput(out);
      } catch (parsed) {
        if (parsed instanceof Error && parsed.message.startsWith('codex exec error')) throw parsed;
      }
    }
    throw err;
  }
}

async function detect(): Promise<DetectResult> {
  try {
    await execFileAsync(CODEX_BIN, ['--version']);
    return { available: true, detail: 'codex on PATH' };
  } catch {
    return { available: false, detail: 'not installed' };
  }
}

export const codexEngine: Engine = {
  name: 'codex',
  detect,
  call: callCodex,
  defaultModels: { builder: 'gpt-5-codex', reviewer: 'gpt-5-codex' }, // version-dependent constant
};
