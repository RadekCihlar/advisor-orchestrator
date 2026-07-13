// Flag/positional parsing for the CLI, in its own module so tests can import
// it without executing cli.ts's entry point.

import type { Flags } from './commands/shared.js';

const BOOL_FLAGS = new Set(['json', 'help', 'lean', 'force', 'until-clear']); // never consume the next arg as a value

export function parseArgs(argv: string[]): { flags: Flags; positional: string[] } {
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
