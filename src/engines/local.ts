// Free, local reviewer/builder engine via Ollama's HTTP API.
//
// Verified live against a real running instance (qwen2.5:0.5b) — non-
// streaming /api/chat returns prompt_eval_count/eval_count, real token
// counts, contrary to the original assumption that Ollama reports none.

import type { CallResult, DetectResult, Engine } from './types.js';

const DEFAULT_HOST = 'http://localhost:11434';

async function callLocal(model: string, prompt: string): Promise<CallResult> {
  // Bound the call so a hung Ollama can't stall a whole benchmark indefinitely.
  const res = await fetch(`${DEFAULT_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as { message?: { content?: string }; prompt_eval_count?: number; eval_count?: number };
  return {
    text: data.message?.content ?? '',
    usage:
      typeof data.prompt_eval_count === 'number' && typeof data.eval_count === 'number'
        ? { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }
        : null,
    notionalCostUsd: null, // always free
  };
}

async function detect(host = DEFAULT_HOST): Promise<DetectResult> {
  try {
    const res = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return { available: false, detail: `ollama HTTP ${res.status}` };
    const data = (await res.json()) as { models?: unknown[] };
    const count = Array.isArray(data.models) ? data.models.length : 0;
    return { available: true, detail: `ollama: ${count} model(s)` };
  } catch {
    return { available: false, detail: 'ollama not running' };
  }
}

export const localEngine: Engine = {
  name: 'local',
  detect,
  call: callLocal,
  defaultModels: {}, // no universal default — depends on which models are pulled
};
