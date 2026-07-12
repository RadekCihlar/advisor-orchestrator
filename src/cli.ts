#!/usr/bin/env node
// Thin dispatcher (cleaner-list split): flag parsing + command routing only.
// Command implementations live in src/commands/*; shared plumbing in
// src/commands/shared.ts.

import { USAGE, type Flags } from './commands/shared.js';
import { cmdRun } from './commands/run.js';
import { cmdBench } from './commands/bench.js';
import { cmdSetup } from './commands/setup.js';
import { cmdProviders } from './commands/providers.js';
import { cmdDiff } from './commands/diff.js';
import { cmdProbe } from './commands/probe.js';

const BOOL_FLAGS = new Set(['json', 'help']); // never consume the next arg as a value

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const flags: Flags = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (!BOOL_FLAGS.has(key) && next !== undefined && !next.startsWith('--')) {
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

async function main() {
  const { flags, positional } = parseArgs(process.argv);
  const command = positional[0];

  if (flags.help === true || command === 'help') {
    console.log(USAGE);
    return;
  }
  if (command === 'diff') return cmdDiff(positional);
  if (command === 'probe') return cmdProbe(flags);
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
