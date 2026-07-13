import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run, type Mode } from '../runner.js';
import { detectAll, getEngine, isKnownEngine, KNOWN_ENGINES, type EngineConfig } from '../engines/index.js';
import { planSelection } from '../selection.js';
import { grade, type Grader } from '../grader.js';
import { aggregate, formatReport, type RunRecord } from '../report.js';
import { estimateRunCostUsd } from '../pricing.js';
import { tallyTokens } from '../usage.js';
import { probeReviewer, validateProbeItems } from '../probe.js';
import { armLabelFor, parseReviewerSpecs, recommendFrom } from '../matrix.js';
import { intFlag, loadConfigAuto, repoRoot, resolveDecision, roleInputFrom, type Flags } from './shared.js';

// `loupe recommend` (ROADMAP #8's UX face): one command from candidates to a
// configured pairing. Probe gates the candidates (a rubber-stamp reviewer must
// never win on cost), a mini-bench scores the survivors against a baseline
// control, and the cheapest reviewer within ε of the best is written to
// loupe.config.json — or, honestly, "no reviewer earns its keep here".
export async function cmdRecommend(flags: Flags): Promise<void> {
  if (typeof flags.reviewers !== 'string') {
    console.error('Error: recommend needs candidates, e.g.');
    console.error('  loupe recommend --reviewers "codex/auto,local/qwen2.5:3B" [--pack coding] [--repeat 2]');
    process.exit(1);
  }
  let candidates: EngineConfig[];
  try {
    candidates = parseReviewerSpecs(flags.reviewers);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  for (const c of candidates) {
    if (!isKnownEngine(c.engine)) {
      console.error(`Error: unknown engine in --reviewers: "${c.engine}". Known: ${KNOWN_ENGINES.join(', ')}`);
      process.exit(1);
    }
  }

  const consults = intFlag(flags, 'consults', 2);
  const repeat = intFlag(flags, 'repeat', 2);
  const pack = typeof flags.pack === 'string' ? flags.pack : 'coding';
  const tasksPath = join(repoRoot, 'benchmark', 'packs', `${pack}.json`);
  if (!existsSync(tasksPath)) {
    console.error(`Error: unknown pack "${pack}".`);
    process.exit(1);
  }
  let tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; prompt: string; grader: Grader }>;
  if (typeof flags.task === 'string') tasks = tasks.filter((t) => t.id === flags.task);

  // Builder: flags > config > detected default (same both-slots trick as probe —
  // recommend varies only the reviewer).
  const cfg = loadConfigAuto(flags);
  const detected = await detectAll();
  const builderInput = roleInputFrom(flags, 'builder');
  const plan = planSelection({
    builder: builderInput,
    reviewer: builderInput,
    config: { builder: cfg.builder, reviewer: cfg.builder },
    detected,
    isTTY: false,
    mode: 'advised',
    defaultModelFor: (engine, role) => getEngine(engine).defaultModels[role],
  });
  const builder = await resolveDecision(null, 'builder', plan.builder, detected);
  console.log(`builder=${builder.engine}/${builder.model}  candidates=${candidates.map((c) => `${c.engine}/${c.model}`).join(', ')}\n`);

  // Stage 1 — probe gate. Cheap (10 short calls per candidate) and it keeps a
  // rubber-stamp from winning stage 2 on cost: approving everything is both
  // "top quality can't be worse than baseline" and nearly free.
  const probePath = typeof flags.probe === 'string' ? flags.probe : join(repoRoot, 'benchmark', 'probe.json');
  const items = validateProbeItems(JSON.parse(readFileSync(probePath, 'utf8')));
  const survivors: EngineConfig[] = [];
  for (const cand of candidates) {
    console.log(`Probing ${cand.engine}/${cand.model}…`);
    const p = await probeReviewer(items, cand, undefined, () => {});
    const rates = `caught ${p.defectsCaught}/${p.defectsTotal}, false alarms ${p.falseAlarms}/${p.correctTotal}`;
    if (p.verdict === 'trustworthy' || p.verdict === 'over-critical') {
      console.log(`  ${p.verdict} (${rates}) → advances to the bench`);
      survivors.push(cand);
    } else {
      console.log(`  ${p.verdict} (${rates}) → eliminated (would launder broken output)`);
    }
  }
  if (survivors.length === 0) {
    console.error('\nNo candidate survived the probe — every one approves planted defects. Try stronger models.');
    process.exit(1);
  }

  // Stage 2 — mini-bench: shared baseline control + one advised arm per survivor.
  console.log(`\nBenching ${survivors.length} survivor(s) on pack "${pack}" (${tasks.length} task(s) × ${repeat} repeat(s))…`);
  const records: RunRecord[] = [];
  const unit = async (t: (typeof tasks)[0], mode: Mode, armLabel: string, reviewer: EngineConfig) => {
    try {
      const result = await run({ task: t.prompt, builder, reviewer, consults, mode });
      const g = await grade(t.grader, result.finalOutput);
      const tok = tallyTokens(result);
      records.push({
        taskId: t.id,
        mode: armLabel,
        score: g.score,
        inputTokens: tok.inputTokens,
        outputTokens: tok.outputTokens,
        cacheReadTokens: tok.cacheReadTokens,
        cacheCreationTokens: tok.cacheCreationTokens,
        rounds: result.rounds.length,
        costUsd: estimateRunCostUsd(result, builder, reviewer),
      });
      console.log(`  [${t.id} ${armLabel}] score ${g.score.toFixed(2)}`);
    } catch (err) {
      console.error(`  [${t.id} ${armLabel}] ERROR: ${err instanceof Error ? err.message : String(err)} — skipped`);
    }
  };
  for (let i = 0; i < repeat; i++) {
    for (const t of tasks) {
      await unit(t, 'baseline', 'baseline', builder);
      for (const cand of survivors) await unit(t, 'advised', armLabelFor(cand), cand);
    }
  }

  const stats = aggregate(records);
  console.log('\n' + formatReport(stats));

  const rec = recommendFrom(stats);
  const config =
    rec.kind === 'reviewer'
      ? { builder, reviewer: rec.reviewer, mode: 'advised' as Mode, consults }
      : { builder, mode: 'baseline' as Mode, consults: 0 };
  console.log(
    rec.kind === 'reviewer'
      ? `\nRecommendation: ${rec.reviewer.engine}/${rec.reviewer.model} — cheapest reviewer within ε of the best (score ${rec.arm.meanScore?.toFixed(2)}).`
      : '\nRecommendation: no reviewer earns its keep on this pack — baseline matches them. Config = baseline.',
  );

  if (existsSync('loupe.config.json') && flags.force !== true) {
    console.log('loupe.config.json exists — rerun with --force to overwrite it with this recommendation.');
    return;
  }
  writeFileSync('loupe.config.json', JSON.stringify(config, null, 2) + '\n');
  console.log('Wrote loupe.config.json — `loupe run` picks it up automatically.');
}
