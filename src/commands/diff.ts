import { readFileSync } from 'node:fs';
import { diffReports, type ReportJson } from '../report.js';

export function cmdDiff(positional: string[]): void {
  const [aPath, bPath] = [positional[1], positional[2]];
  if (!aPath || !bPath) {
    console.error('Usage: diff a.json b.json  (two `bench --out` result files)');
    process.exit(1);
  }
  let a: ReportJson, b: ReportJson;
  try {
    a = JSON.parse(readFileSync(aPath, 'utf8'));
    b = JSON.parse(readFileSync(bPath, 'utf8'));
  } catch (err) {
    console.error(`Error reading result files: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (!Array.isArray(a.stats) || !Array.isArray(b.stats)) {
    console.error('Error: not `bench --out` files (missing stats[]).');
    process.exit(1);
  }
  console.log(diffReports(a, b));
}
