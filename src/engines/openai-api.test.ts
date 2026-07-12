import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOpenAIResponse } from './openai-api.js';

// Fixtures follow the Chat Completions response shape (POST /v1/chat/completions).

test('parses message content + usage with cached prompt tokens', () => {
  const r = parseOpenAIResponse({
    choices: [{ message: { content: 'hello from openai' } }],
    usage: {
      prompt_tokens: 20,
      completion_tokens: 9,
      prompt_tokens_details: { cached_tokens: 5 },
    },
  });
  assert.equal(r.text, 'hello from openai');
  assert.deepEqual(r.usage, { inputTokens: 20, outputTokens: 9, cacheReadTokens: 5 });
  assert.equal(r.notionalCostUsd, null);
});

test('no prompt_tokens_details → usage without cacheReadTokens', () => {
  const r = parseOpenAIResponse({
    choices: [{ message: { content: 'ok' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1 },
  });
  assert.deepEqual(r.usage, { inputTokens: 3, outputTokens: 1 });
});

test('empty choices / missing usage → empty text, null usage', () => {
  const r = parseOpenAIResponse({ choices: [] });
  assert.equal(r.text, '');
  assert.equal(r.usage, null);
});
