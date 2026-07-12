# loupe — Roadmap v2

v1 shipped in full (2026-07-07 → 2026-07-12) — archived in
[`docs/CHANGELOG.md`](docs/CHANGELOG.md) §25–§28. Only #12 carried over.

loupe's job: tell you whether a reviewer / verify loop is worth it for **your**
tasks, across providers. Ordered by leverage; every item tagged `[better]`
(measurement quality), `[useful]` (product/adoption), or `[cleaner]` (debt),
with a rough effort (S/M/L).

## The finding loupe must protect (why it exists)

From real runs this project already produced:

- **Review helps only when the reviewer is stronger than the builder** — weak
  builder solo 0/3 → stronger reviewer 2/3.
- **Self-review can't rescue a weak model** — it can't catch its own bug.
- **Strong models on easy tasks gain nothing** from review — pure added cost.
- **`verify` (run the tests) is the cheapest reliable check for code.**

Every roadmap item should sharpen loupe's ability to turn that folklore into a
per-workload measurement. If an item doesn't, it's probably a non-goal.

---

## Now — close the honesty gap

Everything here is shipped code the README currently has to hedge about.
Closing these converts "written to spec" into "verified live".

1. **Live-verify `anthropic-api` / `openai-api` + the pricing table**
   `[useful]` · S — one `loupe run` and one bench task per engine with a real
   key; compare the `$` estimate against the provider's own usage numbers.
   Blocked on: a key in the env.

2. **Exercise the GitHub Action from a caller workflow** `[useful]` · S — a
   minimal repo that `uses: RadekCihlar/Loupe@master` with a pack + fail-under,
   confirming inputs, key pass-through, and the gate's exit code. Blocked on:
   repo public + master pushed + `ANTHROPIC_API_KEY` secret in the caller.

3. **Codex engine live** `[useful]` · S — run the existing `codex` engine
   against a real CLI. Blocked on: codex not installed on the dev machine
   (`npm i -g @openai/codex && codex login`).

## Next — sharper verdicts `[better]`

The report currently crowns the best mean. With n=3–5 that can be noise, and
"best quality" can hide "second place at 40% of the cost". These make the
verdict trustworthy — the quality core of v2.

4. **Significance marker between arms** `[better]` · M — pairwise
   overlap/effect-size hint next to the verdict ("advised +0.33 vs
   self-review; stddevs overlap at this n — inconclusive, run ~N more
   repeats"). Own math (CI overlap or Welch-style), no stats dependency. The
   small-n warning was the v1 stub; this is the real thing.

5. **Cost-aware verdict** `[better]` · S — alongside "best quality", report
   quality-per-cost and call out the cheapest arm within ε of the best score
   ("self-review matches advised within 0.05 at 0.4× tokens"). Data already
   exists (meanCostUsd, token totals) — this is a report change only.

6. **A pack with headroom (`hard`)** `[better]` · M — current packs saturate:
   a strong builder aces baseline and every arm ties at "no gain, higher
   cost". Build a pack calibrated so a strong solo builder lands ~0.5–0.8
   (edge-case-dense exec tasks, multi-constraint outputs), leaving room for
   review to visibly help or not. Prove graders against reference solutions
   like the v1 packs.

## Later — gated until something needs them

7. **Judge calibration** `[better]` · M — run the `judge` grader alongside
   `exec` on the coding packs and report agreement. Answers "can I trust the
   judge on tasks that can't be exec-graded?". Gate: someone actually using
   judge-graded workloads.

8. **Reviewer-matrix sweep** `[useful]` · L — `bench --matrix` over
   builder×reviewer pairs to find the cheapest reviewer that still helps.
   Gate: a real multi-candidate decision to make; until then it's #1/#5 run a
   few times by hand.

9. **Release automation** `[useful]` · S — `npm version` + tag → CI publish
   with a granular npm token. Gate: publish cadence makes the manual passkey
   step annoying (it isn't yet).

10. **Unwired config knobs from the design** `[better]` · M — carried from v1:
    `frequency: on-low-confidence`, `consult_context: full-history`,
    `token_budget`/`saver`. Build each only when a workload needs it (YAGNI).

## Cleaner — tech-debt paydown

- **e2e coverage for `bench --parallel` quiet path** `[cleaner]` · S — the
  pool is unit-tested and sequential bench is e2e-tested; the N>1 tagged-line
  path is only smoke-tested. One test through the fake engine with
  `--parallel 2`.

## Non-goals (for now)

- >2-model panels / committees — loupe is pairwise.
- A GUI — CLI + JSON is the surface.
- Becoming an agent framework — the builder is a toolless call, on purpose.

---

*Contributions welcome: pick a `Now`/`Next` item, keep the test + typecheck
green (`npm test && npm run typecheck`), and open a PR.*
