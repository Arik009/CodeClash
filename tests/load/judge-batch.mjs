// Before/after for JUDGE_BATCH: one container per test against one compile and one container
// for every test. Needs Docker and the sandbox images; build the judge package first.
//
//   node tests/load/judge-batch.mjs
import { judgeBatch, runInDocker } from '@codeclash/judge/runner';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1'));
const TESTS = Number(process.env.TESTS ?? 12);
const ROUNDS = Number(process.env.ROUNDS ?? 2);

const tests = Array.from({ length: TESTS }, (_, i) => {
  const values = Array.from({ length: 50 + i * 400 }, (_, k) => ((k * 7919 + i * 104729) % 2_000_001) - 1_000_000);
  return { input: `${values.length}\n${values.join(' ')}\n`, output: `${values.reduce((a, b) => a + b, 0)}\n` };
});

const SOLUTIONS = {
  python: 'import sys\ndata = sys.stdin.read().split()\nn = int(data[0])\nprint(sum(map(int, data[1:1 + n])))\n',
  cpp: '#include <bits/stdc++.h>\nint main(){int n;std::cin>>n;long long s=0,x;for(int i=0;i<n;i++){std::cin>>x;s+=x;}std::cout<<s<<"\\n";}\n',
  java: 'import java.util.*;\npublic class Main{public static void main(String[] a){Scanner in=new Scanner(System.in);int n=in.nextInt();long s=0;for(int i=0;i<n;i++)s+=in.nextLong();System.out.println(s);}}\n',
};

const limit = (language) => (language === 'java' ? { timeMs: 3000, memoryMb: 512 } : { timeMs: 2000, memoryMb: 256 });
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

async function timed(fn) {
  const started = performance.now();
  const verdicts = await fn();
  return { ms: Math.round(performance.now() - started), verdicts };
}

const rows = [];
for (const [language, code] of Object.entries(SOLUTIONS)) {
  const perTest = [];
  const batch = [];
  for (let round = 0; round < ROUNDS; round += 1) {
    const before = await timed(async () => {
      const verdicts = [];
      for (const test of tests) verdicts.push((await runInDocker({ language, code, stdin: test.input, expected: test.output, ...limit(language) })).verdict);
      return verdicts;
    });
    const after = await timed(async () => (await judgeBatch({ language, code, ...limit(language) }, tests)).map((r) => r.verdict));
    if (![...before.verdicts, ...after.verdicts].every((v) => v === 'AC')) throw new Error(`${language}: expected AC everywhere, got ${before.verdicts} / ${after.verdicts}`);
    perTest.push(before.ms);
    batch.push(after.ms);
  }
  const row = { language, tests: TESTS, perTestMs: median(perTest), batchMs: median(batch) };
  row.speedup = Number((row.perTestMs / row.batchMs).toFixed(2));
  rows.push(row);
  console.log(`${language}: one container per test ${row.perTestMs} ms, batch ${row.batchMs} ms, ${row.speedup}x`);
}

mkdirSync(path.join(here, 'results'), { recursive: true });
writeFileSync(path.join(here, 'results', 'judge-batch.json'), `${JSON.stringify({ date: new Date().toISOString(), rounds: ROUNDS, rows }, null, 2)}\n`);
writeFileSync(path.join(here, 'results', 'judge-batch.md'), [
  '# Judge batch: before and after',
  '',
  `${TESTS} tests of growing size (50 to ${50 + (TESTS - 1) * 400} numbers), median of ${ROUNDS} rounds, all verdicts AC.`,
  'Before: a fresh container (and compile) for every test. After: `JUDGE_BATCH=1`, one compile and one container for all tests.',
  '',
  '| language | before ms | after ms | speedup |',
  '| --- | --- | --- | --- |',
  ...rows.map((r) => `| ${r.language} | ${r.perTestMs} | ${r.batchMs} | ${r.speedup}x |`),
  '',
].join('\n'));
