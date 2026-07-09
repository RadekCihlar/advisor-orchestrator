import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexOutput } from './codex.js';

// Fixtures follow the documented `codex exec --json` event shape. Marked
// needs-live-verification in codex.ts — confirm against an installed codex.

test('parses agent_message text + turn.completed usage from the JSONL stream', () => {
  const stdout = [
    JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'hello from codex' } }),
    JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 12, cached_input_tokens: 4, output_tokens: 7, reasoning_output_tokens: 3 },
    }),
  ].join('\n');

  const r = parseCodexOutput(stdout);
  assert.equal(r.text, 'hello from codex');
  // reasoning tokens fold into output: 7 + 3 = 10
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 10, cacheReadTokens: 4 });
  assert.equal(r.notionalCostUsd, null);
});

test('throws a descriptive error on a turn.failed event', () => {
  const stdout = [
    JSON.stringify({ type: 'turn.started' }),
    JSON.stringify({ type: 'turn.failed', error: { message: 'model overloaded' } }),
  ].join('\n');

  assert.throws(() => parseCodexOutput(stdout), /codex exec error: model overloaded/);
});

test('ignores non-JSON progress lines without crashing', () => {
  const stdout = [
    'some human-readable progress line',
    JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'ok' } }),
  ].join('\n');

  assert.equal(parseCodexOutput(stdout).text, 'ok');
});
