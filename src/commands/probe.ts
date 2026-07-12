import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectAll, getEngine, isKnownEngine, KNOWN_ENGINES } from '../engines/index.js';
import { planSelection } from '../selection.js';
import { formatProbeReport, probeReviewer, validateProbeItems } from '../probe.js';
import { loadConfigAuto, repoRoot, resolveDecision, roleInputFrom, type Flags } from './shared.js';

// `loupe probe` (ROADMAP #11): measure a reviewer's defect catch rate against
// planted-bug fixtures BEFORE trusting it in advised/escalated runs.
export async function cmdProbe(flags: Flags): Promise<void> {
  const probePath = typeof flags.probe === 'string' ? flags.probe : join(repoRoot, 'benchmark', 'probe.json');
  let items;
  try {
    items = validateProbeItems(JSON.parse(readFileSync(probePath, 'utf8')));
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const e = flags['reviewer-engine'];
  if (typeof e === 'string' && !isKnownEngine(e)) {
    console.error(`Error: unknown reviewer engine "${e}". Known: ${KNOWN_ENGINES.join(', ')}`);
    process.exit(1);
  }

  // Resolve ONLY the reviewer (flags > config > detected default); the probe
  // has no builder role. planSelection wants both, so feed the reviewer input
  // to both slots and read back the reviewer decision.
  const cfg = loadConfigAuto(flags);
  const detected = await detectAll();
  const reviewerInput = roleInputFrom(flags, 'reviewer');
  const plan = planSelection({
    builder: reviewerInput,
    reviewer: reviewerInput,
    config: { builder: cfg.reviewer, reviewer: cfg.reviewer },
    detected,
    isTTY: false, // scriptable: resolve or fail loudly, never hang on a prompt
    mode: 'advised',
    defaultModelFor: (engine, role) => getEngine(engine).defaultModels[role],
  });
  const reviewer = await resolveDecision(null, 'reviewer', plan.reviewer, detected);

  console.error(`Probing ${reviewer.engine}/${reviewer.model} with ${items.length} fixture(s) from ${probePath}…`);
  const result = await probeReviewer(items, reviewer);
  console.log(formatProbeReport(reviewer, result));
}
