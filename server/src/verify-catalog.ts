import { defaultLimit } from '@codeclash/shared';
import { judgeBatch } from '@codeclash/judge/runner';
import { CATALOG } from './catalog.js';
import { MORE } from './catalog-more.js';

/** Runs every built-in problem in the sandbox: the reference must pass every test, the wrong solution must fail one. */
const limit = defaultLimit('python');
let failures = 0;
for (const p of [...CATALOG, ...MORE]) {
  const tests = p.tests.map((t) => ({ input: t.input, output: t.output }));
  const reference = await judgeBatch({ language: 'python', code: p.reference, ...limit }, tests);
  const wrong = await judgeBatch({ language: 'python', code: p.wrong, ...limit }, tests);
  const bad = reference.map((r, i) => (r.verdict === 'AC' ? null : `test ${i + 1}: ${r.verdict}${r.reason ? ` (${r.reason})` : ''}`)).filter(Boolean);
  const caught = wrong.some((r) => r.verdict !== 'AC');
  const ok = bad.length === 0 && caught;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${p.title}${bad.length ? ` · reference ${bad.join(', ')}` : ''}${caught ? '' : ' · wrong solution passes every test'}`);
}
console.log(failures === 0 ? 'every problem verified' : `${failures} problem(s) failed`);
process.exit(failures === 0 ? 0 : 1);
