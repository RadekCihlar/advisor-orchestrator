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
- **A too-weak reviewer is worse than no reviewer** (live 2026-07-12):
  qwen2.5:3B APPROVED 0.5b-built code that crashes on its first call, while
  codex rejected it every round with concrete reasons. A rubber-stamp converts
  broken output into *approved* broken output.
- **A too-weak builder can't execute the fixes it can describe** (live
  2026-07-12): 0.5b re-shipped byte-identical broken code with a fabricated
  changelog claiming the reviewer's fixes were applied. Feedback quality
  doesn't matter below the builder's capability floor.

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

2. ✅ **DONE — exercise the GitHub Action from a caller workflow** `[useful]` —
   `.github/workflows/action-test.yml` consumes `uses: RadekCihlar/Loupe@master`
   as a real caller (resolved from origin, not a local path): a pass job runs
   the reasoning pack through Ollama on the runner (no key secret needed) and
   the gate exits 0; a fail job proves a bogus engine's non-zero exit fails the
   caller job. Verified 2026-07-12, both jobs green. Still untested: key
   pass-through via `env:` (needs an `ANTHROPIC_API_KEY` secret — folds into
   #1) (design §28).

3. ✅ **DONE — Codex engine live** `[useful]` — codex-cli 0.144.1 run live
   2026-07-12. Two spawning bugs found and fixed (the parser held): execFile's
   open stdin pipe hung codex indefinitely → shared `runBin` spawn helper
   (`src/engines/spawn.ts`, also adopted by claude-code, killing its ~3s/call
   stdin wait); ChatGPT-subscription auth 400s on every explicit `-m` → model
   `'auto'` default omits the flag. Five live cross-provider runs completed
   (codex reviewer × local/claude builders) — see CHANGELOG §29.

## Next — sharper verdicts `[better]`

The report currently crowns the best mean. With n=3–5 that can be noise, and
"best quality" can hide "second place at 40% of the cost". These make the
verdict trustworthy — the quality core of v2.

4. ✅ **DONE — Significance marker between arms** `[better]` — Welch-style
   top-vs-runner-up separation in the verdict from the stats already
   collected: "clear at this n (t≈7.3)" or "inconclusive at this n, run ~N
   more repeats". Own math, no stats dependency (2026-07-12).

5. ✅ **DONE — Cost-aware verdict** `[better]` — the verdict now quantifies the
   trade when a cheaper arm sits within ε of the best: "self-review matches
   advised within 0.01 at 0.1× its tokens — the cost-aware pick"
   (2026-07-12).

6. ✅ **DONE — A pack with headroom (`hard`)** `[better]` —
   `benchmark/packs/hard.json`: semver prerelease precedence, ISO-8601
   duration with the months trap, interval merge with a no-mutation check,
   RFC-4180 CSV quoting. Every grader proven both ways in packs.test.ts:
   reference scores 1.0, a plausible-buggy solution scores <1 (2026-07-12).

11. ✅ **DONE — Reviewer catch-rate probe** `[better]` — `loupe probe`: feeds
    the reviewer 5 planted-defect + 5 correct fixtures (benchmark/probe.json,
    including the exact output a 3B reviewer rubber-stamped live) through the
    real reviewer prompt; reports catch rate, false-alarm rate, and a verdict
    with a loud rubber-stamp warning. Live-verified both directions:
    codex/auto → trustworthy (5/5, 0 false alarms); qwen2.5:0.5b →
    rubber-stamp (0/5) (2026-07-12).

12. ✅ **DONE — Lean protocol + prompt caching** `[useful]` — `--lean`
    (run + bench): round ≥1 re-reviews send prior critique + a line-diff of
    the revision instead of the full output, with whole-prompt economy (send
    whichever prompt is smaller — a live 3B run proved the delta can lose on
    short outputs) and a 1500-char critique cap; round 0 and verify feedback
    untouched. Plus `cache_control` on the stable task prefix for
    anthropic-api via CallOpts metadata. A/B harness = existing
    `bench --out` × `loupe diff`. Live-verified on local 3B (CHANGELOG §31,
    2026-07-13). A/B on the coding pack (n=8/arm): advised +0.07 score at
    −39% tokens, but self-review −0.30 (weak model re-reviewing its own diff)
    with a ±0.10 noise floor — so lean STAYS opt-in; A/B your own workload
    before flipping it on for self-review pairings.

## Later — gated until something needs them

7. **Judge calibration** `[better]` · M — run the `judge` grader alongside
   `exec` on the coding packs and report agreement. Answers "can I trust the
   judge on tasks that can't be exec-graded?". Gate: someone actually using
   judge-graded workloads.

8. ✅ **DONE — Reviewer-matrix sweep + `recommend`** `[useful]` —
   `bench --reviewers "engine/model,…"`: advised arm per candidate against a
   shared baseline control, reported through the existing aggregate/verdict
   machinery (arms labeled `advised@engine/model`), with a "Matrix pick"
   line: cheapest reviewer within ε of the best — or none when baseline
   matches them. Plus `loupe recommend`: probe-gates the candidates
   (rubber-stamps eliminated so they can't win on price), mini-benches the
   survivors, writes the pick to loupe.config.json (2026-07-13).

9. **Release automation** `[useful]` · S — `npm version` + tag → CI publish
   with a granular npm token. Gate: publish cadence makes the manual passkey
   step annoying (it isn't yet).

9b. **List the Action on the GitHub Marketplace** `[useful]` · S — branding
    (icon/color) shipped in action.yml; the listing itself is a manual step:
    draft a GitHub release and tick "Publish this Action to the Marketplace".

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
