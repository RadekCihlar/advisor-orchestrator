// Helpers shared by the command modules (cleaner-list split of cli.ts).
// cli.ts is now only flag parsing + dispatch; each command lives in its own
// file and pulls what it needs from here.

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { findEvidence, formatPriors, validateEvidence, type EvidenceEntry } from '../evidence.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run, type Mode, type RunResult } from '../runner.js';
import { printUsage, tallyTokens } from '../usage.js';
import { getEngine, type EngineConfig } from '../engines/index.js';
import { loadConfig, type AdvisorConfig } from '../config.js';
import type { RoleDecision } from '../selection.js';
import type { Interface } from 'node:readline/promises';

export type Flags = Record<string, string | true>;

// src/commands → src → repo root. Same depth after the dist build
// (dist/commands → dist → root), so packaged paths keep resolving.
export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Usage history goes to the working directory (or $LOUPE_LOG), NOT the package
// dir: a global npm install's package dir is buried in node_modules and often
// not writable (root-owned on mac/linux) — every run would warn.
const LOG_PATH = process.env.LOUPE_LOG ?? join(process.cwd(), 'usage.jsonl');

export const USAGE = `Usage:
  loupe run "<task>" [--mode baseline|self-review|advised|escalated] [--consults N]
    [--json] [--lean] [--config path.json]
    "<task>" may be - to read the task from stdin (long/multiline tasks).
    --json: stdout carries one machine-readable JSON document (result, rounds,
    usage); human progress goes to stderr. Every completed run appends one
    line to usage.jsonl (working directory; override with $LOUPE_LOG).
    [--builder-engine <name>] [--builder-model X]
    [--reviewer-engine <name>] [--reviewer-model X]
    Precedence: built-in defaults < --config file < individual CLI flags.
    Unspecified engine: prompts in a terminal; auto-detects a default otherwise.
    Cross-provider is fine (e.g. builder claude-code, reviewer codex).
    escalated: cheap self-review every round; the bigger reviewer is called at
    most once per run (first time self-review isn't satisfied).
    --lean: cheaper re-reviews — round ≥1 sends the reviewer its own prior
    critique + a line-diff of the revision instead of the full output, and
    caps runaway critiques. Round 0 and verify-mode feedback are untouched.
    A/B it: bench --out fat.json, bench --lean --out lean.json, then diff.

  loupe setup
    Interactive first-run: detect providers, pick + verify builder/reviewer,
    and write loupe.config.json (auto-loaded by run/bench afterward).

  loupe providers
    List detected providers — which engines are usable on this machine.

  loupe bench [--consults N] [--repeat N] [--tasks path.json] [--config path.json]
    [--pack coding|reasoning|constraint|hard] [--task <id>] [--parallel N] [--lean]
    --parallel N runs N units at once (compact tagged output; same-provider
    calls share rate limits). Default 1 = sequential, full per-run output.
    --pack <name> runs benchmark/packs/<name>.json; --task <id> runs one task.
    [--out results.json] [--fail-under 0.8]  (exit non-zero if best arm < bar — a CI gate)
    [--until-clear] [--max-repeat N]  keep adding repeats while the top two
    arms are statistically inseparable (paired per task); stop when clear
    or at --max-repeat (default 10).
    [--baseline last.json]  drift watch: compare against a saved --out bundle
    (paired per task) and exit non-zero on a significant regression — a
    cron/CI alarm for silently-updated models.
    [--builder-engine X] [--builder-model X] [--reviewer-engine X] [--reviewer-model X]
    [--judge-engine X] [--judge-model X]   (judge scores "judge" graders; make it
                                            INDEPENDENT of the arms to avoid bias)
    [--reviewers "engine/model,engine/model"]  Matrix mode: sweep reviewer
    candidates on the advised arm against a shared baseline control and pick
    the cheapest reviewer within ε of the best — "which reviewer should I buy?".
    Runs a task file (default benchmark/tasks.json) through all 4 arms (baseline /
    self-review / advised / escalated), grades each output against the task's
    grader, and prints a quality×cost verdict. Warms the reviewer cache first.
    Point --tasks at your own workload to learn which mode wins for it. Small n is
    directional, not statistically significant — raise --repeat for confidence.
    Task graders: { "type": "includes"|"regex"|"judge", ... } (see README).

  loupe probe [--reviewer-engine X] [--reviewer-model X] [--probe file.json]
    Measure a reviewer's defect catch rate BEFORE trusting it in advised runs:
    feeds it known-defective + known-correct outputs (benchmark/probe.json by
    default, through the exact prompt real runs use) and reports catch rate,
    false-alarm rate, and a verdict. A rubber-stamp reviewer (approves planted
    defects) is worse than no reviewer — it launders broken output.

  loupe recommend --reviewers "engine/model,engine/model" [--pack coding] [--repeat N]
    [--builder-engine X] [--builder-model X] [--force]
    One command from candidates to a configured pairing: probe-gate the
    candidates (rubber-stamps eliminated), mini-bench the survivors against a
    baseline control, and write the cheapest trustworthy reviewer within ε of
    the best to loupe.config.json — or report that no reviewer earns its keep.
    --force overwrites an existing loupe.config.json.

  loupe tasks from-repo [dir] [--out mined-tasks.json]
    Mine the repo's own tests into an exec-graded task pack — the benchmark
    becomes literally your workload, zero authoring. v1 lifts assertions with
    literal arguments on one exported function (assert.equal/deepEqual/ok/
    throws, expect().toBe/.toEqual); fixture-based tests are skipped and
    reported. REVIEW the output before benching.

  loupe stats [--json]
    Local run history from usage.jsonl (working dir, or $LOUPE_LOG): runs,
    tokens, est. $, per-pairing rounds/approval/flag rates, last run.
    --json: one stable JSON document — statusline/script material.

  loupe mcp
    Serve loupe as an MCP server on stdio (tools: loupe_run, loupe_probe,
    loupe_recommend, loupe_stats) — Cursor, Codex CLI, Claude Code/Desktop,
    or any MCP client. Setup snippets: docs/INTEGRATIONS.md.

  loupe diff a.json b.json
    Compare two \`bench --out\` result files per arm — did my prompt/model/config
    change help? Shows score and total-token movement A → B.`;

// Validate a numeric flag — a bad value used to become NaN and silently run
// zero iterations ("No runs to report" with no error).
export function intFlag(flags: Flags, name: string, def: number): number {
  const v = flags[name];
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Error: --${name} must be a non-negative integer (got "${v}")`);
    process.exit(1);
  }
  return n;
}

// --config wins; else auto-load ./loupe.config.json if present (written by
// `setup`) so the tool "just works" after onboarding, no flags needed.
export function loadConfigAuto(flags: Flags): Partial<AdvisorConfig> {
  if (typeof flags.config === 'string') return loadConfig(flags.config);
  if (existsSync('loupe.config.json')) {
    console.error('Using loupe.config.json'); // stderr: --json keeps stdout machine-pure
    return loadConfig('loupe.config.json');
  }
  return {};
}

export function roleInputFrom(flags: Flags, prefix: string): { engine?: string; model?: string } {
  const engine = flags[`${prefix}-engine`];
  const model = flags[`${prefix}-model`];
  return {
    engine: typeof engine === 'string' ? engine : undefined,
    model: typeof model === 'string' ? model : undefined,
  };
}

// One readline interface is reused for every question (a fresh one per question
// drops buffered/piped input on the 2nd prompt). Caller owns create + close.
export async function ask(rl: Interface, question: string, def?: string): Promise<string> {
  const answer = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
  return answer || def || '';
}

// Interactive engine/model pick for a role, using the shared readline interface.
export async function promptForRole(
  rl: Interface,
  role: 'builder' | 'reviewer',
  knownEngine: string | undefined,
  detected: Array<{ name: string; available: boolean }>,
): Promise<EngineConfig> {
  let engine = knownEngine;
  if (!engine) {
    const available = detected.filter((d) => d.available).map((d) => d.name);
    const choices = available.length > 0 ? available : detected.map((d) => d.name);
    console.log(`Select ${role} engine:`);
    choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    const pick = await ask(rl, `${role} engine number`, '1');
    engine = choices[Number(pick) - 1] ?? choices[0];
  }
  const defModel = getEngine(engine).defaultModels[role];
  const model = await ask(rl, `${role} model for ${engine}`, defModel);
  if (!model) {
    console.error(`No model given for ${role}.`);
    process.exit(1);
  }
  return { engine, model };
}

// Turn a planSelection decision into a concrete EngineConfig: use it, print a
// note for an auto-picked default, prompt in a TTY, or exit on error.
export async function resolveDecision(
  rl: Interface | null,
  role: 'builder' | 'reviewer',
  decision: RoleDecision,
  detected: Array<{ name: string; available: boolean }>,
): Promise<EngineConfig> {
  switch (decision.kind) {
    case 'fixed':
      return decision.config;
    case 'default':
      console.log(
        `Auto-selected ${role}: ${decision.config.engine}/${decision.config.model} (override with --${role}-engine / --${role}-model).`,
      );
      return decision.config;
    case 'prompt':
      return promptForRole(rl!, role, decision.engine, detected);
    case 'error':
      console.error(`Error: ${decision.message}`);
      process.exit(1);
    case 'mirror':
      throw new Error('internal: mirror decision must be handled by the caller');
  }
}

// Evidence priors (#21): shipped, curated pairing findings consulted before
// spending tokens. Tolerant load — a missing/broken file means no priors,
// never a crash. Priors inform; runs decide.
export function loadEvidence(): EvidenceEntry[] {
  try {
    return validateEvidence(JSON.parse(readFileSync(join(repoRoot, 'benchmark', 'evidence.json'), 'utf8')));
  } catch {
    return [];
  }
}

export function printPriors(entries: EvidenceEntry[], role: EvidenceEntry['role'], cfg: EngineConfig): void {
  const hits = findEvidence(entries, role, cfg);
  for (const line of formatPriors(hits, cfg)) console.log(line);
  if (hits.length > 0) console.log('  (priors inform — this run decides)');
}

// One appended line per completed run (bench arms included) — a local usage
// history. Never fatal: a log write failure must not eat a successful run.
export function logRun(task: string, result: RunResult, builder: EngineConfig, reviewer: EngineConfig, consults: number): void {
  const t = tallyTokens(result);
  const line = {
    ts: new Date().toISOString(),
    task: task.length > 80 ? `${task.slice(0, 80)}…` : task,
    mode: result.mode,
    builder: `${builder.engine}/${builder.model}`,
    reviewer: result.mode === 'baseline' ? null : `${reviewer.engine}/${reviewer.model}`,
    consults,
    rounds: result.rounds.length,
    approvedEarly: result.rounds.at(-1)?.approved ?? false,
    flagged: result.rounds.some((r) => r.flagged),
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cacheReadTokens: t.cacheReadTokens,
    cacheCreationTokens: t.cacheCreationTokens,
    notionalCostUsd: t.notionalCost,
  };
  try {
    appendFileSync(LOG_PATH, `${JSON.stringify(line)}\n`);
  } catch (err) {
    console.error(`  · usage log write failed (${err instanceof Error ? err.message : String(err)})`);
  }
}

export async function runOne(
  task: string,
  mode: Mode,
  builder: EngineConfig,
  reviewer: EngineConfig,
  consults: number,
  verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>,
  json = false,
  lean = false,
): Promise<RunResult> {
  const builderLabel = `builder: ${builder.engine}/${builder.model}`;
  const label =
    mode === 'baseline'
      ? `${builderLabel} (solo, 1 pass, no reviewer)`
      : mode === 'verify'
        ? `${builderLabel} -- verify: programmatic tests as the reviewer (no LLM reviewer)`
        : mode === 'escalated'
          ? `${builderLabel} -- escalation reviewer: ${reviewer.engine}/${reviewer.model} [self-review each round, escalates at most once]`
          : `${builderLabel} -- reviewer: ${reviewer.engine}/${reviewer.model}` +
            (reviewer.engine === builder.engine && reviewer.model === builder.model ? ' [same model — self-review]' : '');
  // in --json mode stdout carries ONLY the JSON document; humans read stderr
  (json ? console.error : console.log)(label);

  const result = await run({ task, builder, reviewer, consults, mode, verifier, lean });
  logRun(task, result, builder, reviewer, consults);
  if (json) {
    console.log(JSON.stringify({ ...result, usage: tallyTokens(result) }));
    return result;
  }
  console.log('\n--- final output ---');
  console.log(result.finalOutput);
  console.log('\n--- usage ---');
  printUsage(result, builder, reviewer);
  return result;
}
