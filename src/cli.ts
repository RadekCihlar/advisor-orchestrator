#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run, MODES, type Mode, type RunResult } from './runner.js';
import { printUsage, tallyTokens } from './usage.js';
import { call, detectAll, getEngine, isKnownEngine, KNOWN_ENGINES, type EngineConfig } from './engines/index.js';
import { loadConfig, type AdvisorConfig } from './config.js';
import { planSelection, type RoleDecision } from './selection.js';
import { grade, type Grader } from './grader.js';
import { aggregate, formatReport, reportJson, type RunRecord } from './report.js';
import { createInterface } from 'node:readline/promises';

const here = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

// Validate a numeric flag — a bad value used to become NaN and silently run
// zero iterations ("No runs to report" with no error).
function intFlag(flags: Record<string, string | true>, name: string, def: number): number {
  const v = flags[name];
  if (v === undefined || v === true) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) {
    console.error(`Error: --${name} must be a non-negative integer (got "${v}")`);
    process.exit(1);
  }
  return n;
}

// --config wins; else auto-load ./advisor.config.json if present (written by
// `setup`) so the tool "just works" after onboarding, no flags needed.
function loadConfigAuto(flags: Record<string, string | true>): Partial<AdvisorConfig> {
  if (typeof flags.config === 'string') return loadConfig(flags.config);
  if (existsSync('advisor.config.json')) {
    console.log('Using advisor.config.json');
    return loadConfig('advisor.config.json');
  }
  return {};
}

function roleInputFrom(flags: Record<string, string | true>, prefix: string): { engine?: string; model?: string } {
  const engine = flags[`${prefix}-engine`];
  const model = flags[`${prefix}-model`];
  return {
    engine: typeof engine === 'string' ? engine : undefined,
    model: typeof model === 'string' ? model : undefined,
  };
}

async function ask(question: string, def?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(def ? `${question} [${def}]: ` : `${question}: `)).trim();
    return answer || def || '';
  } finally {
    rl.close();
  }
}

// Interactive engine/model pick for a role. Only reached in a TTY (planSelection
// returns 'prompt' only when isTTY), so blocking on stdin here is safe.
async function promptForRole(
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
    const pick = await ask(`${role} engine number`, '1');
    engine = choices[Number(pick) - 1] ?? choices[0];
  }
  const defModel = getEngine(engine).defaultModels[role];
  const model = await ask(`${role} model for ${engine}`, defModel);
  if (!model) {
    console.error(`No model given for ${role}.`);
    process.exit(1);
  }
  return { engine, model };
}

// Turn a planSelection decision into a concrete EngineConfig: use it, print a
// note for an auto-picked default, prompt in a TTY, or exit on error.
async function resolveDecision(
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
      return promptForRole(role, decision.engine, detected);
    case 'error':
      console.error(`Error: ${decision.message}`);
      process.exit(1);
    case 'mirror':
      throw new Error('internal: mirror decision must be handled by the caller');
  }
}

const USAGE = `Usage:
  tsx src/cli.ts run "<task>" [--mode baseline|self-review|advised|escalated] [--consults N]
    [--config path.json]
    [--builder-engine <name>] [--builder-model X]
    [--reviewer-engine <name>] [--reviewer-model X]
    Precedence: built-in defaults < --config file < individual CLI flags.
    Unspecified engine: prompts in a terminal; auto-detects a default otherwise.
    Cross-provider is fine (e.g. builder claude-code, reviewer codex).
    escalated: cheap self-review every round; the bigger reviewer is called at
    most once per run (first time self-review isn't satisfied).

  tsx src/cli.ts setup
    Interactive first-run: detect providers, pick + verify builder/reviewer,
    and write advisor.config.json (auto-loaded by run/bench afterward).

  tsx src/cli.ts providers
    List detected providers — which engines are usable on this machine.

  tsx src/cli.ts bench [--consults N] [--repeat N] [--tasks path.json] [--config path.json] [--out results.json]
    [--builder-engine X] [--builder-model X] [--reviewer-engine X] [--reviewer-model X]
    [--judge-engine X] [--judge-model X]   (judge scores "judge" graders; make it
                                            INDEPENDENT of the arms to avoid bias)
    Runs a task file (default benchmark/tasks.json) through all 4 arms (baseline /
    self-review / advised / escalated), grades each output against the task's
    grader, and prints a quality×cost verdict. Warms the reviewer cache first.
    Point --tasks at your own workload to learn which mode wins for it. Small n is
    directional, not statistically significant — raise --repeat for confidence.
    Task graders: { "type": "includes"|"regex"|"judge", ... } (see README).`;

async function runOne(
  task: string,
  mode: Mode,
  builder: EngineConfig,
  reviewer: EngineConfig,
  consults: number,
  verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>,
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
  console.log(label);

  const result = await run({ task, builder, reviewer, consults, mode, verifier });
  console.log('\n--- final output ---');
  console.log(result.finalOutput);
  console.log('\n--- usage ---');
  printUsage(result);
  return result;
}

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const command = positional[0];

  if (command === 'providers') {
    const results = await detectAll();
    console.log('Detected providers:');
    for (const r of results) {
      console.log(`  ${r.name.padEnd(12)} ${r.available ? '✓' : '✗'}  ${r.detail}`);
    }
    return;
  }

  if (command === 'setup') {
    const detected = await detectAll();
    console.log('Detected providers:');
    for (const r of detected) console.log(`  ${r.name.padEnd(12)} ${r.available ? '✓' : '✗'}  ${r.detail}`);
    if (!detected.some((d) => d.available)) {
      console.error('\nNo providers usable yet. Set one up, then re-run `setup`:');
      console.error('  - Claude Code CLI:  install it, then `claude login`');
      console.error('  - OpenAI Codex CLI: install it, then `codex login`');
      console.error('  - Ollama:           https://ollama.com, then `ollama pull <model>`');
      process.exit(1);
    }

    console.log('\nChoose engines (press Enter to accept the default).');
    const builder = await promptForRole('builder', undefined, detected);
    const reviewer = await promptForRole('reviewer', undefined, detected);

    // Live check — non-fatal, but tells you now if auth/quota/region is off.
    for (const [role, cfg] of [
      ['builder', builder],
      ['reviewer', reviewer],
    ] as const) {
      process.stdout.write(`Verifying ${role} ${cfg.engine}/${cfg.model} ... `);
      try {
        await call(cfg, 'Reply with exactly: OK');
        console.log('ok');
      } catch (err) {
        console.log(`could not reach it — ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const config = { builder, reviewer, mode: 'advised' as Mode, consults: 2 };
    writeFileSync('advisor.config.json', JSON.stringify(config, null, 2) + '\n');
    console.log('\nWrote advisor.config.json — run/bench auto-load it. Now just:');
    console.log('  npx tsx src/cli.ts run "your task here"');
    return;
  }

  if (command === 'run') {
    const task = positional[1];
    if (!task) {
      console.error(USAGE);
      process.exit(1);
    }

    // Precedence: built-in defaults < --config file < individual CLI flags.
    const cfg = loadConfigAuto(flags);

    const mode: Mode = typeof flags.mode === 'string' ? (flags.mode as Mode) : cfg.mode ?? 'advised';
    if (!MODES.includes(mode)) {
      console.error(`Error: unknown mode "${mode}". Known: ${MODES.join(', ')}`);
      process.exit(1);
    }
    const consults = intFlag(flags, 'consults', cfg.consults ?? 2);

    // Fail fast on an explicitly-named engine that doesn't exist.
    for (const prefix of ['builder', 'reviewer']) {
      const e = flags[`${prefix}-engine`];
      if (typeof e === 'string' && !isKnownEngine(e)) {
        console.error(`Error: unknown ${prefix} engine "${e}". Known: ${KNOWN_ENGINES.join(', ')}`);
        process.exit(1);
      }
    }

    const detected = await detectAll();
    const plan = planSelection({
      builder: roleInputFrom(flags, 'builder'),
      reviewer: roleInputFrom(flags, 'reviewer'),
      config: { builder: cfg.builder, reviewer: cfg.reviewer },
      detected,
      isTTY: Boolean(process.stdin.isTTY),
      mode,
      defaultModelFor: (engine, role) => getEngine(engine).defaultModels[role],
    });

    const builder = await resolveDecision('builder', plan.builder, detected);
    const reviewer = plan.reviewer.kind === 'mirror' ? builder : await resolveDecision('reviewer', plan.reviewer, detected);

    await runOne(task, mode, builder, reviewer, consults);
    return;
  }

  if (command === 'bench') {
    const consults = intFlag(flags, 'consults', 2);
    const repeat = intFlag(flags, 'repeat', 1);
    const tasksPath = typeof flags.tasks === 'string' ? flags.tasks : join(here, '..', 'benchmark', 'tasks.json');
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; prompt: string; grader?: Grader }>;

    console.log(
      `Running ${tasks.length} task(s) x ${repeat} repeat(s) x up to 5 arms (baseline / self-review / advised / escalated, + verify where an exec grader exists).\n` +
        `This is a directional smoke test, not a statistically meaningful benchmark.\n`,
    );

    // Resolve builder/reviewer from config + flags (bench never prompts).
    const cfg = loadConfigAuto(flags);
    for (const prefix of ['builder', 'reviewer', 'judge']) {
      const e = flags[`${prefix}-engine`];
      if (typeof e === 'string' && !isKnownEngine(e)) {
        console.error(`Error: unknown ${prefix} engine "${e}". Known: ${KNOWN_ENGINES.join(', ')}`);
        process.exit(1);
      }
    }
    const detected = await detectAll();
    const plan = planSelection({
      builder: roleInputFrom(flags, 'builder'),
      reviewer: roleInputFrom(flags, 'reviewer'),
      config: { builder: cfg.builder, reviewer: cfg.reviewer },
      detected,
      isTTY: false, // bench loops many arms — resolve, never prompt
      mode: 'advised', // resolve BOTH roles (not the self-review mirror)
      defaultModelFor: (engine, role) => getEngine(engine).defaultModels[role],
    });
    const benchBuilder = await resolveDecision('builder', plan.builder, detected);
    const benchReviewer = await resolveDecision('reviewer', plan.reviewer, detected);

    // Judge engine for `judge` graders. Defaults to the reviewer; override with
    // --judge-engine/--judge-model to make it INDEPENDENT of the arms. A judge
    // that is also an arm's builder or reviewer inflates that arm's judge-graded
    // scores (self-enhancement) — we warn below when that happens.
    const jEngine = typeof flags['judge-engine'] === 'string' ? (flags['judge-engine'] as string) : benchReviewer.engine;
    const jModel =
      typeof flags['judge-model'] === 'string'
        ? (flags['judge-model'] as string)
        : jEngine === benchReviewer.engine
          ? benchReviewer.model
          : (getEngine(jEngine).defaultModels.reviewer ?? benchReviewer.model);
    const judgeEngine: EngineConfig = { engine: jEngine, model: jModel };

    const judgeCollides =
      (judgeEngine.engine === benchBuilder.engine && judgeEngine.model === benchBuilder.model) ||
      (judgeEngine.engine === benchReviewer.engine && judgeEngine.model === benchReviewer.model);
    if (judgeCollides && tasks.some((t) => t.grader?.type === 'judge')) {
      console.warn(
        `NOTE: judge (${judgeEngine.engine}/${judgeEngine.model}) is also an arm's builder/reviewer — judge-graded scores for those arms are self-enhancement-biased. Pass --judge-engine/--judge-model for an independent judge.\n`,
      );
    }

    console.log(
      `builder=${benchBuilder.engine}/${benchBuilder.model}  reviewer=${benchReviewer.engine}/${benchReviewer.model}  judge=${judgeEngine.engine}/${judgeEngine.model}\n`,
    );

    // Warm the reviewer model's cache with one throwaway call BEFORE timing any
    // arm, so the one-time cold-start tax (see claude-code.ts) lands here rather
    // than inflating task 1. Best-effort: a failed warm-up is logged, not fatal.
    console.log(`Warming ${benchReviewer.engine}/${benchReviewer.model} cache (throwaway call)...`);
    try {
      await call(benchReviewer, 'Reply with exactly: OK');
      console.log('  warm-up done.\n');
    } catch (err) {
      console.error(`  warm-up failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
    }

    const baseModes: Mode[] = ['baseline', 'self-review', 'advised', 'escalated'];
    const records: RunRecord[] = [];
    for (const t of tasks) {
      // The verify arm only exists where a programmatic verifier does (exec
      // grader): its verifier reruns the task's tests and feeds failures back —
      // test result as BOTH the in-loop signal and (below) the scorer.
      const taskModes: Mode[] = t.grader?.type === 'exec' ? [...baseModes, 'verify'] : baseModes;
      const verifier =
        t.grader?.type === 'exec'
          ? async (output: string) => {
              const g = await grade(t.grader!, output);
              return { passed: g.score === 1, feedback: g.detail };
            }
          : undefined;
      for (let i = 0; i < repeat; i++) {
        for (const mode of taskModes) {
          const builder = benchBuilder;
          const reviewer = mode === 'self-review' ? builder : benchReviewer;
          console.log(`\n### task=${t.id} run=${i + 1} mode=${mode}`);
          try {
            const result = await runOne(t.prompt, mode, builder, reviewer, consults, mode === 'verify' ? verifier : undefined);
            const tally = tallyTokens(result);
            let score: number | null = null;
            if (t.grader) {
              try {
                // Judge graders use the resolved (ideally independent) judge
                // engine; deterministic graders ignore it. A grading failure
                // (e.g. judge rate-limited) leaves the run ungraded rather than
                // aborting the benchmark.
                const g = await grade(t.grader, result.finalOutput, { judgeEngine });
                score = g.score;
                console.log(`  grade: ${g.score.toFixed(2)} (${g.detail})`);
              } catch (err) {
                console.error(`  grade failed (ungraded): ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            records.push({
              taskId: t.id,
              mode,
              score,
              inputTokens: tally.inputTokens,
              outputTokens: tally.outputTokens,
              cacheReadTokens: tally.cacheReadTokens,
              cacheCreationTokens: tally.cacheCreationTokens,
              rounds: result.rounds.length,
            });
          } catch (err) {
            // Builder-side failure (rate limit, upstream error, ...) with no
            // output to ship for this arm — log and move to the next arm
            // instead of aborting the whole benchmark.
            console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)} — skipping this arm.`);
          }
        }
      }
    }

    const stats = aggregate(records);
    console.log('\n' + formatReport(stats));

    if (typeof flags.out === 'string') {
      const meta = {
        generatedAt: new Date().toISOString(),
        builder: `${benchBuilder.engine}/${benchBuilder.model}`,
        reviewer: `${benchReviewer.engine}/${benchReviewer.model}`,
        judge: `${judgeEngine.engine}/${judgeEngine.model}`,
        consults,
        repeat,
        tasks: tasks.length,
      };
      writeFileSync(flags.out, JSON.stringify(reportJson(meta, stats, records), null, 2));
      console.log(`\nWrote results to ${flags.out}`);
    }
    return;
  }

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
