import type { EngineConfig } from './engines/index.js';
import type { Mode } from './runner.js';

// Pure engine-selection resolver. Decides, per role, what to DO — without any
// I/O — so cli.ts stays a thin shell (detect + prompt) around a fully testable
// core. Precedence: CLI flags > config file > interactive prompt (TTY) >
// auto-detected default.

export interface RoleInput {
  engine?: string;
  model?: string;
}

export type RoleDecision =
  | { kind: 'fixed'; config: EngineConfig } // fully specified by flag/config
  | { kind: 'default'; config: EngineConfig } // non-TTY auto-pick; cli should print it
  | { kind: 'prompt'; engine?: string } // TTY: ask user (engine set → only model missing)
  | { kind: 'mirror' } // reviewer mirrors builder (self-review, or unused in baseline)
  | { kind: 'error'; message: string };

export interface SelectionInput {
  builder: RoleInput; // from CLI flags
  reviewer: RoleInput; // from CLI flags
  config?: { builder?: EngineConfig; reviewer?: EngineConfig };
  detected: Array<{ name: string; available: boolean }>;
  isTTY: boolean;
  mode: Mode;
  // Injected (rather than importing the registry) to keep this module pure and
  // trivially testable.
  defaultModelFor: (engine: string, role: 'builder' | 'reviewer') => string | undefined;
}

export interface SelectionPlan {
  builder: RoleDecision;
  reviewer: RoleDecision;
}

// First available engine, preferring claude-code, else first detected-available.
function preferredAvailable(detected: Array<{ name: string; available: boolean }>): string | undefined {
  const available = detected.filter((d) => d.available).map((d) => d.name);
  if (available.length === 0) return undefined;
  return available.includes('claude-code') ? 'claude-code' : available[0];
}

function planRole(
  role: 'builder' | 'reviewer',
  input: SelectionInput,
  roleInput: RoleInput,
  roleConfig: EngineConfig | undefined,
): RoleDecision {
  const engine = roleInput.engine ?? roleConfig?.engine;
  let model = roleInput.model ?? roleConfig?.model;
  // A flag can override the engine while the model comes only from config — but
  // that config model belongs to a DIFFERENT engine, so discard it and fall back
  // to the chosen engine's default (e.g. `--builder-engine codex` with a config
  // of {claude-code, sonnet} must not run codex with model "sonnet").
  if (
    roleInput.engine !== undefined &&
    roleInput.model === undefined &&
    roleConfig?.model !== undefined &&
    roleConfig.engine !== roleInput.engine
  ) {
    model = undefined;
  }

  if (!engine) {
    // No engine chosen anywhere.
    if (input.isTTY) return { kind: 'prompt' };
    const def = preferredAvailable(input.detected);
    if (!def) {
      return { kind: 'error', message: `no engine available — none detected. Install one or pass --${role}-engine.` };
    }
    const m = model ?? input.defaultModelFor(def, role);
    if (!m) return { kind: 'error', message: `engine "${def}" has no default model — pass --${role}-model.` };
    return { kind: 'default', config: { engine: def, model: m } };
  }

  // Engine known (explicit); availability is trusted — a user naming an engine
  // overrides detection (which can false-negative), and a bad call surfaces its
  // own error later.
  const m = model ?? input.defaultModelFor(engine, role);
  if (!m) {
    if (input.isTTY) return { kind: 'prompt', engine };
    return { kind: 'error', message: `engine "${engine}" needs a model — pass --${role}-model.` };
  }
  return { kind: 'fixed', config: { engine, model: m } };
}

export function planSelection(input: SelectionInput): SelectionPlan {
  const builder = planRole('builder', input, input.builder, input.config?.builder);
  // baseline ignores the reviewer entirely; self-review reuses the builder.
  const reviewer: RoleDecision =
    input.mode === 'self-review' || input.mode === 'baseline'
      ? { kind: 'mirror' }
      : planRole('reviewer', input, input.reviewer, input.config?.reviewer);
  return { builder, reviewer };
}
