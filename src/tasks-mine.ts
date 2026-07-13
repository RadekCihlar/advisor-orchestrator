// Task miner (ROADMAP v3 #20, v1): turn a repo's OWN tests into an
// exec-graded task pack — the benchmark becomes literally your workload,
// with zero task-authoring. v1 is deliberately narrow and honest about it:
// it lifts only assertions whose arguments are pure literals calling exactly
// one user function (the only kind that is guaranteed self-contained when
// re-run against a model's reimplementation). Everything else is skipped and
// reported, never guessed at.

export interface LiftedCheck {
  fn: string; // the single user function the check exercises
  check: string; // one self-contained line for the exec grader
}

export interface MinedTask {
  id: string;
  prompt: string;
  grader: { type: 'exec'; language: 'node'; tests: string };
}

// Identifiers that may appear bare in a lifted expression without breaking
// self-containment. Anything else bare (test fixtures, helpers) → skip.
const ALLOWED = new Set([
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
  'JSON', 'Math', 'Number', 'String', 'Array', 'Object', 'Boolean', 'new',
]);
// Callable names that are harness noise, never the function under test.
const NOT_TARGETS = new Set(['assert', 'expect', ...ALLOWED]);

const stripStrings = (s: string): string => s.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g, "''");

// Balanced-paren argument capture starting AT the opening paren index.
// Returns the inner text and the index after the closing paren, or null.
function captureArgs(src: string, openIdx: number): { inner: string; end: number } | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = openIdx; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return { inner: src.slice(openIdx + 1, i), end: i + 1 };
    }
  }
  return null;
}

// Split an argument list at top-level commas (paren/bracket/brace + string aware).
function splitTopLevel(args: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = '';
  for (let i = 0; i < args.length; i++) {
    const ch = args[i];
    if (quote) {
      cur += ch;
      if (ch === '\\') {
        cur += args[i + 1] ?? '';
        i++;
      } else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

// The single non-builtin function the expression calls, or null when zero or
// several (composition — not guaranteed self-contained, v1 skips it).
function targetOf(exprs: string[]): string | null {
  const called = new Set<string>();
  let bareNonCall = false;
  for (const e of exprs) {
    const clean = stripStrings(e);
    for (const m of clean.matchAll(/(\.)?\s*\b([A-Za-z_$][\w$]*)\b\s*(\()?/g)) {
      const [, dot, name, paren] = m;
      if (dot) continue; // property/method access — fine
      if (paren) {
        if (!NOT_TARGETS.has(name)) called.add(name);
      } else if (!ALLOWED.has(name)) {
        bareNonCall = true; // a test-local variable — not self-contained
      }
    }
  }
  if (bareNonCall || called.size !== 1) return null;
  return [...called][0];
}

const msg = (desc: string): string => JSON.stringify(desc.replace(/\s+/g, ' ').slice(0, 100));

function makeCheck(kind: 'eq' | 'deep' | 'ok' | 'throws', args: string[]): string | null {
  if (kind === 'eq' && args.length >= 2) {
    return `if ((${args[0]}) !== (${args[1]})) throw new Error(${msg(`${args[0]} !== ${args[1]}`)});`;
  }
  if (kind === 'deep' && args.length >= 2) {
    return `if (JSON.stringify(${args[0]}) !== JSON.stringify(${args[1]})) throw new Error(${msg(`${args[0]} != ${args[1]}`)});`;
  }
  if (kind === 'ok' && args.length >= 1) {
    return `if (!(${args[0]})) throw new Error(${msg(`${args[0]} was falsy`)});`;
  }
  if (kind === 'throws' && args.length >= 1) {
    const arrow = args[0].match(/^\(\s*\)\s*=>\s*([\s\S]+)$/);
    if (!arrow) return null;
    const expr = arrow[1].trim();
    return `{ let _t = false; try { ${expr}; } catch { _t = true; } if (!_t) throw new Error(${msg(`expected throw: ${expr}`)}); }`;
  }
  return null;
}

const PATTERNS: Array<{ re: RegExp; kind: 'eq' | 'deep' | 'ok' | 'throws' }> = [
  { re: /\bassert\.(?:strictE|e)qual\s*(?=\()/g, kind: 'eq' },
  { re: /\bassert\.deep(?:Strict)?Equal\s*(?=\()/g, kind: 'deep' },
  { re: /\bassert\.ok\s*(?=\()/g, kind: 'ok' },
  { re: /\bassert\.throws\s*(?=\()/g, kind: 'throws' },
];

export function liftChecks(testSource: string): LiftedCheck[] {
  const out: LiftedCheck[] = [];
  for (const { re, kind } of PATTERNS) {
    for (const m of testSource.matchAll(re)) {
      const open = testSource.indexOf('(', m.index! + m[0].length);
      const cap = open >= 0 ? captureArgs(testSource, open) : null;
      if (!cap) continue;
      const args = splitTopLevel(cap.inner);
      const argsForTarget = kind === 'throws' ? [args[0]?.replace(/^\(\s*\)\s*=>/, '') ?? ''] : args.slice(0, 2);
      const fn = targetOf(argsForTarget);
      if (!fn) continue;
      const check = makeCheck(kind, args);
      if (check) out.push({ fn, check });
    }
  }
  // expect(A).toBe(B) / .toEqual(B) / .toStrictEqual(B) / .toBeTruthy()
  for (const m of testSource.matchAll(/\bexpect\s*(?=\()/g)) {
    const open = testSource.indexOf('(', m.index! + m[0].length);
    const capA = open >= 0 ? captureArgs(testSource, open) : null;
    if (!capA) continue;
    const rest = testSource.slice(capA.end);
    const matcher = rest.match(/^\s*\.\s*(toBe|toEqual|toStrictEqual|toBeTruthy)\s*(?=\()/);
    if (!matcher) continue;
    const openB = capA.end + matcher[0].length + rest.slice(matcher[0].length).indexOf('(');
    const capB = captureArgs(testSource, openB);
    if (!capB) continue;
    const kind = matcher[1] === 'toBe' ? 'eq' : matcher[1] === 'toBeTruthy' ? 'ok' : 'deep';
    const args = kind === 'ok' ? [capA.inner] : [capA.inner, capB.inner];
    const fn = targetOf(kind === 'ok' ? [capA.inner] : args);
    if (!fn) continue;
    const check = makeCheck(kind, args);
    if (check) out.push({ fn, check });
  }
  return out;
}

export interface ExtractedFn {
  signature: string;
  jsdoc: string | null;
}

export function extractFunction(source: string, name: string): ExtractedFn | null {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const fnRe = new RegExp(`(\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?export\\s+(?:async\\s+)?(function\\s+${esc}\\s*\\([^)]*\\)\\s*(?::[^{]*)?)\\{`);
  const fnMatch = source.match(fnRe);
  if (fnMatch) return { signature: fnMatch[2].trim(), jsdoc: fnMatch[1]?.trim() ?? null };
  const arrowRe = new RegExp(`(\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?export\\s+const\\s+(${esc}\\s*=\\s*(?:async\\s+)?\\([^)]*\\)\\s*(?::[^=]*)?)=>`);
  const arrowMatch = source.match(arrowRe);
  if (arrowMatch) return { signature: `${arrowMatch[2].trim()} =>`, jsdoc: arrowMatch[1]?.trim() ?? null };
  return null;
}

export interface NamedFile {
  path: string;
  content: string;
}

export function mineTasks(
  testFiles: NamedFile[],
  sourceFiles: NamedFile[],
): { tasks: MinedTask[]; skipped: string[] } {
  const byFn = new Map<string, string[]>();
  for (const f of testFiles) {
    for (const { fn, check } of liftChecks(f.content)) {
      const list = byFn.get(fn);
      if (list) list.push(check);
      else byFn.set(fn, [check]);
    }
  }
  const tasks: MinedTask[] = [];
  const skipped: string[] = [];
  for (const [fn, checks] of byFn) {
    if (checks.length < 2) {
      skipped.push(`${fn}: only ${checks.length} self-contained check(s) — need ≥2 for a meaningful grade`);
      continue;
    }
    let found: ExtractedFn | null = null;
    for (const s of sourceFiles) {
      found = extractFunction(s.content, fn);
      if (found) break;
    }
    if (!found) {
      skipped.push(`${fn}: exported signature not found in the scanned sources`);
      continue;
    }
    const spec = `${found.jsdoc ? `${found.jsdoc}\n` : ''}${found.signature}`;
    tasks.push({
      id: `mined-${fn}`,
      prompt: `Implement the JavaScript function \`${fn}\` exactly as specified below. It must be fully standalone (no imports; type annotations in the signature describe the contract — output plain JavaScript).\n\n${spec}\n\nOutput only the code.`,
      grader: { type: 'exec', language: 'node', tests: [...new Set(checks)].join('\n') },
    });
  }
  return { tasks, skipped };
}
