import { call, type EngineConfig, type CallResult } from './engines/index.js';

// Three arms, one benchmark question: does the SECOND MODEL help, beyond
// what mere iteration would already buy you?
//   baseline:    builder, 1 pass, no reviewer at all
//   self-review: builder critiques its OWN output, N passes (same
//                engine+model in both roles — just a config, no special code)
//   advised:     builder + a DIFFERENT reviewer model, N passes
// "advised" only means something if it beats "self-review", not just
// "baseline" — beating baseline alone is confounded with iteration count.
export type Mode = 'baseline' | 'self-review' | 'advised';

export interface RunOptions {
  task: string;
  builder: EngineConfig;
  reviewer: EngineConfig; // ignored in baseline mode
  consults: number; // max revision rounds; baseline always uses 0
  mode: Mode;
}

export interface ConsultRound {
  round: number;
  builder: CallResult;
  reviewer: CallResult | null;
  approved: boolean;
  reviewerError?: string;
}

export interface RunResult {
  mode: Mode;
  finalOutput: string;
  rounds: ConsultRound[];
}

export async function run(opts: RunOptions): Promise<RunResult> {
  const maxConsults = opts.mode === 'baseline' ? 0 : opts.consults;
  const rounds: ConsultRound[] = [];

  let builderOutput = '';
  let feedback = '';

  for (let round = 0; round <= maxConsults; round++) {
    const builderPrompt =
      round === 0
        ? `Task: ${opts.task}`
        : `Task: ${opts.task}\n\nYour previous attempt:\n${builderOutput}\n\nReviewer feedback:\n${feedback}\n\nRevise your attempt accordingly. Output only the revised attempt.`;

    // Builder failures propagate uncaught: with no builder pass this round,
    // there's nothing to ship, so the whole run legitimately fails here. The
    // caller (cli.ts bench loop) catches per-arm and moves to the next one.
    const builderResult = await call(opts.builder, builderPrompt);
    builderOutput = builderResult.text;

    const isLastRound = round === maxConsults;
    let reviewerResult: CallResult | null = null;
    let approved = false;
    let reviewerError: string | undefined;

    if (!isLastRound) {
      const reviewerPrompt = `You are reviewing another AI's work.\n\nTask: ${opts.task}\n\nIts output:\n${builderOutput}\n\nGive a short, specific critique of concrete problems only. If it is already correct and complete, respond with exactly "APPROVED" and nothing else.`;
      try {
        reviewerResult = await call(opts.reviewer, reviewerPrompt);
        feedback = reviewerResult.text;
        approved = feedback.trim().toUpperCase().startsWith('APPROVED');
      } catch (err) {
        // Reviewer failed (rate limit, upstream error, ...) but the builder
        // pass this round already succeeded — ship it without review instead
        // of throwing away a valid result.
        reviewerError = err instanceof Error ? err.message : String(err);
        approved = true;
      }
    }

    rounds.push({ round, builder: builderResult, reviewer: reviewerResult, approved, reviewerError });

    if (approved) break; // reviewer satisfied — stop early, don't burn remaining consults
  }

  return { mode: opts.mode, finalOutput: builderOutput, rounds };
}
