#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { run, type Mode } from './runner.js';
import { printUsage } from './usage.js';
import type { EngineConfig } from './engines/index.js';

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

function engineFrom(flags: Record<string, string | true>, prefix: string, fallback: EngineConfig): EngineConfig {
  const engine = flags[`${prefix}-engine`];
  const model = flags[`${prefix}-model`];
  return {
    engine: engine === 'local' ? 'local' : engine === 'claude-code' ? 'claude-code' : fallback.engine,
    model: typeof model === 'string' ? model : fallback.model,
  };
}

const USAGE = `Usage:
  tsx src/cli.ts run "<task>" [--mode baseline|self-review|advised] [--consults N]
    [--builder-engine local|claude-code] [--builder-model X]
    [--reviewer-engine local|claude-code] [--reviewer-model X]

  tsx src/cli.ts bench [--consults N] [--repeat N]
    Runs benchmark/tasks.json through all 3 arms (baseline / self-review / advised).
    Directional smoke test only — 3 tasks x default 1 repeat is not statistically
    meaningful. Use --repeat to run each task multiple times.`;

async function runOne(
  task: string,
  mode: Mode,
  builder: EngineConfig,
  reviewer: EngineConfig,
  consults: number,
): Promise<void> {
  const label =
    mode === 'baseline'
      ? `builder: ${builder.engine}/${builder.model} (solo, 1 pass, no reviewer)`
      : `builder: ${builder.engine}/${builder.model} -- reviewer: ${reviewer.engine}/${reviewer.model}` +
        (reviewer.engine === builder.engine && reviewer.model === builder.model ? ' [same model — self-review]' : '');
  console.log(label);

  const result = await run({ task, builder, reviewer, consults, mode });
  console.log('\n--- final output ---');
  console.log(result.finalOutput);
  console.log('\n--- usage ---');
  printUsage(result);
}

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const command = positional[0];

  const defaultBuilder: EngineConfig = { engine: 'claude-code', model: 'sonnet' };
  const defaultReviewer: EngineConfig = { engine: 'claude-code', model: 'opus' };

  if (command === 'run') {
    const task = positional[1];
    if (!task) {
      console.error(USAGE);
      process.exit(1);
    }

    const mode = (typeof flags.mode === 'string' ? (flags.mode as Mode) : 'advised');
    const consults = flags.consults ? Number(flags.consults) : 2;
    const builder = engineFrom(flags, 'builder', defaultBuilder);
    const reviewer = mode === 'self-review' ? builder : engineFrom(flags, 'reviewer', defaultReviewer);

    await runOne(task, mode, builder, reviewer, consults);
    return;
  }

  if (command === 'bench') {
    const consults = flags.consults ? Number(flags.consults) : 2;
    const repeat = flags.repeat ? Number(flags.repeat) : 1;
    const tasksPath = join(here, '..', 'benchmark', 'tasks.json');
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8')) as Array<{ id: string; prompt: string }>;

    console.log(
      `Running ${tasks.length} task(s) x ${repeat} repeat(s) x 3 arms (baseline / self-review / advised).\n` +
        `This is a directional smoke test, not a statistically meaningful benchmark.\n`,
    );

    const modes: Mode[] = ['baseline', 'self-review', 'advised'];
    for (const t of tasks) {
      for (let i = 0; i < repeat; i++) {
        for (const mode of modes) {
          const builder = defaultBuilder;
          const reviewer = mode === 'self-review' ? builder : defaultReviewer;
          console.log(`\n### task=${t.id} run=${i + 1} mode=${mode}`);
          try {
            await runOne(t.prompt, mode, builder, reviewer, consults);
          } catch (err) {
            // Builder-side failure (rate limit, upstream error, ...) with no
            // output to ship for this arm — log and move to the next arm
            // instead of aborting the whole benchmark.
            console.error(`  ERROR: ${err instanceof Error ? err.message : String(err)} — skipping this arm.`);
          }
        }
      }
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
