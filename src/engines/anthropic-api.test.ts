import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAnthropicResponse } from './anthropic-api.js';

// Fixtures follow the Messages API response shape (POST /v1/messages).

test('parses text + usage incl. both cache fields from a Messages response', () => {
  const r = parseAnthropicResponse({
    content: [{ type: 'text', text: 'hello from the API' }],
    usage: {
      input_tokens: 12,
      output_tokens: 7,
      cache_read_input_tokens: 4,
      cache_creation_input_tokens: 2,
    },
  });
  assert.equal(r.text, 'hello from the API');
  assert.deepEqual(r.usage, { inputTokens: 12, outputTokens: 7, cacheReadTokens: 4, cacheCreationTokens: 2 });
  assert.equal(r.notionalCostUsd, null); // API reports tokens, never dollars
});

test('joins text blocks and skips thinking blocks', () => {
  const r = parseAnthropicResponse({
    content: [
      { type: 'thinking', thinking: '' },
      { type: 'text', text: 'part one' },
      { type: 'text', text: ' part two' },
    ],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  assert.equal(r.text, 'part one part two');
});

test('missing usage → null usage, empty content → empty text', () => {
  const r = parseAnthropicResponse({ content: [] });
  assert.equal(r.text, '');
  assert.equal(r.usage, null);
});
