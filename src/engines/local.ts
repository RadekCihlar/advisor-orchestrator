// Free, local reviewer/builder engine via Ollama's HTTP API.
//
// ponytail: shape verified against Ollama's public /api/chat convention, NOT
// tested against a running instance (Ollama isn't installed on the machine
// this was built on). Confirm against `ollama --version` + a real call
// before trusting it in a benchmark run.

export interface CallResult {
  text: string;
  usage: null; // Ollama doesn't report token counts by default
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
  return { text: data.message?.content ?? '', usage: null, notionalCostUsd: null };
}
