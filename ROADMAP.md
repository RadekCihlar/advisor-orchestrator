# loupe — Roadmap v3

v1 (2026-07-07 → 2026-07-12) and v2 (2026-07-12 → 2026-07-13) shipped in
full — archived in [`docs/CHANGELOG.md`](docs/CHANGELOG.md) §25–§32. v2
delivered: codex live, significance + cost-aware verdicts, the reviewer
probe, the hard pack, the lean protocol + prompt caching, the reviewer
matrix, and `recommend`.

loupe's job is unchanged: tell you whether a reviewer / verify loop is worth
it for **your** tasks, across providers. The feature core of that niche is
built. v3's leverage is elsewhere: **sharper statistics** (the verdict IS the
product), **evidence at scale**, and **reach**. If an idea doesn't sharpen a
verdict, accumulate evidence, or put loupe where users already are, it's
probably a non-goal.

## The findings loupe must protect (why it exists)

From real runs this project already produced:

- **Review helps only when the reviewer is stronger than the builder** — weak
  builder solo 0/3 → stronger reviewer 2/3.
- **Self-review can't rescue a weak model** — it can't catch its own bug.
- **Strong models on easy tasks gain nothing** from review — pure added cost.
- **`verify` (run the tests) is the cheapest reliable check for code.**
- **A too-weak reviewer is worse than no reviewer** (live 2026-07-12): a 3B
  reviewer APPROVED code that crashes on its first call. A rubber-stamp
  converts broken output into *approved* broken output.
- **A too-weak builder can't execute the fixes it can describe** (live
  2026-07-12): 0.5b re-shipped byte-identical broken code with a fabricated
  changelog. Feedback quality doesn't matter below the builder's capability
  floor.
- **Reviewers below the builder's level actively subtract** (live matrix,
  2026-07-13): 0.5b builder baseline 0.40 → 0.20 advised by EITHER local
  reviewer, at 2–15× the cost. The matrix picked "none" — correctly.
- **Protocol changes are pairing-dependent** (lean A/B, 2026-07-13): lean
  advised +0.07 score at −39% tokens, but lean self-review −0.30 — a weak
  model re-reviewing its own diff gets worse. Never flip a default without
  the A/B.

## Now — sharper statistics `[better]`

13. ✅ **DONE — Paired significance** `[better]` — the significance read now
    pairs per-task differences between the top two arms (task-difficulty
    variance cancels), falling back to Welch when <2 shared tasks. "clear at
    this n (paired across 4 tasks, t≈…)" (2026-07-13).

14. ✅ **DONE — Stratified verdict** `[better]` — "Where review pays
    (advised vs baseline): parse +0.50 · luhn ±0.00 · roman −0.10 → pays on
    1/3 tasks" — per-task Δ of the best non-baseline arm, in every report
    with ≥2 shared graded tasks (2026-07-13).

15. ✅ **DONE — Adaptive repeats** `[better]` — `bench --until-clear
    [--max-repeat N]` (default 10): adds repeat-waves only while the top two
    arms are statistically inseparable. Stop signal = the exported
    `separation()` (paired-first) (2026-07-13).

16. ✅ **DONE — `loupe stats`** `[useful]` — usage.jsonl → runs, tokens,
    est. $, per-pairing rounds/approval/flag rates, last run. `--json` is a
    stable document for statuslines/scripts (docs/INTEGRATIONS.md has
    one-liners) (2026-07-13).

## Next — evidence & reach `[useful]`

17. **Pack ecosystem** · S — `--tasks <url>` (fetch a task file over HTTPS),
    a documented pack-format spec (PACKS.md), and a contrib guide. Domain
    packs (sql, regex, shell, frontend) are the cheapest way for the
    community to extend loupe's usefulness without touching the core.

18. ✅ **DONE — MCP server** `[useful]` — `loupe mcp`: zero-dep stdio
    JSON-RPC server (initialize / tools/list / tools/call / ping) exposing
    loupe_run, loupe_probe, loupe_recommend, loupe_stats. Tool calls
    re-spawn the CLI per call. Live-verified over stdio. Per-client setup —
    Cursor, Codex CLI, Claude Code/Desktop, generic — in
    docs/INTEGRATIONS.md, plus a no-MCP instruction block (2026-07-13).

19. **Shareable evidence** · M — `loupe report results.json --md`: render a
    `bench --out` bundle as a markdown table for READMEs, PRs, and issues.
    Community reviewer-matrix knowledge ("who reviews whom well") grows from
    people pasting these. Gate: first real request for it.

## Later — the level after that

20. ✅ **DONE (v1) — Tasks from your own repo** `[useful]` — `loupe tasks
    from-repo [dir]`: lifts literal-argument assertions (assert.equal/
    deepEqual/ok/throws, expect().toBe/.toEqual) from existing tests into
    self-contained exec checks attributed to exactly one exported function,
    pairs them with that function's signature + JSDoc, writes a task pack.
    Fixture-based tests are skipped AND reported — v1 takes only what it can
    guarantee is self-contained. Dogfooded on loupe's own src: 3 tasks
    mined, ground-truth proven both ways (real impl 1.0, mutated impl <1)
    (2026-07-13). v2 (gated on demand): fixture inlining, more runners.

21. ✅ **DONE (v1) — Pairing-evidence priors** `[better]` —
    `benchmark/evidence.json`: curated, provenance-tagged findings from live
    runs (every entry carries note + n + source + date); probe/recommend
    print matching priors BEFORE spending tokens. Priors inform, runs decide
    — nothing is skipped on a prior alone. Community submissions remain
    gated on a reproducibility story; without it, priors are misinformation
    (2026-07-13).

22. ✅ **DONE — Drift watch** `[useful]` — `bench --baseline last.json`:
    paired per-task comparison of each arm against a saved bundle; REGRESSED
    only when the drop is consistent (t≥2), improvement and noise named as
    such; non-zero exit on regression → cron/CI alarm (2026-07-13).

23. ✅ **DONE — Multiple-comparison guard** `[better]` — matrix sweeps pass
    k into `separation()`: Bonferroni-style bar (t≥2 at k=1 up to ≥2.81 at
    k=10), inconclusive lines say "under k comparisons (need t≥X)", and
    matrix picks with k≥3 carry the luck warning (2026-07-13).

## The cap — named

After #20–#23 this niche is genuinely saturated. Everything beyond is a
different product: multi-model committees and routing (agent-framework
territory), hosted dashboards and trace stores (eval-platform territory —
Braintrust/LangSmith already live there), or model leaderboards (research
publishing, not tooling). loupe wins by being the sharpest possible answer
to ONE question — "is this second model worth it, for my tasks, at what
cost?" — and by refusing to become a platform around it.

## Carried from v2 — gates unchanged

1. **Live-verify `anthropic-api` / `openai-api` + pricing** · S — one run +
   one bench task per engine with a real key; compare `$` estimates against
   provider usage numbers; also live-proves the prompt-caching split
   (CHANGELOG §31). Blocked on: a key in the env. Multi-turn conversation
   caching folds in here too.

7. **Judge calibration** · M — run `judge` alongside `exec` on the coding
   packs, report agreement. Gate: someone actually using judge-graded
   workloads.

9. **Release automation** · S — `npm version` + tag → CI publish with a
   granular npm token. Gate: publish cadence makes the manual passkey step
   annoying (it isn't yet).

9b. **List the Action on the GitHub Marketplace** · S — branding shipped in
    action.yml; the listing is a manual step: draft a GitHub release and
    tick "Publish this Action to the Marketplace".

10. **Unwired config knobs from the design** · M — `frequency:
    on-low-confidence`, `consult_context: full-history`,
    `token_budget`/`saver`. Build each only when a workload needs it.

## Cleaner — tech-debt paydown

- **e2e coverage for `bench --parallel` quiet path** · S — the pool is
  unit-tested; the N>1 tagged-line path is only smoke-tested.
- **README warning: exec packs run model-generated code** · S — grader.ts
  documents the subprocess+timeout ceiling (no fs/network sandbox); the
  README should say it where users pick up third-party task files: treat
  packs from strangers like code from strangers.

## Non-goals (still)

- >2-model panels / committees — loupe is pairwise. If it needs an org chart
  of models, it's a different product.
- A GUI — CLI + JSON is the surface.
- Becoming an agent framework — the builder is a toolless call, on purpose.
- Prompt-engineering advice — loupe measures; it doesn't editorialize.

---

*Contributions welcome: pick a `Now`/`Next` item, keep the test + typecheck
green (`npm test && npm run typecheck`), and open a PR.*
