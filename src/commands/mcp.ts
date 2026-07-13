import { createInterface } from 'node:readline';
import { runBin } from '../engines/spawn.js';
import { handleMcpMessage, type RunCli } from '../mcp.js';

// `loupe mcp` — stdio MCP server. Tool calls re-spawn this same CLI entry as
// a subprocess (clean process-per-call, no in-process command refactor) and
// return its stdout. stdout carries ONLY protocol JSON; humans read stderr.
export async function cmdMcp(): Promise<void> {
  const entry = process.argv[1];
  // Packaged: node dist/cli.js. Dev: tsx src/cli.ts → re-spawn via node
  // --import tsx so argv stays unshelled (task strings contain spaces/quotes).
  const runCli: RunCli = (args) =>
    entry.endsWith('.ts')
      ? runBin(process.execPath, ['--import', 'tsx', entry, ...args], false)
      : runBin(process.execPath, [entry, ...args], false);

  console.error('loupe mcp: serving on stdio (tools: loupe_run, loupe_probe, loupe_recommend, loupe_stats)');
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } })}\n`);
      continue;
    }
    const response = await handleMcpMessage(msg, runCli);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  }
}
