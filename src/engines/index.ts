import { callLocal, type CallResult as LocalResult } from './local.js';
import { callClaudeCode, type CallResult as ClaudeCodeResult } from './claude-code.js';

export interface EngineConfig {
  engine: 'local' | 'claude-code';
  model: string;
}

export type CallResult = LocalResult | ClaudeCodeResult;

export async function call(cfg: EngineConfig, prompt: string): Promise<CallResult> {
  if (cfg.engine === 'local') {
    return callLocal(cfg.model, prompt);
  }
  return callClaudeCode(cfg.model, prompt);
}
