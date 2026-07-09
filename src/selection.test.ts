import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSelection, type SelectionInput } from './selection.js';

const detected = [
  { name: 'claude-code', available: true },
  { name: 'codex', available: false },
  { name: 'local', available: false },
];

const defaultModelFor = (engine: string, role: 'builder' | 'reviewer'): string | undefined => {
  if (engine === 'claude-code') return role === 'builder' ? 'sonnet' : 'opus';
  if (engine === 'codex') return 'gpt-5-codex';
  return undefined; // local has no universal default
};

function base(overrides: Partial<SelectionInput> = {}): SelectionInput {
  return {
    builder: {},
    reviewer: {},
    detected,
    isTTY: false,
    mode: 'advised',
    defaultModelFor,
    ...overrides,
  };
}

test('explicit flags win → fixed (even if that engine is unavailable)', () => {
  const plan = planSelection(base({ builder: { engine: 'codex', model: 'gpt-5-codex' } }));
  assert.deepEqual(plan.builder, { kind: 'fixed', config: { engine: 'codex', model: 'gpt-5-codex' } });
});

test('config supplies role when no flag → fixed', () => {
  const plan = planSelection(base({ config: { builder: { engine: 'local', model: 'llama3.1' } } }));
  assert.deepEqual(plan.builder, { kind: 'fixed', config: { engine: 'local', model: 'llama3.1' } });
});

test('flag overrides config', () => {
  const plan = planSelection(
    base({ builder: { engine: 'local', model: 'x' }, config: { builder: { engine: 'claude-code', model: 'sonnet' } } }),
  );
  assert.deepEqual(plan.builder, { kind: 'fixed', config: { engine: 'local', model: 'x' } });
});

test('flag engine override drops a different engine’s config model → default', () => {
  const plan = planSelection(
    base({ builder: { engine: 'codex' }, config: { builder: { engine: 'claude-code', model: 'sonnet' } } }),
  );
  assert.deepEqual(plan.builder, { kind: 'fixed', config: { engine: 'codex', model: 'gpt-5-codex' } });
});

test('unspecified + TTY → prompt', () => {
  const plan = planSelection(base({ isTTY: true }));
  assert.deepEqual(plan.builder, { kind: 'prompt' });
});

test('unspecified + non-TTY → default (prefer claude-code, per-role model)', () => {
  const plan = planSelection(base());
  assert.deepEqual(plan.builder, { kind: 'default', config: { engine: 'claude-code', model: 'sonnet' } });
  assert.deepEqual(plan.reviewer, { kind: 'default', config: { engine: 'claude-code', model: 'opus' } });
});

test('non-TTY + nothing available → error', () => {
  const none = detected.map((d) => ({ ...d, available: false }));
  const plan = planSelection(base({ detected: none }));
  assert.equal(plan.builder.kind, 'error');
});

test('self-review → reviewer mirrors builder', () => {
  const plan = planSelection(base({ mode: 'self-review' }));
  assert.deepEqual(plan.reviewer, { kind: 'mirror' });
});

test('baseline → reviewer unused (mirror)', () => {
  const plan = planSelection(base({ mode: 'baseline' }));
  assert.deepEqual(plan.reviewer, { kind: 'mirror' });
});

test('engine known but no model + TTY → prompt with engine set', () => {
  const plan = planSelection(base({ builder: { engine: 'local' }, isTTY: true }));
  assert.deepEqual(plan.builder, { kind: 'prompt', engine: 'local' });
});

test('engine known but no model + non-TTY → error', () => {
  const plan = planSelection(base({ builder: { engine: 'local' } }));
  assert.equal(plan.builder.kind, 'error');
});
