// Shared engine types. Kept separate from index.ts so engine modules can import
// them without a cycle (index.ts imports the engine objects; engines import only
// these types).

export interface EngineConfig {
  // Open string, not a union: engines are looked up in a runtime registry
  // (index.ts), so new providers (codex, future API engines) need no type edit.
  // Validated against the registry at the boundary (config.ts / cli.ts).
  engine: string;
  model: string;
}

// One result shape for every provider. Cache fields are optional because not
// every provider reports them: claude reports both, codex reports cache-read
// only, local (Ollama) reports neither.
export interface CallResult {
  text: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;     // claude cache_read / codex cached_input
    cacheCreationTokens?: number; // claude only (the cold-start tax)
  } | null;
  // The provider's own reported cost, or null when it reports none. Whether it's
  // a REAL charge is provider/auth dependent — do not assume "free".
  notionalCostUsd: number | null;
}

export interface DetectResult {
  available: boolean;
  detail: string; // human-readable status: "claude on PATH (Vertex)", "not installed", "ollama: 3 model(s)"
}

export interface Engine {
  name: string;
  detect(): Promise<DetectResult>;
  call(model: string, prompt: string): Promise<CallResult>;
  // Sensible per-role default models; empty when the provider has no universal
  // default (Ollama depends on what's pulled).
  defaultModels: { builder?: string; reviewer?: string };
}
