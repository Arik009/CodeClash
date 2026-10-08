// Failure drills against the local stack (docker compose up, then npm run dev, then npm run seed).
//
//   node tests/failure/run.mjs [redis] [mongo] [judge]
//
// redis  restarts the Redis container while a submission is in flight; /health must fail and
//        recover, and the submission must still get exactly one verdict.
// mongo  restarts the Mongo container; /health must recover and every contest's seat count must
//        still match its active seats.
// judge  kills the judge (JUDGE_PID, or the pid it recorded in `workers`) while it holds a claim.
//        Restart it by hand, or set JUDGE_RESTART=touch under npm run dev; the stream entry is
//        reclaimed after a minute and the submission still gets one verdict.
// Containers are restarted, never removed, so no data is lost.
import { spawnSync } from 'node:child_process';
import { utimesSync } from 'node:fs';
import { hostname } from 'node:os';
import { MongoClient, ObjectId } from 'mongodb';

const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
const mongoUrl = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const project = process.env.COMPOSE_PROJECT ?? 'codeclash';
const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['redis', 'mongo'];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];

function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` · ${detail}` : ''}`);
}

async function health() {
  try {
    const res = await fetch(`${api}/health`, { signal: AbortSignal.timeout(3000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function waitFor(check, timeoutMs, stepMs = 1000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(stepMs);
  }
  return false;
}

async function login() {
  const res = await fetch(`${api}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.DRILL_EMAIL ?? 'aarav.sharma@students.codeclash.dev', password: 'codeclash' }),
  });
  if (!res.ok) throw new Error(`login failed (${res.status}); run npm run seed first`);
  return (await res.json()).access;
}

async function submit(token) {
  const archive = await fetch(`${api}/api/archive?q=Absolute difference`).then((r) => r.json());
  const versionId = archive.items[0]?.versionId;
  if (!versionId) throw new Error('"Absolute difference" is not in the archive; run npm run seed first');
  const res = await fetch(`${api}/api/practice/submissions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'idempotency-key': crypto.randomUUID() },
    body: JSON.stringify({ problemVersionId: versionId, language: 'python', code: 'a, b = map(int, input().split())\nprint(abs(a - b))\n' }),
  });
  if (res.status !== 202) throw new Error(`submit failed (${res.status})`);
  return (await res.json()).id;
}

async function verdictOf(token, id) {
  const res = await fetch(`${api}/api/submissions/${id}`, { headers: { authorization: `Bearer ${token}` } }).catch(() => null);
  return res?.ok ? res.json() : null;
}

function restart(service) {
  const run = spawnSync('docker', ['restart', `${project}-${service}-1`], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(run.stderr.trim());
}

async function seatInvariants(db) {
  const broken = [];
  for (const contest of await db.collection('contests').find({}).project({ title: 1, reserved: 1 }).toArray()) {
    const seats = await db.collection('seats').countDocuments({ contestId: contest._id, active: true, status: { $in: ['reserved', 'modified', 'competing'] } });
    if (seats !== (contest.reserved ?? 0)) broken.push(`${contest.title}: ${seats} seats, reserved ${contest.reserved}`);
  }
  return broken;
}

if (!(await health())) {
  console.log(`The server at ${api} is not healthy. Start the stack first.`);
  process.exit(1);
}
const token = await login();

if (wanted.includes('redis')) {
  const id = await submit(token);
  restart('redis');
  console.log(`      /health right after the restart: ${(await health()) ? 'ok' : 'failing'}`);
  report('redis: /health recovers', await waitFor(health, 60_000));
  const judged = await waitFor(async () => (await verdictOf(token, id))?.verdict, 180_000, 2000);
  const final = await verdictOf(token, id);
  report('redis: the in-flight submission is judged once', judged && final.verdict === 'AC', `${final?.status} ${final?.verdict}`);
}

if (wanted.includes('mongo')) {
  restart('mongo');
  report('mongo: /health recovers', await waitFor(health, 90_000));
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const broken = await seatInvariants(client.db());
  report('mongo: seat counts match active seats', broken.length === 0, broken.join('; '));
  await client.close();
  const id = await submit(await login());
  const judged = await waitFor(async () => (await verdictOf(token, id))?.verdict, 120_000, 2000);
  report('mongo: new submissions are judged after the restart', judged);
}

if (wanted.includes('judge')) {
  const client = new MongoClient(mongoUrl);
  await client.connect();
  const db = client.db();
  const worker = await db.collection('workers').findOne({ host: hostname(), status: 'active', pid: { $exists: true } }, { sort: { lastSeen: -1 } });
  const pid = Number(process.env.JUDGE_PID ?? worker?.pid);
  if (!pid) {
    report('judge: found the judge process', false, 'set JUDGE_PID or start the judge on this machine');
  } else {
    const submissions = db.collection('submissions');
    const id = await submit(token);
    const claimed = await waitFor(async () => (await submissions.findOne({ _id: new ObjectId(id) }))?.claimToken, 30_000, 50);
    process.kill(pid, 'SIGKILL');
    const row = await submissions.findOne({ _id: new ObjectId(id) });
    console.log(`      judge ${pid} killed with the submission ${row?.status}${claimed ? '' : ' (not claimed in time)'}`);
    if (process.env.JUDGE_RESTART === 'touch') {
      // tsx watch restarts the judge when its entry file changes.
      const entry = new URL('../../judge/src/index.ts', import.meta.url);
      utimesSync(entry, new Date(), new Date());
    } else {
      console.log('      start the judge again now (npm run dev -w judge)');
    }
    const judged = await waitFor(async () => (await verdictOf(token, id))?.verdict, 300_000, 2000);
    const after = await submissions.findOne({ _id: new ObjectId(id) });
    report('judge: the claimed submission gets one verdict after restart', judged && after?.verdict === 'AC', `${after?.status} ${after?.verdict}`);
  }
  await client.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
