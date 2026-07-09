import type { CallResult, DetectResult, Engine, EngineConfig } from './types.js';
import { localEngine } from './local.js';
import { claudeCodeEngine } from './claude-code.js';
import { codexEngine } from './codex.js';

export * from './types.js';

// The provider registry. Adding a new engine (e.g. a direct-API one later) is a
// single entry here — runner/, config/, and cli/ go through the interface and
// never learn concrete provider names.
const REGISTRY: Record<string, Engine> = {
  'claude-code': claudeCodeEngine,
  codex: codexEngine,
  local: localEngine,
};

export const KNOWN_ENGINES: string[] = Object.keys(REGISTRY);

export function isKnownEngine(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(REGISTRY, name);
}

export function getEngine(name: string): Engine {
  const engine = REGISTRY[name];
  if (!engine) throw new Error(`Unknown engine "${name}". Known: ${KNOWN_ENGINES.join(', ')}`);
  return engine;
}

export async function call(cfg: EngineConfig, prompt: string): Promise<CallResult> {
  return getEngine(cfg.engine).call(cfg.model, prompt);
}

// Runs every registered engine's detect() concurrently — backs `advisor providers`
// and the interactive selection prompt.
export async function detectAll(): Promise<Array<{ name: string } & DetectResult>> {
  return Promise.all(
    Object.values(REGISTRY).map(async (e) => ({ name: e.name, ...(await e.detect()) })),
  );
}
