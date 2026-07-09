import { readFileSync } from 'node:fs';
import { isKnownEngine, KNOWN_ENGINES, type EngineConfig } from './engines/index.js';
import { MODES, type Mode } from './runner.js';

// Config file support, JSON + hand-rolled validation, zero deps.
//
// Deliberately covers ONLY the knobs the runner/engines actually consume today
// (builder, reviewer, mode, consults). The design doc's §5 lists many more
// (effort, token_budget, direction, frequency, consult_context, escalation
// marker, caching) — none are wired into the engines yet, so accepting them
// here would be config for values nothing reads. Add each field when the
// feature behind it exists, not before.
export interface AdvisorConfig {
  builder: EngineConfig;
  reviewer: EngineConfig;
  mode: Mode;
  consults: number;
}

function fail(msg: string): never {
  throw new Error(`Invalid config: ${msg}`);
}

function validateEngine(v: unknown, where: string): EngineConfig {
  if (typeof v !== 'object' || v === null) fail(`${where} must be an object`);
  const o = v as Record<string, unknown>;
  if (typeof o.engine !== 'string' || !isKnownEngine(o.engine)) {
    fail(`${where}.engine must be one of ${KNOWN_ENGINES.join(' | ')}`);
  }
  if (typeof o.model !== 'string' || o.model.length === 0) fail(`${where}.model must be a non-empty string`);
  return { engine: o.engine as EngineConfig['engine'], model: o.model };
}

// Returns only the fields present in the file, each validated. The caller
// (cli.ts) layers precedence: defaults < config file < CLI flags.
export function loadConfig(path: string): Partial<AdvisorConfig> {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`could not read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof raw !== 'object' || raw === null) fail('top level must be a JSON object');
  const o = raw as Record<string, unknown>;

  const out: Partial<AdvisorConfig> = {};

  if (o.builder !== undefined) out.builder = validateEngine(o.builder, 'builder');
  if (o.reviewer !== undefined) out.reviewer = validateEngine(o.reviewer, 'reviewer');

  if (o.mode !== undefined) {
    if (!MODES.includes(o.mode as Mode)) fail(`mode must be one of ${MODES.join(' | ')}`);
    out.mode = o.mode as Mode;
  }

  if (o.consults !== undefined) {
    if (typeof o.consults !== 'number' || !Number.isInteger(o.consults) || o.consults < 0) {
      fail('consults must be a non-negative integer');
    }
    out.consults = o.consults;
  }

  return out;
}
