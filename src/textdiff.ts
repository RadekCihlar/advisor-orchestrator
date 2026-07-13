// Minimal line-level diff backing the lean re-review prompt (--lean): on
// round ≥1 the reviewer gets what CHANGED since its last look instead of the
// full output. Zero deps on purpose (this repo ships none); outputs are at
// most a few hundred lines, so the O(n·m) LCS table is fine.

const CONTEXT = 2; // unchanged lines shown around each change
const HUNK_SEP = '···';
// Above this fraction of changed lines the "delta" is really a rewrite —
// return null and let the caller send the full output instead.
const REWRITE_RATIO = 0.6;

interface Op {
  kind: ' ' | '-' | '+';
  line: string;
}

// Standard LCS walk: longest-common-subsequence lengths, then emit keeps,
// deletions (old-only lines) and additions (new-only lines) in order.
function diffOps(oldLines: string[], newLines: string[]): Op[] {
  const n = oldLines.length;
  const m = newLines.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = oldLines[i] === newLines[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      out.push({ kind: ' ', line: oldLines[i] });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ kind: '-', line: oldLines[i] });
      i++;
    } else {
      out.push({ kind: '+', line: newLines[j] });
      j++;
    }
  }
  while (i < n) out.push({ kind: '-', line: oldLines[i++] });
  while (j < m) out.push({ kind: '+', line: newLines[j++] });
  return out;
}

// '' = no changes; null = change too large to be worth a delta (send full
// output); otherwise hunks of "- old" / "+ new" with CONTEXT unchanged lines
// around each change, hunks separated by HUNK_SEP.
export function lineDiff(oldText: string, newText: string): string | null {
  if (oldText === newText) return '';
  const ops = diffOps(oldText.split('\n'), newText.split('\n'));
  const changed = ops.filter((o) => o.kind !== ' ').length;
  if (changed > REWRITE_RATIO * Math.max(ops.length, 1)) return null;

  const emit = new Array<boolean>(ops.length).fill(false);
  ops.forEach((op, idx) => {
    if (op.kind === ' ') return;
    for (let k = Math.max(0, idx - CONTEXT); k <= Math.min(ops.length - 1, idx + CONTEXT); k++) emit[k] = true;
  });

  const lines: string[] = [];
  let inHunk = false;
  for (let idx = 0; idx < ops.length; idx++) {
    if (!emit[idx]) {
      inHunk = false;
      continue;
    }
    if (!inHunk && lines.length > 0) lines.push(HUNK_SEP);
    inHunk = true;
    lines.push(`${ops[idx].kind} ${ops[idx].line}`);
  }
  const text = lines.join('\n');
  return text.length < newText.length ? text : null; // a delta that isn't smaller is pointless
}
