import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.js';

let counter = 0;
function withConfigFile(contents: string, fn: (path: string) => void): void {
  const path = join(tmpdir(), `advisor-cfg-${process.pid}-${counter++}.json`);
  writeFileSync(path, contents);
  try {
    fn(path);
  } finally {
    rmSync(path, { force: true });
  }
}

test('valid full config parses all wired fields', () => {
  const contents = JSON.stringify({
    builder: { engine: 'claude-code', model: 'sonnet' },
    reviewer: { engine: 'local', model: 'llama3.1' },
    mode: 'escalated',
    consults: 4,
  });
  withConfigFile(contents, (p) => {
    const cfg = loadConfig(p);
    assert.deepEqual(cfg.builder, { engine: 'claude-code', model: 'sonnet' });
    assert.deepEqual(cfg.reviewer, { engine: 'local', model: 'llama3.1' });
    assert.equal(cfg.mode, 'escalated');
    assert.equal(cfg.consults, 4);
  });
});

test('partial config returns only present fields', () => {
  withConfigFile(JSON.stringify({ mode: 'baseline' }), (p) => {
    const cfg = loadConfig(p);
    assert.equal(cfg.mode, 'baseline');
    assert.equal(cfg.builder, undefined);
    assert.equal(cfg.reviewer, undefined);
    assert.equal(cfg.consults, undefined);
  });
});

test('invalid mode is rejected', () => {
  withConfigFile(JSON.stringify({ mode: 'committee' }), (p) => {
    assert.throws(() => loadConfig(p), /mode must be one of/);
  });
});

test('invalid engine is rejected', () => {
  withConfigFile(JSON.stringify({ builder: { engine: 'openai', model: 'x' } }), (p) => {
    assert.throws(() => loadConfig(p), /engine must be one of/);
  });
});

test('empty model string is rejected', () => {
  withConfigFile(JSON.stringify({ builder: { engine: 'local', model: '' } }), (p) => {
    assert.throws(() => loadConfig(p), /model must be a non-empty string/);
  });
});

test('negative consults is rejected', () => {
  withConfigFile(JSON.stringify({ consults: -1 }), (p) => {
    assert.throws(() => loadConfig(p), /consults must be a non-negative integer/);
  });
});

test('non-integer consults is rejected', () => {
  withConfigFile(JSON.stringify({ consults: 1.5 }), (p) => {
    assert.throws(() => loadConfig(p), /consults must be a non-negative integer/);
  });
});

test('malformed JSON is rejected', () => {
  withConfigFile('{ not json', (p) => {
    assert.throws(() => loadConfig(p), /could not read\/parse/);
  });
});
