#!/usr/bin/env node
// SessionStart hook: inject the loupe delegation instructions into every
// session (ponytail-style always-on context). The plugin ships the whole
// orchestrator, so the CLI path is inside the plugin itself.
const { join } = require('node:path');

const cli = join(__dirname, '..', 'src', 'cli.ts');

console.log(`LOUPE DELEGATION ACTIVE — cross-model build+judge loop available

When the user asks one model to write/build and another to judge ("have opus write it, let ollama judge it"), asks for a second opinion from a cheaper/stronger model, or wants a self-contained task (draft, email, boilerplate, function, schema) delegated with independent review — do NOT hand-roll API/curl calls to models. Run the loupe orchestrator:

  npx tsx "${cli}" run "<fully self-contained task>" --mode escalated --consults 2 --builder-engine claude-code --builder-model opus --reviewer-engine local --reviewer-model <largest model from GET http://localhost:11434/api/tags>

Rules:
- FIRST run: curl -s http://localhost:11434/api/tags — pick the largest pulled model as --reviewer-model. NEVER guess an Ollama model name; an unpulled model fails the review gate.
- Modes: baseline | self-review | advised (reviewer every round) | escalated (self-review each round, bigger reviewer at most once — cheapest) | verify (run tests as the reviewer, code tasks only). Engines: claude-code / codex / local (Ollama) — any model, either role, cross-provider is fine.
- The task prompt must be fully self-contained: engine calls are toolless text completions with no repo/session context. Inline everything the builder needs. Keep the task single-line or write it to a temp file and interpolate.
- The deliverable prints on stdout after the "--- final output ---" line; the usage block below it has rounds and token totals.
- Always report back to the user: rounds used, which model judged, verdict per round, token totals. The user explicitly wants to SEE when advising happened.
- Ollama down or only a <=1b model pulled (tiny models rubber-stamp): use --reviewer-engine claude-code --reviewer-model sonnet instead, and say so.
- Do not use baseline mode for delegation — it skips the judge entirely.`);
