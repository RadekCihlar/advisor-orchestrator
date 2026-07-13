import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mineTasks, type NamedFile } from '../tasks-mine.js';
import type { Flags } from './shared.js';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'out', '.next', 'vendor']);
const CODE = /\.[cm]?[jt]sx?$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;

function walk(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else if (CODE.test(name) && !name.endsWith('.d.ts')) acc.push(p);
  }
  return acc;
}

// `loupe tasks from-repo [dir]` (ROADMAP v3 #20): mine the repo's own tests
// into an exec-graded task pack. v1 lifts only literal-argument assertions on
// a single exported function — guaranteed self-contained — and reports what
// it skipped rather than guessing.
export async function cmdTasks(flags: Flags, positional: string[]): Promise<void> {
  if (positional[1] !== 'from-repo') {
    console.error('Usage: loupe tasks from-repo [dir] [--out mined-tasks.json]');
    process.exit(1);
  }
  const dir = positional[2] ?? '.';
  const files = walk(dir).map((path): NamedFile => ({ path, content: readFileSync(path, 'utf8') }));
  const testFiles = files.filter((f) => TEST.test(f.path));
  const sourceFiles = files.filter((f) => !TEST.test(f.path));
  console.log(`Scanned ${files.length} files under ${dir} (${testFiles.length} test file(s)).`);

  const { tasks, skipped } = mineTasks(testFiles, sourceFiles);
  if (tasks.length === 0) {
    console.error('No mineable functions found. v1 lifts literal-argument assert.equal/deepEqual/ok/throws and expect().toBe/.toEqual on exported functions — fixture-based tests are skipped by design.');
    if (skipped.length) console.error(`Skipped: ${skipped.join('; ')}`);
    process.exit(1);
  }

  const out = typeof flags.out === 'string' ? flags.out : 'mined-tasks.json';
  writeFileSync(out, JSON.stringify(tasks, null, 2) + '\n');
  console.log(`\nMined ${tasks.length} task(s):`);
  for (const t of tasks) console.log(`  ${t.id} — ${t.grader.tests.split('\n').length} check(s)`);
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const s of skipped) console.log(`  ${s}`);
  }
  console.log(`\nWrote ${out} — REVIEW IT before benching (checks are lifted mechanically), then:`);
  console.log(`  loupe bench --tasks ${out}`);
}
