import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseClaudeResult } from './claude-code.js';

test('parses a successful result with cache tokens', () => {
  const stdout = JSON.stringify({
    is_error: false,
    result: 'hello',
    total_cost_usd: 0.01,
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 100,
      cache_creation_input_tokens: 2000,
    },
  });
  const r = parseClaudeResult(stdout);
  assert.equal(r.text, 'hello');
  assert.deepEqual(r.usage, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheCreationTokens: 2000 });
  assert.equal(r.notionalCostUsd, 0.01);
});

test('surfaces an is_error payload with its API status code (the real 429 case)', () => {
  // Verbatim shape of what claude -p wrote to stdout during the failed bench run.
  const stdout = JSON.stringify({
    is_error: true,
    api_error_status: 429,
    result:
      'API Error: Request rejected (429) · Quota exceeded for aiplatform.googleapis.com with base model: anthropic-claude-opus-4-6. RESOURCE_EXHAUSTED',
  });
  assert.throws(() => parseClaudeResult(stdout), (err: unknown) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /claude -p error \(429\)/, 'must include the API status code');
    assert.match(err.message, /Quota exceeded/, 'must include the real upstream reason');
    return true;
  });
});
