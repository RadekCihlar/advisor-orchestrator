import { call, type EngineConfig, type CallResult } from './engines/index.js';

// Four arms, one benchmark question: does the SECOND MODEL help, beyond
// what mere iteration would already buy you — and can we get that help for
// fewer of the expensive reviewer's calls?
//   baseline:    builder, 1 pass, no reviewer at all
//   self-review: builder critiques its OWN output, N passes (same
//                engine+model in both roles — just a config, no special code)
//   advised:     builder + a DIFFERENT reviewer model, reviewed EVERY round
//   escalated:   cheap self-review every round, but the bigger reviewer is
//                invoked at most ONCE per run — the first time self-review
//                isn't satisfied (see the loop below). Aims for advised-grade
//                catches at a fraction of the reviewer's call count.
//   verify:      no LLM reviewer at all — a PROGRAMMATIC verifier (e.g. run the
//                task's tests) is the in-loop signal; failures feed back to the
//                builder to fix. Ground truth, not another model's opinion — the
//                pattern that most reliably beats a solo pass on code/math.
// "advised" only means something if it beats "self-review", not just
// "baseline" — beating baseline alone is confounded with iteration count.
// "escalated" only means something if it keeps advised's catches at
// self-review's cost. "verify" only applies where an automatic verifier exists.
export type Mode = 'baseline' | 'self-review' | 'advised' | 'escalated' | 'verify';

// Single source of truth for valid modes (config + cli validate against this).
export const MODES: readonly Mode[] = ['baseline', 'self-review', 'advised', 'escalated', 'verify'];

export interface RunOptions {
  task: string;
  builder: EngineConfig;
  reviewer: EngineConfig; // ignored in baseline mode
  consults: number; // max revision rounds; baseline always uses 0
  mode: Mode;
  // verify mode only: programmatic check of the builder's output → passed +
  // feedback (e.g. test failures) fed back to the builder. Injected so the
  // runner stays engine/grader-agnostic and unit-testable.
  verifier?: (output: string) => Promise<{ passed: boolean; feedback: string }>;
}

export interface ConsultRound {
  round: number;
  builder: CallResult;
  // The review that produced this round's feedback/approval. In escalated
  // mode this is the bigger reviewer's call, and is null on rounds handled
  // entirely by the cheap self-review below.
  reviewer: CallResult | null;
  // escalated mode only: the cheap builder-as-reviewer self-check done before
  // deciding whether to spend a call on the bigger reviewer. Counted in usage.
  selfReview?: CallResult | null;
  approved: boolean;
  escalated?: boolean; // true if the bigger reviewer was invoked this round
  verify?: { passed: boolean; feedback: string }; // verify mode: the programmatic check's result
  reviewerError?: string;
}

export interface RunResult {
  mode: Mode;
  finalOutput: string;
  rounds: ConsultRound[];
}

const isApproval = (text: string): boolean => text.trim().toUpperCase().startsWith('APPROVED');

const reviewerPromptFor = (task: string, output: string): string =>
  `You are reviewing another AI's work.\n\nTask: ${task}\n\nIts output:\n${output}\n\nGive a short, specific critique of concrete problems only. If it is already correct and complete, respond with exactly "APPROVED" and nothing else.`;

// callFn is injectable so the loop's control flow can be unit-tested without
// spawning a real engine (see runner.test.ts). Production callers use the
// default — the real engine dispatcher.
export async function run(opts: RunOptions, callFn: typeof call = call): Promise<RunResult> {
  const maxConsults = opts.mode === 'baseline' ? 0 : opts.consults;
  const rounds: ConsultRound[] = [];

  let builderOutput = '';
  let feedback = '';
  let hasEscalated = false; // escalated mode: the bigger reviewer fires at most once per run

  for (let round = 0; round <= maxConsults; round++) {
    const builderPrompt =
      round === 0
        ? `Task: ${opts.task}`
        : `Task: ${opts.task}\n\nYour previous attempt:\n${builderOutput}\n\nReviewer feedback:\n${feedback}\n\nRevise your attempt accordingly. Output only the revised attempt.`;

    // Builder failures propagate uncaught: with no builder pass this round,
    // there's nothing to ship, so the whole run legitimately fails here. The
    // caller (cli.ts bench loop) catches per-arm and moves to the next one.
    const builderResult = await callFn(opts.builder, builderPrompt);
    builderOutput = builderResult.text;

    const isLastRound = round === maxConsults;
    let reviewerResult: CallResult | null = null;
    let selfReview: CallResult | null = null;
    let approved = false;
    let escalated = false;
    let verify: { passed: boolean; feedback: string } | undefined;
    let reviewerError: string | undefined;

    if (!isLastRound) {
      if (opts.mode === 'verify') {
        // Programmatic verifier IS the reviewer — no LLM critique, no tokens.
        // Ground truth (e.g. the task's tests); failures feed back to the builder.
        if (opts.verifier) {
          verify = await opts.verifier(builderOutput);
          approved = verify.passed;
          if (!verify.passed) feedback = verify.feedback;
        } else {
          approved = true; // verify mode but no verifier wired — nothing to check
        }
      } else if (opts.mode === 'escalated') {
        const prompt = reviewerPromptFor(opts.task, builderOutput);
        // Cheap self-review first (builder critiques itself — cache stays warm).
        // A failed self-review isn't swallowed: it falls through to escalation,
        // i.e. it's treated as "self couldn't clear it, phone the big reviewer".
        try {
          selfReview = await callFn(opts.builder, prompt);
        } catch {
          selfReview = null;
        }
        const selfApproved = selfReview !== null && isApproval(selfReview.text);

        if (selfApproved) {
          approved = true;
          feedback = selfReview!.text;
        } else if (!hasEscalated) {
          // First time self-review isn't satisfied → spend the one escalation.
          try {
            reviewerResult = await callFn(opts.reviewer, prompt);
            feedback = reviewerResult.text;
            approved = isApproval(feedback);
            escalated = true;
            hasEscalated = true;
          } catch (err) {
            reviewerError = err instanceof Error ? err.message : String(err);
            approved = true; // ship builder output without review
          }
        } else {
          // Escalation already spent this run — keep iterating on cheap
          // self-review feedback until self approves or we hit the last round.
          if (selfReview !== null) feedback = selfReview.text;
          approved = false;
        }
      } else {
        // advised / self-review: a single reviewer call every non-last round.
        // (self-review is just this with reviewer config == builder config.)
        const prompt = reviewerPromptFor(opts.task, builderOutput);
        try {
          reviewerResult = await callFn(opts.reviewer, prompt);
          feedback = reviewerResult.text;
          approved = isApproval(feedback);
        } catch (err) {
          // Reviewer failed (rate limit, upstream error, ...) but the builder
          // pass this round already succeeded — ship it without review instead
          // of throwing away a valid result.
          reviewerError = err instanceof Error ? err.message : String(err);
          approved = true;
        }
      }
    }

    rounds.push({ round, builder: builderResult, reviewer: reviewerResult, selfReview, approved, escalated, verify, reviewerError });

    if (approved) break; // reviewer satisfied — stop early, don't burn remaining consults
  }

  return { mode: opts.mode, finalOutput: builderOutput, rounds };
}
