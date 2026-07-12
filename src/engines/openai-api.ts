// Direct OpenAI Chat Completions engine (ROADMAP #5) — key-based, no CLI.
// Raw fetch, no SDK, same zero-runtime-deps reasoning as anthropic-api.ts.
// Secrets: reads OPENAI_API_KEY from env only — never stored or logged.

import type { CallResult, DetectResult, Engine } from './types.js';

const API_URL = 'https://api.openai.com/v1/chat/completions';

// Turns a 200 /v1/chat/completions body into a CallResult. cached_tokens is a
// discounted subset of prompt_tokens (maps to cacheReadTokens); OpenAI has no
// cache-creation analog. Exported for unit testing without network.
export function parseOpenAIResponse(data: {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}): CallResult {
  const cached = data.usage?.prompt_tokens_details?.cached_tokens;
  return {
    text: data.choices?.[0]?.message?.content ?? '',
    usage: data.usage
      ? {
          inputTokens: data.usage.prompt_tokens ?? 0,
          outputTokens: data.usage.completion_tokens ?? 0,
          ...(typeof cached === 'number' ? { cacheReadTokens: cached } : {}),
        }
      : null,
    notionalCostUsd: null,
  };
}

async function callOpenAI(model: string, prompt: string): Promise<CallResult> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY not set');
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(600_000),
  });
  if (!res.ok) {
    throw new Error(`openai-api ${res.status}: ${await res.text()}`);
  }
  return parseOpenAIResponse((await res.json()) as Parameters<typeof parseOpenAIResponse>[0]);
}

async function detect(): Promise<DetectResult> {
  return process.env.OPENAI_API_KEY
    ? { available: true, detail: 'OPENAI_API_KEY set' }
    : { available: false, detail: 'OPENAI_API_KEY not set' };
}

export const openaiApiEngine: Engine = {
  name: 'openai-api',
  detect,
  call: callOpenAI,
  defaultModels: { builder: 'gpt-5.1', reviewer: 'gpt-5.1' }, // version-dependent constant
};
