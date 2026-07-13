import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from './cli-args.js';

test('--lean is boolean: never consumes the following positional as its value', () => {
  const { flags, positional } = parseArgs(['node', 'cli', 'run', '--lean', 'my task']);
  assert.equal(flags.lean, true);
  assert.deepEqual(positional, ['run', 'my task']);
});

test('value flags still consume their argument', () => {
  const { flags } = parseArgs(['node', 'cli', 'bench', '--pack', 'hard', '--lean']);
  assert.equal(flags.pack, 'hard');
  assert.equal(flags.lean, true);
});
