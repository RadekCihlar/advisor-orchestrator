import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Mode, type RunResult } from '../runner.js';
import { call, detectAll, getEngine, isKnownEngine, KNOWN_ENGINES, type EngineConfig } from '../engines/index.js';
import { planSelection } from '../selection.js';
import { grade, type Grader } from '../grader.js';
import { aggregate, formatReport, reportJson, type RunRecord } from '../report.js';
import { estimateRunCostUsd } from '../pricing.js';
import { runPool } from '../pool.js';
import { tallyTokens } from '../usage.js';
import { armLabelFor, parseReviewerSpecs, recommendFrom } from '../matrix.js';
import { intFlag, loadConfigAuto, logRun, repoRoot, resolveDecision, roleInputFrom, runOne, type Flags } from './shared.js';

export async function cmdBench(flags: Flags): Promise<void> {
  const consults = intFlag(flags, 'consults', 2);
  const repeat = intFlag(flags, 'repeat', 1);
  const packsDir = join(repoRoot, 'benchmark', 'packs');
  if (typeof flags.pack === 'string' && typeof flags.tasks === 'string') {
    console.error('Error: pass --pack or --tasks, not both.');
    process.exit(1);
  }
  let tasksPath: string;
  if (typeof flags.pack === 'string') {
    tasksPath = join(packsDir, `${flags.pack}.json`);
    if (!existsSync(tasksPath)) {
      const available = readdirSync(packsDir).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
      console.error(`Error: unknown pack "${flags.pack}". Available: ${available.join(', ')}`);
      process.exit(1);
    }
  } else {
    tasksPath = typeof flags.tasks === 'string' ? flags.tasks : join(repoRoot, 'benchmark', 'tasks.json');
  }
  let tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; prompt: string; grader?: Grader }>;
  if (typeof flags.task === 'string') {
    tasks = tasks.filter((t) => t.id === flags.task);
    if (tasks.length === 0) {
      console.error(`Error: no task with id "${flags.task}" in ${tasksPath}`);
      process.exit(1);
    }
  }

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
  const benchBuilder = await resolveDecision(null, 'builder', plan.builder, detected);
  const benchReviewer = await resolveDecision(null, 'reviewer', plan.reviewer, detected);

  // --reviewers "engine/model,engine/model": matrix mode (ROADMAP #8) — sweep
  // reviewer candidates on the advised arm against a shared baseline control,
  // to answer "which reviewer should I buy?" instead of "is this one worth it?".
  let reviewerMatrix: EngineConfig[] | null = null;
  if (typeof flags.reviewers === 'string') {
    try {
      reviewerMatrix = parseReviewerSpecs(flags.reviewers);
    } catch (err) {
      console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    for (const c of reviewerMatrix) {
      if (!isKnownEngine(c.engine)) {
        console.error(`Error: unknown engine in --reviewers: "${c.engine}". Known: ${KNOWN_ENGINES.join(', ')}`);
        process.exit(1);
      }
    }
  }

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

  // Warm each reviewer model's cache with one throwaway call BEFORE timing any
  // arm, so the one-time cold-start tax (see claude-code.ts) lands here rather
  // than inflating task 1. Best-effort: a failed warm-up is logged, not fatal.
  for (const r of reviewerMatrix ?? [benchReviewer]) {
    console.log(`Warming ${r.engine}/${r.model} cache (throwaway call)...`);
    try {
      await call(r, 'Reply with exactly: OK');
      console.log('  warm-up done.\n');
    } catch (err) {
      console.error(`  warm-up failed (non-fatal): ${err instanceof Error ? err.message : String(err)}\n`);
    }
  }

  const baseModes: Mode[] = ['baseline', 'self-review', 'advised', 'escalated'];
  const records: RunRecord[] = [];

  // ROADMAP #10: --parallel N runs units concurrently (bounded). Default 1 =
  // sequential with today's full per-run output; N>1 switches to compact
  // tagged lines because interleaved full outputs are unreadable.
  // intFlag (not a silent Number fallback): a typo'd value must error loudly
  // like every other numeric flag, not quietly run sequentially.
  const parallel = Math.max(1, intFlag(flags, 'parallel', 1));
  const quiet = parallel > 1;
  const lean = flags.lean === true; // lean protocol: delta re-reviews + capped critiques

  interface BenchUnit {
    t: (typeof tasks)[0];
    i: number;
    mode: Mode;
    armLabel: string; // report key: the mode, or advised@engine/model in matrix runs
    reviewer: EngineConfig;
    verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>;
  }
  const units: BenchUnit[] = [];
  for (const t of tasks) {
    // The verify arm only exists where a programmatic verifier does (exec
    // grader): its verifier reruns the task's tests and feeds failures back —
    // test result as BOTH the in-loop signal and (below) the scorer.
    const verifier =
      t.grader?.type === 'exec'
        ? async (output: string) => {
            const g = await grade(t.grader!, output);
            return { passed: g.score === 1, feedback: g.detail };
          }
        : undefined;
    for (let i = 0; i < repeat; i++) {
      if (reviewerMatrix) {
        // Matrix: one shared baseline control + one advised arm per candidate.
        // self-review/escalated/verify don't vary with the reviewer choice.
        units.push({ t, i, mode: 'baseline', armLabel: 'baseline', reviewer: benchBuilder });
        for (const cand of reviewerMatrix) {
          units.push({ t, i, mode: 'advised', armLabel: armLabelFor(cand), reviewer: cand });
        }
      } else {
        const taskModes: Mode[] = t.grader?.type === 'exec' ? [...baseModes, 'verify'] : baseModes;
        for (const mode of taskModes) {
          units.push({ t, i, mode, armLabel: mode, reviewer: mode === 'self-review' ? benchBuilder : benchReviewer, verifier });
        }
      }
    }
  }
  if (quiet) {
    console.log(`--parallel ${parallel}: ${units.length} runs, compact output. Same-provider calls share rate limits — dial back if you see 429s.\n`);
  }

  await runPool(units, parallel, async ({ t, i, mode, armLabel, reviewer, verifier }) => {
    const builder = benchBuilder;
    const tag = `task=${t.id} run=${i + 1} arm=${armLabel}`;
    if (!quiet) console.log(`\n### ${tag}`);
    try {
      let result: RunResult;
      if (quiet) {
        result = await run({ task: t.prompt, builder, reviewer, consults, mode, verifier: mode === 'verify' ? verifier : undefined, lean });
        logRun(t.prompt, result, builder, reviewer, consults);
      } else {
        result = await runOne(t.prompt, mode, builder, reviewer, consults, mode === 'verify' ? verifier : undefined, false, lean);
      }
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
          console.log(quiet ? `[${tag}] grade: ${g.score.toFixed(2)} (${g.detail})` : `  grade: ${g.score.toFixed(2)} (${g.detail})`);
        } catch (err) {
          console.error(`${quiet ? `[${tag}] ` : '  '}grade failed (ungraded): ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (quiet) {
        console.log(`[${tag}] done (${result.rounds.length} round(s), no grader)`);
      }
      records.push({
        taskId: t.id,
        mode: armLabel,
        score,
        inputTokens: tally.inputTokens,
        outputTokens: tally.outputTokens,
        cacheReadTokens: tally.cacheReadTokens,
        cacheCreationTokens: tally.cacheCreationTokens,
        rounds: result.rounds.length,
        costUsd: estimateRunCostUsd(result, builder, reviewer),
      });
    } catch (err) {
      // Builder-side failure (rate limit, upstream error, ...) with no
      // output to ship for this arm — log and move to the next arm
      // instead of aborting the whole benchmark.
      console.error(`${quiet ? `[${tag}] ` : '  '}ERROR: ${err instanceof Error ? err.message : String(err)} — skipping this arm.`);
    }
  });

  const stats = aggregate(records);
  console.log('\n' + formatReport(stats));

  if (reviewerMatrix) {
    const rec = recommendFrom(stats);
    console.log(
      rec.kind === 'reviewer'
        ? `\nMatrix pick: ${rec.reviewer.engine}/${rec.reviewer.model} — cheapest reviewer within ε of the best (score ${rec.arm.meanScore?.toFixed(2)}).`
        : '\nMatrix pick: none — baseline matches every reviewer here; a reviewer does not earn its keep on these tasks.',
    );
  }

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

  // CI quality gate: fail if even the best arm can't clear the bar.
  if (typeof flags['fail-under'] === 'string') {
    const bar = Number(flags['fail-under']);
    if (!Number.isFinite(bar) || bar < 0 || bar > 1) {
      // Out-of-range bars fail silently in the worst way: >1 can never pass,
      // <0 always passes — both make the CI gate meaningless.
      console.error(`Error: --fail-under must be a number 0..1 (got "${flags['fail-under']}")`);
      process.exit(1);
    }
    const scored = stats.map((s) => s.meanScore).filter((x): x is number => x !== null);
    if (scored.length === 0) {
      console.error('Cannot apply --fail-under: no graded arms (add graders to the task file).');
      process.exit(1);
    }
    const best = Math.max(...scored);
    if (best < bar) {
      console.error(`\nFAIL: best arm mean score ${best.toFixed(2)} < --fail-under ${bar}`);
      process.exit(1);
    }
    console.log(`\nPASS: best arm mean score ${best.toFixed(2)} >= --fail-under ${bar}`);
  }
}
