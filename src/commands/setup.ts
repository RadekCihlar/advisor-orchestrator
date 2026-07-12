import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { call, detectAll, type EngineConfig } from '../engines/index.js';
import type { Mode } from '../runner.js';
import { promptForRole } from './shared.js';

export async function cmdSetup(): Promise<void> {
  const detected = await detectAll();
  console.log('Detected providers:');
  for (const r of detected) console.log(`  ${r.name.padEnd(12)} ${r.available ? '✓' : '✗'}  ${r.detail}`);
  if (!detected.some((d) => d.available)) {
    console.error('\nNo providers usable yet. Set one up, then re-run `setup`:');
    console.error('  - Claude Code CLI:  install it, then `claude login`');
    console.error('  - OpenAI Codex CLI: install it, then `codex login`');
    console.error('  - Ollama:           https://ollama.com, then `ollama pull <model>`');
    process.exit(1);
  }

  console.log('\nChoose engines (press Enter to accept the default).');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let builder: EngineConfig;
  let reviewer: EngineConfig;
  try {
    builder = await promptForRole(rl, 'builder', undefined, detected);
    reviewer = await promptForRole(rl, 'reviewer', undefined, detected);
  } finally {
    rl.close();
  }

  // Live check — non-fatal, but tells you now if auth/quota/region is off.
  for (const [role, cfg] of [
    ['builder', builder],
    ['reviewer', reviewer],
  ] as const) {
    process.stdout.write(`Verifying ${role} ${cfg.engine}/${cfg.model} ... `);
    try {
      await call(cfg, 'Reply with exactly: OK');
      console.log('ok');
    } catch (err) {
      console.log(`could not reach it — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const config = { builder, reviewer, mode: 'advised' as Mode, consults: 2 };
  writeFileSync('loupe.config.json', JSON.stringify(config, null, 2) + '\n');
  console.log('\nWrote loupe.config.json — run/bench auto-load it. Now just:');
  console.log('  npx tsx src/cli.ts run "your task here"');
}
