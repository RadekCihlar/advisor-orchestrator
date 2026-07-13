import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liftChecks, extractFunction, mineTasks } from './tasks-mine.js';

test('liftChecks: assert.equal with literal args → self-contained throw check, attributed to the called fn', () => {
  const src = `assert.equal(luhnValid('4539578763621486'), true);\nassert.equal(luhnValid('1234'), false);`;
  const checks = liftChecks(src);
  assert.equal(checks.length, 2);
  assert.equal(checks[0].fn, 'luhnValid');
  assert.match(checks[0].check, /if \(\(luhnValid\('4539578763621486'\)\) !== \(true\)\) throw new Error/);
});

test('liftChecks: deepEqual → JSON.stringify compare; ok → truthiness; expect().toBe/.toEqual', () => {
  const src = [
    `assert.deepEqual(parseRange('1-3'), [1, 2, 3]);`,
    `assert.ok(isBalanced('([])'));`,
    `expect(romanToInt('IX')).toBe(9);`,
    `expect(splitCsv('a,b')).toEqual(['a', 'b']);`,
  ].join('\n');
  const checks = liftChecks(src);
  assert.equal(checks.length, 4);
  assert.match(checks[0].check, /JSON\.stringify\(parseRange\('1-3'\)\) !== JSON\.stringify\(\[1, 2, 3\]\)/);
  assert.match(checks[1].check, /if \(!\(isBalanced\('\(\[\]\)'\)\)\) throw/);
  assert.match(checks[2].check, /romanToInt\('IX'\)\) !== \(9\)/);
  assert.match(checks[3].check, /JSON\.stringify\(splitCsv\('a,b'\)\)/);
});

test('liftChecks: assert.throws → single-line expected-throw check', () => {
  const checks = liftChecks(`assert.throws(() => parseRange('5-2'));`);
  assert.equal(checks.length, 1);
  assert.match(checks[0].check, /try.*parseRange\('5-2'\).*catch/);
  assert.match(checks[0].check, /throw new Error/);
});

test('liftChecks: non-literal args (test-local variables) are skipped — self-containment guarantee', () => {
  const src = `const fixture = makeThing();\nassert.equal(process(fixture), 42);\nassert.equal(add(1, 2), 3);`;
  const checks = liftChecks(src);
  assert.equal(checks.length, 1, 'only the literal-args check survives');
  assert.equal(checks[0].fn, 'add');
});

test('extractFunction: export function with JSDoc, and export const arrow', () => {
  const src = `/** Adds two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport const isApproval = (text: string): boolean =>\n  text === 'APPROVED';`;
  const f = extractFunction(src, 'add')!;
  assert.match(f.jsdoc ?? '', /Adds two numbers/);
  assert.match(f.signature, /function add\(a: number, b: number\): number/);
  const g = extractFunction(src, 'isApproval')!;
  assert.match(g.signature, /isApproval = \(text: string\): boolean/);
  assert.equal(extractFunction(src, 'missing'), null);
});

test('mineTasks: groups checks per function, needs ≥2 checks and a found signature', () => {
  const testFiles = [
    { path: 't/add.test.ts', content: `assert.equal(add(1, 2), 3);\nassert.equal(add(-1, 1), 0);\nassert.equal(lonely(5), 5);` },
  ];
  const sourceFiles = [{ path: 's/math.ts', content: `export function add(a: number, b: number): number { return a + b; }` }];
  const { tasks, skipped } = mineTasks(testFiles, sourceFiles);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].id, 'mined-add');
  assert.match(tasks[0].prompt, /function add\(a: number, b: number\)/);
  assert.equal(tasks[0].grader.type, 'exec');
  assert.equal(tasks[0].grader.tests.split('\n').length, 2);
  assert.ok(skipped.some((s) => s.includes('lonely')), 'single-check fn reported as skipped');
});
