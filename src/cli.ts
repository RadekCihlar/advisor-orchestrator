#!/usr/bin/env node
// Thin dispatcher (cleaner-list split): flag parsing + command routing only.
// Command implementations live in src/commands/*; shared plumbing in
// src/commands/shared.ts.

import { USAGE } from './commands/shared.js';
import { parseArgs } from './cli-args.js';
import { cmdRun } from './commands/run.js';
import { cmdBench } from './commands/bench.js';
import { cmdSetup } from './commands/setup.js';
import { cmdProviders } from './commands/providers.js';
import { cmdDiff } from './commands/diff.js';
import { cmdProbe } from './commands/probe.js';
import { cmdRecommend } from './commands/recommend.js';
import { cmdStats } from './commands/stats.js';
import { cmdMcp } from './commands/mcp.js';

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const command = positional[0];

  if (flags.help === true || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (command === 'diff') return cmdDiff(positional);
  if (command === 'probe') return cmdProbe(flags);
  if (command === 'recommend') return cmdRecommend(flags);
  if (command === 'stats') return cmdStats(flags);
  if (command === 'mcp') return cmdMcp();
  if (command === 'providers') return cmdProviders();
  if (command === 'setup') return cmdSetup();
  if (command === 'run') return cmdRun(flags, positional);
  if (command === 'bench') return cmdBench(flags);

  console.error(USAGE);
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
