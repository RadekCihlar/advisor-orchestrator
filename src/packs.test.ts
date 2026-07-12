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
  'hard-semver-compare': `function compareSemver(a,b){
    const [ca,ra]=a.split(/-(.*)/s),[cb,rb]=b.split(/-(.*)/s);
    const na=ca.split('.').map(Number),nb=cb.split('.').map(Number);
    for(let i=0;i<3;i++){if(na[i]!==nb[i])return na[i]<nb[i]?-1:1;}
    if(!ra&&!rb)return 0;
    if(!ra)return 1;
    if(!rb)return -1;
    const ia=ra.split('.'),ib=rb.split('.');
    for(let i=0;i<Math.max(ia.length,ib.length);i++){
      const x=ia[i],y=ib[i];
      if(x===undefined)return -1;
      if(y===undefined)return 1;
      const dx=/^\\d+$/.test(x),dy=/^\\d+$/.test(y);
      if(dx&&dy){if(Number(x)!==Number(y))return Number(x)<Number(y)?-1:1;}
      else if(dx)return -1;
      else if(dy)return 1;
      else if(x!==y)return x<y?-1:1;
    }
    return 0;
  }`,
  'hard-parse-duration': `function parseDuration(s){
    const m=/^P(?:(\\d+(?:\\.\\d+)?)D)?(?:T(?:(\\d+(?:\\.\\d+)?)H)?(?:(\\d+(?:\\.\\d+)?)M)?(?:(\\d+(?:\\.\\d+)?)S)?)?$/.exec(s);
    if(!m)throw new Error('invalid duration');
    const [,d,h,mi,sec]=m;
    if(d===undefined&&h===undefined&&mi===undefined&&sec===undefined)throw new Error('empty duration');
    if(s.endsWith('T'))throw new Error('dangling T');
    return Number(d||0)*86400+Number(h||0)*3600+Number(mi||0)*60+Number(sec||0);
  }`,
  'hard-merge-intervals': `function mergeIntervals(intervals){
    const sorted=[...intervals].sort((p,q)=>p[0]-q[0]||p[1]-q[1]);
    const out=[];
    for(const [a,b] of sorted){
      const last=out[out.length-1];
      if(last&&a<=last[1])last[1]=Math.max(last[1],b);
      else out.push([a,b]);
    }
    return out;
  }`,
  'hard-csv-line': `function parseCsvLine(line){
    const out=[];let cur='';let i=0;let inQ=false;
    while(i<line.length){
      const ch=line[i];
      if(inQ){
        if(ch==='"'){if(line[i+1]==='"'){cur+='"';i+=2;continue;}inQ=false;i++;continue;}
        cur+=ch;i++;continue;
      }
      if(ch==='"'){inQ=true;i++;continue;}
      if(ch===','){out.push(cur);cur='';i++;continue;}
      cur+=ch;i++;
    }
    out.push(cur);
    return out;
  }`,
};
const bad: Record<string, string> = {
  'coding-parse-range': 'function parseRange(s){return [1];}',
  'reasoning-prime-3599': 'It looks prime to me.\nANSWER: prime',
  'constraint-seven-words': 'The ocean holds many secrets beneath the rolling waves.',
  'constraint-json-only': 'Sure! Here is the JSON: {"name": "Mira", "age": 34}',
  // Naive lexical compare: right on plain versions, wrong on 1.10 vs 1.9 and
  // all prerelease precedence — the plausible first attempt.
  'hard-semver-compare': 'function compareSemver(a,b){return a<b?-1:a>b?1:0;}',
  // Treats any M as minutes and never validates — misses the months trap.
  'hard-parse-duration': `function parseDuration(s){let t=0;const re=/(\\d+(?:\\.\\d+)?)([DHMS])/g;let m;while((m=re.exec(s))){const v=Number(m[1]);t+=m[2]==='D'?v*86400:m[2]==='H'?v*3600:m[2]==='M'?v*60:v;}return t;}`,
  // Sorts the caller's array in place — right answers, mutated input.
  'hard-merge-intervals': `function mergeIntervals(intervals){intervals.sort((p,q)=>p[0]-q[0]);const out=[];for(const [a,b] of intervals){const last=out[out.length-1];if(last&&a<=last[1])last[1]=Math.max(last[1],b);else out.push([a,b]);}return out;}`,
  // split(',') — the classic non-parser; dies on any quoted comma.
  'hard-csv-line': `function parseCsvLine(line){return line.split(',');}`,
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
