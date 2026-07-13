import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleMcpMessage, TOOLS, argsForTool, type RunCli } from './mcp.js';

const okCli: RunCli = async (args) => ({ stdout: `ran: ${args.join(' ')}`, stderr: '', code: 0 });

const rpc = (method: string, params?: unknown, id: number | string = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize: protocol version + tools capability + server info', async () => {
  const r = (await handleMcpMessage(rpc('initialize', { protocolVersion: '2024-11-05' }), okCli)) as any;
  assert.equal(r.jsonrpc, '2.0');
  assert.equal(r.id, 1);
  assert.equal(r.result.protocolVersion, '2024-11-05');
  assert.ok(r.result.capabilities.tools);
  assert.equal(r.result.serverInfo.name, 'loupe');
});

test('notifications get no response', async () => {
  assert.equal(await handleMcpMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, okCli), null);
});

test('tools/list: all four tools with schemas', async () => {
  const r = (await handleMcpMessage(rpc('tools/list'), okCli)) as any;
  const names = r.result.tools.map((t: { name: string }) => t.name);
  assert.deepEqual(names.sort(), ['loupe_probe', 'loupe_recommend', 'loupe_run', 'loupe_stats']);
  for (const t of r.result.tools) assert.ok(t.inputSchema.type === 'object', `${t.name} has an object schema`);
});

test('tools/call routes to the CLI and wraps stdout as text content', async () => {
  const r = (await handleMcpMessage(
    rpc('tools/call', { name: 'loupe_stats', arguments: {} }, 'x'),
    okCli,
  )) as any;
  assert.equal(r.id, 'x');
  assert.equal(r.result.isError, false);
  assert.match(r.result.content[0].text, /^ran: stats --json/);
});

test('tools/call: nonzero exit → isError true with stderr in the text', async () => {
  const failCli: RunCli = async () => ({ stdout: '', stderr: 'boom', code: 1 });
  const r = (await handleMcpMessage(rpc('tools/call', { name: 'loupe_stats', arguments: {} }), failCli)) as any;
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /boom/);
});

test('unknown method → -32601; unknown tool → error result', async () => {
  const r = (await handleMcpMessage(rpc('resources/list'), okCli)) as any;
  assert.equal(r.error.code, -32601);
  const bad = (await handleMcpMessage(rpc('tools/call', { name: 'nope', arguments: {} }), okCli)) as any;
  assert.equal(bad.result.isError, true);
});

test('argsForTool: loupe_run maps task + flags, booleans do not take values', () => {
  const args = argsForTool('loupe_run', {
    task: 'write a haiku',
    mode: 'advised',
    builder_engine: 'local',
    builder_model: 'qwen2.5:3B',
    consults: 3,
    lean: true,
  });
  assert.deepEqual(args, [
    'run',
    'write a haiku',
    '--json',
    '--mode',
    'advised',
    '--builder-engine',
    'local',
    '--builder-model',
    'qwen2.5:3B',
    '--consults',
    '3',
    '--lean',
  ]);
});

test('argsForTool: loupe_recommend requires reviewers', () => {
  assert.throws(() => argsForTool('loupe_recommend', {}), /reviewers/);
  assert.deepEqual(argsForTool('loupe_recommend', { reviewers: 'codex/auto', force: true }), [
    'recommend',
    '--reviewers',
    'codex/auto',
    '--force',
  ]);
});
