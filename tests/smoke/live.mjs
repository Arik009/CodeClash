// Live smoke check against a running stack: `npm run dev` plus a seeded database.
const base = process.env.BASE_URL ?? 'http://127.0.0.1:4000';

async function call(path, { token, method = 'GET', body } = {}) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function verdict(token, id) {
  for (let i = 0; i < 60; i += 1) {
    const row = await call(`/api/submissions/${id}`, { token });
    if (row.body?.verdict) return row.body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`no verdict for ${id}`);
}

function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` · ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

const email = `smoke-${Date.now()}@example.com`;
const joined = await call('/api/auth/register', { method: 'POST', body: { email, password: 'longpassword', displayName: 'Smoke' } });
check('register', joined.status === 201);
const token = joined.body.access;

const contests = await call('/api/contests');
const contest = contests.body.find((c) => c.title === 'Warmup round');
check('seeded contest is live', contest?.status === 'running', contest?.status);

const room = await call(`/api/contests/${contest.id}`, { token });
check('contest shows its problems', room.body.problems.length === 6, `${room.body.problems.length} problems`);

const seat = await call(`/api/contests/${contest.id}/seats`, { token, method: 'POST' });
check('seat reserved', seat.status === 201, seat.body.outcome);
const mySeat = await call(`/api/contests/${contest.id}/seat`, { token });
check('seat is competing', mySeat.body?.status === 'competing', mySeat.body?.status);

const sum = room.body.problems.find((p) => p.title.startsWith('Sum of two'));
const good = await call(`/api/contests/${contest.id}/submissions`, {
  token, method: 'POST', body: { problemVersionId: sum.versionId, language: 'python', code: 'a,b=map(int,input().split())\nprint(a+b)\n' },
});
check('submission accepted', good.status === 202);
const goodVerdict = await verdict(token, good.body.id);
check('correct answer is AC', goodVerdict.verdict === 'AC', goodVerdict.verdict);

const bad = await call(`/api/contests/${contest.id}/submissions`, {
  token, method: 'POST', body: { problemVersionId: sum.versionId, language: 'javascript', code: 'console.log(0)' },
});
const badVerdict = await verdict(token, bad.body.id);
check('wrong JavaScript answer is WA', badVerdict.verdict === 'WA', badVerdict.verdict);

await new Promise((resolve) => setTimeout(resolve, 1500));
const board = await call(`/api/contests/${contest.id}/leaderboard`);
const me = board.body.find((row) => row.displayName === 'Smoke');
check('leaderboard counts the solve', me?.solved === 1, JSON.stringify(me));

const admin = await call('/api/auth/login', { method: 'POST', body: { email: 'admin@codeclash.local', password: 'codeclash' } });
const opened = await call(`/api/contests/${contest.id}/quiz/next`, { token: admin.body.access, method: 'POST' });
check('organiser opens a quiz question', opened.status === 201 || opened.status === 409, opened.body?.prompt ?? opened.body?.error);
const current = await call(`/api/contests/${contest.id}/quiz/current`, { token });
if (current.body.question && !current.body.question.closed) {
  const first = await call(`/api/quiz/${current.body.question.id}/answer`, { token, method: 'POST', body: { choice: 0 } });
  const second = await call(`/api/quiz/${current.body.question.id}/answer`, { token, method: 'POST', body: { choice: 1 } });
  check('first quiz answer counts', first.status === 200, `score ${first.body.score}`);
  check('second answer is refused', second.status === 409, second.body.error);
}

const archive = await call('/api/archive');
check('practice archive lists non-contest problems', archive.body.length >= 2, `${archive.body.length} problems`);
const practice = await call('/api/practice/submissions', {
  token, method: 'POST', body: { problemVersionId: archive.body[0].versionId, language: 'python', code: 'print(1)' },
});
const practiceVerdict = await verdict(token, practice.body.id);
check('practice is judged during a live contest', Boolean(practiceVerdict.verdict), practiceVerdict.verdict);

const badId = await call('/api/contests/nope');
check('malformed id gives 400', badId.status === 400);

async function until(path, token, done) {
  for (let i = 0; i < 90; i += 1) {
    const row = await call(path, { token });
    if (done(row.body)) return row.body;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`timed out on ${path}`);
}

const staff = admin.body.access;
const created = await call('/api/problems', {
  token: staff, method: 'POST', body: { title: `Double it ${Date.now()}`, statement: 'Print twice the integer.', samples: 'Input\n4\nOutput\n8', tags: ['math'] },
});
const draftId = created.body.versionId;
await call(`/api/problem-versions/${draftId}/tests`, {
  token: staff,
  method: 'PUT',
  body: {
    tests: [{ input: '4\n', output: '8\n', hidden: false }, { input: '-3\n', output: '-6\n', hidden: true }],
    reference: { language: 'python', code: 'print(int(input())*2)\n' },
    wrongSolutions: [{ label: 'square', language: 'python', code: 'n=int(input())\nprint(n*n)\n' }],
  },
});
const started = await call(`/api/problem-versions/${draftId}/publish-check`, { token: staff, method: 'POST' });
check('publish check answers at once', started.status === 202);
const checked = await until(`/api/problem-versions/${draftId}`, staff, (v) => v.status !== 'checking');
check('publish check publishes a sound problem', checked.status === 'published', checked.report.join('; '));

const hardening = await call(`/api/problem-versions/${draftId}/harden`, { token: staff, method: 'POST' });
const run = await until(`/api/agent-runs/${hardening.body.runId}`, staff, (r) => r.status !== 'running');
check('agent proposes items from this problem', run.proposals >= 1, `${run.proposals} proposals, ${run.status}`);
const proposals = await call(`/api/problem-versions/${draftId}/proposals`, { token: staff });
const test = proposals.body.find((p) => p.kind === 'test');
check('proposed test is an edge case of the sample', test?.stdin.trim() === '-4' && test?.expected.trim() === '-8', JSON.stringify(test));
const wrong = proposals.body.find((p) => p.kind === 'wrong_solution');
if (wrong) {
  const approved = await call(`/api/proposals/${wrong.id}/approve`, { token: staff, method: 'POST' });
  const next = await call(`/api/problem-versions/${approved.body.versionId}`, { token: staff });
  check('approval makes a new draft with the wrong solution', next.body.status === 'draft' && next.body.wrongSolutions.length === 2, `v${next.body.version}`);
}
