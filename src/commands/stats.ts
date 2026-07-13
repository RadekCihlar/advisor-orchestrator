import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { formatStats, parseUsageLines, summarizeUsage } from '../stats.js';
import type { Flags } from './shared.js';

// `loupe stats`: local evidence from the usage.jsonl run history. --json puts
// one stable JSON document on stdout — statusline/script material.
export async function cmdStats(flags: Flags): Promise<void> {
  const path = process.env.LOUPE_LOG ?? join(process.cwd(), 'usage.jsonl');
  if (!existsSync(path)) {
    if (flags.json === true) {
      console.log(JSON.stringify({ runs: 0, path }));
      return;
    }
    console.log(`No usage log at ${path} — every completed \`loupe run\`/bench arm appends one line.`);
    return;
  }
  const { lines, skipped } = parseUsageLines(readFileSync(path, 'utf8'));
  const summary = summarizeUsage(lines);
  if (flags.json === true) {
    console.log(JSON.stringify({ ...summary, path, skipped }));
    return;
  }
  console.log(formatStats(summary));
  if (skipped > 0) console.error(`(${skipped} malformed line(s) skipped)`);
}
