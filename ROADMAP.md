# loupe — Roadmap

loupe's job: tell you whether a reviewer / verify loop is worth it for **your**
tasks, across providers. This roadmap is ordered by **leverage** — correctness
and usefulness first, polish later. Each item is tagged `[better]` (capability),
`[cleaner]` (code/debt), or `[useful]` (product/adoption), with a rough effort.

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

## Now — highest leverage, mostly small

1. **CI: test + typecheck on every push** `[cleaner]` · S — GitHub Actions running
   `npm ci && npm run typecheck && npm test`. Locks in the green state. *(landed
   alongside this roadmap.)*

2. ✅ **DONE — neutralized ambient output-style contamination** `[better]` — the
   spawned `claude-code` builder inherited the caller's user-global output style
   and appended `★ Insight` prose that broke the `exec` grader and polluted
   benchmarks. Fixed with `--setting-sources project,local` so the builder runs
   vanilla; verified no `★` across live runs (design §23). `extractCode` stays as
   a light safety net for ordinary markdown fences.

3. **Real task packs with `exec` graders** `[useful]` · M — the eval is only as
   good as its tasks. Ship `benchmark/packs/{coding,reasoning,constraint}.json`
   with ground-truth tests, so `loupe bench --pack coding` works out of the box
   and actually has headroom (not tasks strong models already ace).

4. **Per-assertion `exec` scoring + targeted feedback** `[better]` · M — score =
   fraction of checks passing (not binary); in `verify`, feed the *specific*
   failing assertion back to the builder. Richer signal, better fix loop.

## Next

5. **Direct-API engines (`anthropic-api`, `openai-api`)** `[useful]` · M — key-based
   engines so loupe runs in CI/services without a provider CLI. Resolves the
   "standalone but CLI-only" tension. Secrets via env only; `setup` detects keys.

6. **Global install / `bin` + npm publish** `[useful]` · M — `loupe setup` /
   `loupe run` instead of `npx tsx src/cli.ts`. Add a `bin` + a build/bundle step
   so `npm i -g loupe` / `npx loupe` works.

7. **Statistical rigor** `[better]` · S — repeats + mean±stddev / CI in the report
   and JSON; flag when n is too small to conclude. Stops n=1–3 from reading as
   signal.

8. **Results history + diff** `[useful]` · M — `loupe diff a.json b.json`: did my
   prompt/model change help? Timestamped result store.

9. **A reusable GitHub Action** `[useful]` · S — so teams gate prompt/model changes
   with `bench --fail-under` on PRs.

## Later

10. **Parallel bench** (bounded concurrency) `[better]` · S — wall-clock; bench is
    sequential today.
11. **§9 self-uncertainty marker** (`<<needs-review>>`) `[better]` · M — builder
    flags its own uncertainty to trigger review out of schedule.
12. **Unwired config knobs from the design** `[better]` · M — `frequency:
    on-low-confidence`, `consult_context: full-history`, `token_budget`/`saver`.
    Build each only when a workload needs it (YAGNI).
13. **Real-$ cost** `[useful]` · S — per-provider pricing table; show dollars beside
    tokens, normalized for free/local vs metered.

## Cleaner — tech-debt paydown

- **Split `cli.ts`** `[cleaner]` · M — it holds dispatch + every command + prompts.
  Extract `src/commands/{run,bench,setup,providers}.ts` behind a thin dispatcher;
  smaller, more testable files.
- **Split the 22-section `docs/design.md`** `[cleaner]` · S — into `ARCHITECTURE.md`
  (current design) + `CHANGELOG.md` (history). It's a session log now. Trim the
  pre-build spec that restates shipped interfaces (rot risk).
- **End-to-end integration test** `[cleaner]` · S — one full `bench` run with an
  injected fake engine. Unit tests cover the pieces, not the whole flow.
- **Align Node version** `[cleaner]` · S — `engines: >=24` vs actually tested on 22;
  pick one and document it.
- **Replace `extractCode` heuristics** `[cleaner]` · S — once #2 fixes contamination
  at the source, drop the whack-a-mole prose-stripping for a fence-preferred,
  validated extractor.

## Non-goals (for now)

- >2-model panels / committees — loupe is pairwise.
- A GUI — CLI + JSON is the surface.
- Becoming an agent framework — the builder is a toolless call, on purpose.

---

*Contributions welcome: pick a `Now`/`Next` item, keep the test + typecheck green
(`npm test && npm run typecheck`), and open a PR.*
