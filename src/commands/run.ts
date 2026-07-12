import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { MODES, type Mode } from '../runner.js';
import { detectAll, getEngine, isKnownEngine, KNOWN_ENGINES } from '../engines/index.js';
import { planSelection } from '../selection.js';
import { intFlag, loadConfigAuto, resolveDecision, roleInputFrom, runOne, USAGE, type Flags } from './shared.js';

export async function cmdRun(flags: Flags, positional: string[]): Promise<void> {
  let task = positional[1];
  if (task === '-') {
    task = readFileSync(0, 'utf8').trim(); // fd 0 = stdin, for long/multiline tasks
  }
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

  const needsPrompt = plan.builder.kind === 'prompt' || plan.reviewer.kind === 'prompt';
  const rl = needsPrompt ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    const builder = await resolveDecision(rl, 'builder', plan.builder, detected);
    const reviewer =
      plan.reviewer.kind === 'mirror' ? builder : await resolveDecision(rl, 'reviewer', plan.reviewer, detected);
    await runOne(task, mode, builder, reviewer, consults, undefined, flags.json === true);
  } finally {
    rl?.close();
  }
}
