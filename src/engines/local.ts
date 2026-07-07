// Free, local reviewer/builder engine via Ollama's HTTP API.
//
// Verified live against a real running instance (qwen2.5:0.5b) — non-
// streaming /api/chat returns prompt_eval_count/eval_count, real token
// counts, contrary to the original assumption that Ollama reports none.

export interface CallResult {
  text: string;
  usage: { inputTokens: number; outputTokens: number } | null;
  notionalCostUsd: null; // always free
}

export async function callLocal(
  model: string,
  prompt: string,
  host = 'http://localhost:11434',
): Promise<CallResult> {
  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`Ollama ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return {
    text: data.message?.content ?? '',
    usage:
      typeof data.prompt_eval_count === 'number' && typeof data.eval_count === 'number'
        ? { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count }
        : null,
    notionalCostUsd: null,
  };
}
