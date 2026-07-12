import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grade, gradeDeterministic, parseJudgeScore, extractCode, splitChecks } from './grader.js';
import type { EngineConfig, CallResult } from './engines/index.js';

const mk = (text: string): CallResult => ({ text, usage: null, notionalCostUsd: null });

test('includes: all present → 1, partial → fraction with missing detail', () => {
  assert.equal(gradeDeterministic({ type: 'includes', must: ['FizzBuzzWoof'] }, 'print FizzBuzzWoof here').score, 1);
  const partial = gradeDeterministic({ type: 'includes', must: ['FIZZ', 'BUZZ', 'WOOF', 'MEOW'] }, 'FIZZ BUZZ only');
  assert.equal(partial.score, 0.5);
  assert.match(partial.detail, /missing: WOOF, MEOW/);
});

test('includes: caseInsensitive', () => {
  assert.equal(gradeDeterministic({ type: 'includes', must: ['APPROVED'], caseInsensitive: true }, 'approved!').score, 1);
});

test('regex: match → 1, no match → 0 (no-e constraint)', () => {
  assert.equal(gradeDeterministic({ type: 'regex', pattern: '^[^eE]*$' }, 'a funword').score, 1);
  assert.equal(gradeDeterministic({ type: 'regex', pattern: '^[^eE]*$' }, 'has an e').score, 0);
});

test('parseJudgeScore: prefers N/10, else last integer, dodges scale-echo', () => {
  assert.equal(parseJudgeScore('8'), 0.8);
  assert.equal(parseJudgeScore('10/10'), 1);
  assert.equal(parseJudgeScore('Score: 7 out of 10'), 0.7);
  assert.equal(parseJudgeScore('On a scale of 0 to 10: 7'), 0.7); // was 0 with first-int
  assert.equal(parseJudgeScore('3 issues, so 8'), 0.8); // last int, not 0.3
  assert.equal(parseJudgeScore('great work!'), null);
});

test('judge grader calls the engine and normalizes 0-10 → 0..1', async () => {
  let seenPrompt = '';
  const callFn = async (_engine: EngineConfig, prompt: string): Promise<CallResult> => {
    seenPrompt = prompt;
    return mk('9');
  };
  const r = await grade({ type: 'judge', rubric: 'is polite' }, 'Dear client, ...', {
    callFn,
    judgeEngine: { engine: 'claude-code', model: 'opus' },
  });
  assert.equal(r.score, 0.9);
  assert.match(seenPrompt, /is polite/);
});

test('judge grader with unparseable reply → score 0, not a throw', async () => {
  const callFn = async (): Promise<CallResult> => mk('looks good to me');
  const r = await grade({ type: 'judge', rubric: 'x' }, 'out', { callFn, judgeEngine: { engine: 'local', model: 'm' } });
  assert.equal(r.score, 0);
  assert.match(r.detail, /no parseable score/);
});

test('judge grader without an engine throws', async () => {
  await assert.rejects(() => grade({ type: 'judge', rubric: 'x' }, 'out'), /needs an engine/);
});

test('exec grader: passing checks → 1, failing → 0 (real node subprocess)', async () => {
  const code = 'function add(a, b) { return a + b; }';
  const pass = await grade({ type: 'exec', language: 'node', tests: "if (add(2,3) !== 5) throw new Error('bad');" }, code);
  assert.equal(pass.score, 1);
  const fail = await grade({ type: 'exec', language: 'node', tests: "if (add(2,3) !== 6) throw new Error('bad');" }, code);
  assert.equal(fail.score, 0);
  assert.match(fail.detail, /0\/1 checks passed/); // per-assertion harness reports counts, not a blanket failure
});

test('exec grader: extracts fenced code before running', async () => {
  const out = '```js\nfunction f() { return 42; }\n```';
  const r = await grade({ type: 'exec', language: 'node', tests: 'if (f() !== 42) throw new Error("bad");' }, out);
  assert.equal(r.score, 1);
});

test('extractCode: fenced blocks win, surrounding prose ignored', () => {
  assert.equal(extractCode('sure:\n```js\nconst x = 1;\n```\nhope that helps').trim(), 'const x = 1;');
});

test('extractCode: multiple fenced blocks join, in order', () => {
  const out = 'setup:\n```js\nconst a = 1;\n```\nthen:\n```js\nconst b = 2;\n```\ndone';
  assert.equal(extractCode(out).trim(), 'const a = 1;\nconst b = 2;');
});

test('extractCode: no fence → verbatim (no prose-stripping heuristics)', () => {
  // Contamination is fixed at the source (design §23/§24): the builder runs
  // vanilla, so unfenced output IS the code. Prose in it should fail the exec
  // grader loudly, not be silently trimmed by a heuristic that can also eat
  // legitimate code.
  const code = '// Returns one.\nfunction f() {\n  return 1;\n}';
  assert.equal(extractCode(code), code);
  const withTrailingProse = 'function f() { return 1; }\n\nThis multiplies before flooring.';
  assert.equal(extractCode(withTrailingProse), withTrailingProse);
});

test('splitChecks: one check per non-empty line', () => {
  assert.deepEqual(splitChecks("a();\n\n  b();  \n"), ['a();', 'b();']);
});

test('exec grader: per-assertion fractional score + failing check named in detail', async () => {
  const code = 'function add(a, b) { return a === 2 ? a + b : 0; }';
  const r = await grade(
    {
      type: 'exec',
      language: 'node',
      tests: "if (add(2,3) !== 5) throw new Error('add(2,3) wrong');\nif (add(4,4) !== 8) throw new Error('add(4,4) wrong');",
    },
    code,
  );
  assert.equal(r.score, 0.5);
  assert.match(r.detail, /1\/2 checks passed/);
  assert.match(r.detail, /add\(4,4\) wrong/, 'the failing check must be named for targeted feedback');
});

test('exec grader: code that crashes at load still scores 0 with the error surfaced', async () => {
  const r = await grade({ type: 'exec', language: 'node', tests: 'f();' }, 'syntax error here((');
  assert.equal(r.score, 0);
  assert.match(r.detail, /checks failed|no score/);
});
