// Direct Anthropic Messages API engine (ROADMAP #5) — key-based, no CLI, so
// loupe runs in CI/services. Raw fetch, no SDK: this repo ships zero runtime
// deps and the call is one POST (same reasoning as local.ts / Ollama).
// Secrets: reads ANTHROPIC_API_KEY from env only — never stored or logged.

import type { CallResult, DetectResult, Engine } from './types.js';

const API_URL = 'https://api.anthropic.com/v1/messages';

// Turns a 200 /v1/messages body into a CallResult. Content is a block array;
// join the text blocks (thinking blocks etc. are not deliverable output).
// Exported for unit testing without network.
export function parseAnthropicResponse(data: {
  content?: Array<{ type?: string; text?: string; [extra: string]: unknown }>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}): CallResult {
  const text = (data.content ?? [])
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
  return {
    text,
    usage: data.usage
      ? {
          inputTokens: data.usage.input_tokens ?? 0,
          outputTokens: data.usage.output_tokens ?? 0,
          cacheReadTokens: data.usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: data.usage.cache_creation_input_tokens ?? 0,
        }
      : null,
    notionalCostUsd: null, // the API reports tokens, not dollars (ROADMAP #13)
  };
}

async function callAnthropic(model: string, prompt: string): Promise<CallResult> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      max_tokens: 16000, // non-streaming ceiling before HTTP-timeout territory
      messages: [{ role: 'user', content: prompt }],
    }),
    // Opus-tier calls on hard tasks can run minutes; match the SDK's 10-min default.
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    throw new Error(`anthropic-api ${res.status}: ${await res.text()}`);
  }
  return parseAnthropicResponse((await res.json()) as Parameters<typeof parseAnthropicResponse>[0]);
}

async function detect(): Promise<DetectResult> {
  return process.env.ANTHROPIC_API_KEY
    ? { available: true, detail: 'ANTHROPIC_API_KEY set' }
    : { available: false, detail: 'ANTHROPIC_API_KEY not set' };
}

export const anthropicApiEngine: Engine = {
  name: 'anthropic-api',
  detect,
  call: callAnthropic,
  // Cheap builder / strong reviewer — API-model equivalents of claude-code's
  // sonnet/opus pairing.
  defaultModels: { builder: 'claude-sonnet-5', reviewer: 'claude-opus-4-8' },
};
