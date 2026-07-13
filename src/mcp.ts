// MCP server protocol layer (ROADMAP v3 #18): exposes loupe to ANY MCP
// client — Cursor, Codex CLI, Claude Code/Desktop, editors — over stdio
// JSON-RPC. Zero deps, same reasoning as every engine: the protocol subset
// loupe needs (initialize / tools/list / tools/call / ping) is ~100 lines.
// Pure message handling here; stdio + subprocess wiring in commands/mcp.ts.

export type RunCli = (args: string[]) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export interface McpTool {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[] };
}

const engineProp = (role: string) => ({
  [`${role}_engine`]: { type: 'string', description: `${role} engine: claude-code | codex | local | anthropic-api | openai-api` },
  [`${role}_model`]: { type: 'string', description: `${role} model (engine default when omitted; codex under ChatGPT auth needs "auto")` },
});

export const TOOLS: McpTool[] = [
  {
    name: 'loupe_run',
    description:
      'Delegate a task to a builder model with a reviewer model judging each round until approved (cross-provider builder+reviewer loop). Returns JSON: finalOutput, rounds (with per-round reviewer verdicts), token usage. The task must be fully self-contained — the models receive no other context.',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'The complete, self-contained task' },
        mode: { type: 'string', description: 'baseline | self-review | advised (default) | escalated' },
        ...engineProp('builder'),
        ...engineProp('reviewer'),
        consults: { type: 'number', description: 'max revision rounds (default 2)' },
        lean: { type: 'boolean', description: 'cheaper re-reviews: prior critique + diff instead of full output' },
      },
      required: ['task'],
    },
  },
  {
    name: 'loupe_probe',
    description:
      'Measure a reviewer model BEFORE trusting it: feeds planted-defect + known-correct outputs through the real review prompt and reports catch rate, false-alarm rate, and a verdict (trustworthy / unreliable / over-critical / rubber-stamp). A rubber-stamp reviewer is worse than no reviewer.',
    inputSchema: { type: 'object', properties: { ...engineProp('reviewer') } },
  },
  {
    name: 'loupe_recommend',
    description:
      'Pick the best reviewer from candidates: probe-gates them (rubber-stamps eliminated), mini-benches survivors against a no-reviewer baseline, writes the cheapest trustworthy pick to loupe.config.json — or reports that no reviewer earns its keep.',
    inputSchema: {
      type: 'object',
      properties: {
        reviewers: { type: 'string', description: 'comma-separated candidates, e.g. "codex/auto,local/qwen2.5:3b"' },
        pack: { type: 'string', description: 'task pack for the mini-bench (default coding)' },
        repeat: { type: 'number', description: 'repeats per task (default 2)' },
        ...engineProp('builder'),
        force: { type: 'boolean', description: 'overwrite an existing loupe.config.json' },
      },
      required: ['reviewers'],
    },
  },
  {
    name: 'loupe_stats',
    description: 'Local run history from usage.jsonl: runs, tokens, estimated $, per-pairing approval rates, last run. JSON.',
    inputSchema: { type: 'object', properties: {} },
  },
];

// Tool arguments → CLI argv. Throws on missing required fields so the caller
// can surface a proper tool error instead of a confused CLI usage dump.
export function argsForTool(name: string, a: Record<string, unknown>): string[] {
  const flag = (args: string[], cliName: string, v: unknown): void => {
    if (v === undefined || v === null || v === false) return;
    if (v === true) args.push(`--${cliName}`);
    else args.push(`--${cliName}`, String(v));
  };
  const roleFlags = (args: string[], roles: string[]): void => {
    for (const role of roles) {
      flag(args, `${role}-engine`, a[`${role}_engine`]);
      flag(args, `${role}-model`, a[`${role}_model`]);
    }
  };
  switch (name) {
    case 'loupe_run': {
      if (typeof a.task !== 'string' || !a.task) throw new Error('loupe_run needs a task');
      const args = ['run', a.task, '--json'];
      flag(args, 'mode', a.mode);
      roleFlags(args, ['builder', 'reviewer']);
      flag(args, 'consults', a.consults);
      flag(args, 'lean', a.lean);
      return args;
    }
    case 'loupe_probe': {
      const args = ['probe'];
      roleFlags(args, ['reviewer']);
      return args;
    }
    case 'loupe_recommend': {
      if (typeof a.reviewers !== 'string' || !a.reviewers) throw new Error('loupe_recommend needs reviewers ("engine/model,…")');
      const args = ['recommend', '--reviewers', a.reviewers];
      flag(args, 'pack', a.pack);
      flag(args, 'repeat', a.repeat);
      roleFlags(args, ['builder']);
      flag(args, 'force', a.force);
      return args;
    }
    case 'loupe_stats':
      return ['stats', '--json'];
    default:
      throw new Error(`unknown tool "${name}"`);
  }
}

interface RpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: { name?: string; arguments?: Record<string, unknown>; [k: string]: unknown };
}

const result = (id: RpcMessage['id'], res: unknown) => ({ jsonrpc: '2.0', id: id ?? null, result: res });
const error = (id: RpcMessage['id'], code: number, message: string) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

// One request in, one response out (null for notifications). runCli is
// injected: production spawns the loupe CLI; tests fake it.
export async function handleMcpMessage(raw: unknown, runCli: RunCli): Promise<object | null> {
  const msg = raw as RpcMessage;
  if (!msg || typeof msg.method !== 'string') return error(msg?.id, -32600, 'invalid request');
  if (msg.method.startsWith('notifications/')) return null;

  switch (msg.method) {
    case 'initialize':
      return result(msg.id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'loupe', version: '0.2.0' },
      });
    case 'ping':
      return result(msg.id, {});
    case 'tools/list':
      return result(msg.id, { tools: TOOLS });
    case 'tools/call': {
      const name = msg.params?.name ?? '';
      const args = msg.params?.arguments ?? {};
      try {
        const argv = argsForTool(String(name), args);
        const r = await runCli(argv);
        const ok = r.code === 0;
        const text = ok ? r.stdout.trim() || '(no output)' : `exit ${r.code}\n${(r.stderr || r.stdout).trim()}`;
        return result(msg.id, { content: [{ type: 'text', text }], isError: !ok });
      } catch (err) {
        return result(msg.id, {
          content: [{ type: 'text', text: err instanceof Error ? err.message : String(err) }],
          isError: true,
        });
      }
    }
    default:
      return error(msg.id, -32601, `method not found: ${msg.method}`);
  }
}
