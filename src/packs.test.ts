import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { grade, type Grader } from './grader.js';

const packsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'benchmark', 'packs');
interface PackTask {
  id: string;
  prompt: string;
  grader: Grader;
}
const packs = new Map<string, PackTask[]>(
  readdirSync(packsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => [f, JSON.parse(readFileSync(join(packsDir, f), 'utf8')) as PackTask[]]),
);

test('packs: every task has id, prompt, and a deterministic grader; ids unique', () => {
  assert.ok(packs.size >= 3, 'coding/reasoning/constraint packs exist');
  const seen = new Set<string>();
  for (const [file, tasks] of packs) {
    assert.ok(tasks.length >= 3, `${file} has enough tasks`);
    for (const t of tasks) {
      assert.ok(t.id && !seen.has(t.id), `${file}: duplicate/missing id ${t.id}`);
      seen.add(t.id);
      assert.ok(t.prompt.length > 20, `${t.id}: prompt too short`);
      assert.ok(['exec', 'regex', 'includes'].includes(t.grader.type), `${t.id}: deterministic grader (no judge in packs)`);
      if (t.grader.type === 'regex') new RegExp(t.grader.pattern, t.grader.flags); // throws if invalid
    }
  }
});

// Ground truth: a correct reference answer must score 1.0 on its own grader,
// and a wrong one must not. A pack task failing here has a broken grader, not
// a hard task — this is what keeps "headroom" honest.
const good: Record<string, string> = {
  'coding-parse-range': `function parseRange(s){return s.split(',').map(p=>p.trim()).map(p=>{if(!p)throw new Error('empty');const m=p.match(/^(-?\\d+)(?:-(-?\\d+))?$/);if(!m)throw new Error('bad part');const a=Number(m[1]);if(m[2]===undefined)return[a];const b=Number(m[2]);if(b<a)throw new Error('reversed');const out=[];for(let i=a;i<=b;i++)out.push(i);return out;}).flat();}`,
  'coding-balanced-brackets': `function isBalanced(s){const open={'(':')','[':']','{':'}'};const close=new Set([')',']','}']);const st=[];for(const ch of s){if(open[ch])st.push(open[ch]);else if(close.has(ch)){if(st.pop()!==ch)return false;}}return st.length===0;}`,
  'coding-luhn': `function luhnValid(s){if(!/^\\d+$/.test(s))return false;let sum=0;const ds=s.split('').reverse().map(Number);for(let i=0;i<ds.length;i++){let d=ds[i];if(i%2===1){d*=2;if(d>9)d-=9;}sum+=d;}return sum%10===0;}`,
  'coding-roman-to-int': `function romanToInt(s){const v={I:1,V:5,X:10,L:50,C:100,D:500,M:1000};let t=0;for(let i=0;i<s.length;i++){const c=v[s[i]],n=v[s[i+1]]??0;t+=c<n?-c:c;}return t;}`,
  'reasoning-prime-3599': '3599 = 3600 - 1 = 60^2 - 1^2 = 59 x 61, so it is not prime.\nANSWER: composite',
  'reasoning-book-bookmark': 'Let x be the bookmark. x + (x + 200) = 220 cents, so x = 10.\nANSWER: 10 cents',
  'reasoning-age-puzzle': 'Anna+5 = 30 = 2(Ben-3), so Ben-3 = 15, Ben = 18.\nANSWER: 18',
  'reasoning-letter-count': 'strawberry has 3, raspberry has 3.\nANSWER: 6',
  'constraint-no-e': 'A dog and a cat sat down by that big wall today.',
  'constraint-seven-words': 'The ocean holds many secrets beneath waves.',
  'constraint-acrostic-loupe': 'Light bends through the glass\nOver every hidden flaw\nUntil the truth appears\nPatiently it waits\nEvery detail seen',
  'constraint-json-only': '{"name": "Mira Kalen", "age": 34}',
};
const bad: Record<string, string> = {
  'coding-parse-range': 'function parseRange(s){return [1];}',
  'reasoning-prime-3599': 'It looks prime to me.\nANSWER: prime',
  'constraint-seven-words': 'The ocean holds many secrets beneath the rolling waves.',
  'constraint-json-only': 'Sure! Here is the JSON: {"name": "Mira", "age": 34}',
};

for (const [file, tasks] of packs) {
  for (const t of tasks) {
    test(`pack ground truth: ${t.id} reference solution scores 1.0`, async () => {
      const ref = good[t.id];
      assert.ok(ref, `missing reference solution for ${t.id} — add it to packs.test.ts`);
      const r = await grade(t.grader, ref);
      assert.equal(r.score, 1, `${file}/${t.id}: ${r.detail}`);
    });
  }
}

for (const [id, wrong] of Object.entries(bad)) {
  test(`pack ground truth: ${id} wrong answer scores < 1`, async () => {
    const task = [...packs.values()].flat().find((t) => t.id === id)!;
    const r = await grade(task.grader, wrong);
    assert.ok(r.score < 1, `${id}: wrong answer scored ${r.score}`);
  });
}
