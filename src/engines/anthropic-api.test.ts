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

// --- request-body building: prompt caching (cache_control on the stable prefix) ---

import { buildAnthropicBody } from './anthropic-api.js';

test('no cachedPrefixLen → single plain-string user message (unchanged shape)', () => {
  const body = buildAnthropicBody('m', 'Task: do it');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'Task: do it' }]);
});

test('cachedPrefixLen splits into two blocks, cache_control on the prefix', () => {
  const prompt = 'Task: do it\n\nYour previous attempt:\nstuff';
  const body = buildAnthropicBody('m', prompt, 'Task: do it'.length);
  assert.deepEqual(body.messages, [
    {
      role: 'user',
      content: [
        { type: 'text', text: 'Task: do it', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: '\n\nYour previous attempt:\nstuff' },
      ],
    },
  ]);
});

test('prefix = whole prompt → single fully-cached block; 0 → plain string', () => {
  assert.deepEqual(buildAnthropicBody('m', 'abc', 0).messages, [{ role: 'user', content: 'abc' }]);
  const whole = [{ role: 'user', content: [{ type: 'text', text: 'abc', cache_control: { type: 'ephemeral' } }] }];
  assert.deepEqual(buildAnthropicBody('m', 'abc', 3).messages, whole);
  assert.deepEqual(buildAnthropicBody('m', 'abc', 99).messages, whole);
});
