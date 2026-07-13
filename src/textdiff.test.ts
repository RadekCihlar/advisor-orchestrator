import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineDiff } from './textdiff.js';

const LINES = [
  'function add(a, b) {', '  return a + b;', '}', '',
  'function sub(a, b) {', '  return a - b;', '}', '',
  'function mul(a, b) {', '  return a * b;', '}', '',
  'function div(a, b) {', '  return a / b;', '}', '',
  'function mod(a, b) {', '  return a % b;', '}',
].join('\n');

test('lineDiff: identical texts → empty string (no changes)', () => {
  assert.equal(lineDiff(LINES, LINES), '');
});

test('lineDiff: one changed line → -/+ pair with context, without repeating the whole text', () => {
  const changed = LINES.replace('return a - b;', 'return b - a;');
  const d = lineDiff(LINES, changed)!;
  assert.ok(d.includes('-   return a - b;'), `missing removed line in:\n${d}`);
  assert.ok(d.includes('+   return b - a;'), `missing added line in:\n${d}`);
  assert.ok(d.includes('function sub(a, b) {'), 'context line around the change');
  assert.ok(!d.includes('function mul'), `far-away unchanged lines must not appear:\n${d}`);
  assert.ok(d.length < changed.length, 'delta must be smaller than the full text');
});

test('lineDiff: pure insertion → + line only', () => {
  const added = `${LINES}\n\nfunction pow(a, b) {\n  return a ** b;\n}`;
  const d = lineDiff(LINES, added)!;
  assert.ok(d.includes('+ function pow(a, b) {'));
  assert.ok(!d.includes('- '), `no removals expected:\n${d}`);
});

test('lineDiff: pure deletion → - line only', () => {
  const removed = LINES.split('\n').filter((l) => !l.includes('mul')).join('\n');
  const d = lineDiff(LINES, removed)!;
  assert.ok(d.includes('- function mul(a, b) {'));
});

test('lineDiff: full rewrite → null (caller falls back to sending the whole output)', () => {
  const rewrite = ['const ops = {', '  add: (a, b) => a + b,', '  sub: (a, b) => a - b,', '};'].join('\n');
  assert.equal(lineDiff(LINES, rewrite), null);
});

test('lineDiff: disjoint changes → separate hunks', () => {
  const changed = LINES.replace('return a + b;', 'return a + b; // sum').replace('return a % b;', 'return a % b; // remainder');
  const d = lineDiff(LINES, changed)!;
  assert.ok(d.includes('+   return a + b; // sum'));
  assert.ok(d.includes('+   return a % b; // remainder'));
  assert.ok(!d.includes('function sub'), `middle section unchanged and far from both changes:\n${d}`);
});
