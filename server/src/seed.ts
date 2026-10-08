import { defaultLimits, seededRng, type SourceLanguage } from '@codeclash/shared';
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';
import { CATALOG, QUIZ_BANK } from './catalog.js';
import { MORE } from './catalog-more.js';
import { ensureIndexes } from './db/indexes.js';
import { applyRatings } from './domain/product.js';
import { awardFirstSolve, recomputeStanding } from './domain/scoring.js';
import {
  DEMO_PASSWORD, emailFor, initialRating, MORE_QUIZ, PARTICIPANTS, practiceDays, simulateContest, STAFF, STAFF_DOMAIN,
  STUDENT_DOMAIN, type SimProblem,
} from './seed-data.js';

const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
await ensureIndexes(db);

const rng = seededRng(455);
const pick = <T>(items: T[]) => items[Math.floor(rng.next() * items.length)]!;
const now = Date.now();
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const hourOf = (time: number) => Math.floor(time / HOUR) * HOUR;

// ---------- cleanup: everything a previous seed made, and the two contests of the first seed ----------
const oldContests = await db.collection('contests')
  .find({ $or: [{ seeded: true }, { title: { $in: ['Warmup round', 'Library cup'] } }] })
  .project({ _id: 1 }).toArray();
const oldIds = oldContests.map((c) => c._id);
for (const name of ['seats', 'standings', 'first_solves', 'quiz_questions', 'quiz_answers']) {
  await db.collection(name).deleteMany({ contestId: { $in: oldIds } });
}
await db.collection('submissions').deleteMany({ $or: [{ seeded: true }, { contestId: { $in: oldIds } }] });
await db.collection('contests').deleteMany({ _id: { $in: oldIds } });

// ---------- people ----------
const passwordHash = await hash(DEMO_PASSWORD);
const admin = (await db.collection('users').findOneAndUpdate(
  { email: 'admin@codeclash.local' },
  {
    $set: { emailVerified: true, rating: 1200 },
    $setOnInsert: { email: 'admin@codeclash.local', passwordHash, displayName: 'Admin', role: 'admin', createdAt: new Date() },
  },
  { upsert: true, returnDocument: 'after' },
))!;

interface Person { _id: ObjectId; name: string; skill: number }
async function upsertPerson(name: string, role: string, domain: string, rating: number) {
  const user = await db.collection('users').findOneAndUpdate(
    { email: emailFor(name, domain) },
    {
      $set: { displayName: name, role, emailVerified: true, seeded: true, seedRating: rating, rating, passwordHash },
      $setOnInsert: { email: emailFor(name, domain), createdAt: new Date(now - (120 + Math.floor(rng.next() * 300)) * DAY) },
    },
    { upsert: true, returnDocument: 'after' },
  );
  return { _id: user!._id, name, skill: rating };
}

const staff: Record<string, Person[]> = { setter: [], organiser: [] };
for (const member of STAFF) staff[member.role]!.push(await upsertPerson(member.name, member.role, STAFF_DOMAIN, 1200));
const people: Person[] = [];
for (const name of PARTICIPANTS) people.push(await upsertPerson(name, 'participant', STUDENT_DOMAIN, initialRating(rng)));


interface Seeded {
  problemId: ObjectId;
  versionId: ObjectId;
  rating: number;
  reference: { language: SourceLanguage; code: string };
  wrong: { language: SourceLanguage; code: string; verdict: string }[];
}

const CATALOG_RATING = { easy: 900, medium: 1300, hard: 1700 };

async function upsertProblem(item: {
  title: string; statement: string; samples: string; editorial: string; tags: string[]; difficulty: string; rating?: number;
  limits: Record<string, { timeMs: number; memoryMb: number }>; subtasks: unknown[]; inputSpec: string | null;
  tests: unknown[]; reference: Seeded['reference']; wrong: Seeded['wrong']; author: ObjectId;
}): Promise<Seeded> {
  const problem = (await db.collection('problems').findOneAndUpdate(
    { title: item.title },
    {
      $set: { statement: item.statement, samples: item.samples, editorial: item.editorial, tags: item.tags },
      $setOnInsert: { title: item.title, createdBy: item.author, createdAt: new Date(now - 200 * DAY) },
    },
    { upsert: true, returnDocument: 'after' },
  ))!;
  const version = {
    problemId: problem._id,
    version: 1,
    title: item.title,
    statement: item.statement,
    samples: item.samples,
    editorial: item.editorial,
    tags: item.tags,
    difficulty: item.difficulty,
    ...(item.rating ? { rating: item.rating } : {}),
    limits: item.limits,
    subtasks: item.subtasks,
    inputSpec: item.inputSpec,
    tests: item.tests,
    reference: item.reference,
    wrongSolutions: item.wrong.map((w, i) => ({ label: `incorrect ${i + 1}`, language: w.language, code: w.code })),
    status: 'published',
    report: [],
  };
  const saved = (await db.collection('problem_versions').findOneAndUpdate(
    { problemId: problem._id, version: 1 },
    { $set: version },
    { upsert: true, returnDocument: 'after' },
  ))!;
  return {
    problemId: problem._id,
    versionId: saved._id,
    rating: item.rating ?? CATALOG_RATING[item.difficulty as keyof typeof CATALOG_RATING] ?? 1200,
    reference: item.reference,
    wrong: item.wrong,
  };
}

const setters = staff.setter!;
const warmupPool: Seeded[] = [];
const libraryPool: Seeded[] = [];
const practice: Seeded[] = [];
for (const item of [...CATALOG, ...MORE]) {
  const pool = item.pool ?? (item.contest ? 'warmup' : 'practice');
  const seeded = await upsertProblem({
    title: item.title,
    statement: item.statement,
    samples: item.samples,
    editorial: item.editorial,
    tags: item.tags,
    difficulty: item.difficulty ?? 'easy',
    limits: defaultLimits(),
    subtasks: item.subtasks ?? [],
    inputSpec: item.inputSpec,
    tests: item.tests,
    reference: { language: 'python', code: item.reference },
    wrong: [{ language: 'python', code: item.wrong, verdict: 'WA' }],
    author: pick(setters)._id,
  });
  (pool === 'warmup' ? warmupPool : pool === 'archive' ? libraryPool : practice).push(seeded);
}

// ---------- contests ----------
const organisers = staff.organiser!;
const submissions: Record<string, unknown>[] = [];

async function createContest(input: {
  title: string; type?: string; status: string; startsAt: number; minutes: number; problems: Seeded[]; capacity?: number;
}) {
  const startsAt = new Date(input.startsAt);
  const endsAt = new Date(input.startsAt + input.minutes * MINUTE);
  const doc = {
    title: input.title,
    type: input.type ?? 'coding',
    capacity: input.capacity ?? 200,
    status: input.status,
    scoringMode: 'icpc',
    problemIds: input.problems.map((p) => p.problemId),
    startsAt,
    endsAt,
    freezeAt: new Date(endsAt.getTime() - Math.min(60, input.minutes / 3) * MINUTE),
    registrationOpensAt: new Date(input.startsAt - 7 * DAY),
    ratingsApplied: false,
    reserved: 0,
    waitlistSeq: 0,
    createdBy: pick(organisers)._id,
    seeded: true,
  };
  const { insertedId } = await db.collection('contests').insertOne(doc);
  return { _id: insertedId, ...doc };
}

function sample<T>(items: T[], count: number) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng.next() * (i + 1));
    [copy[i], copy[j]] = [copy[j]!, copy[i]!];
  }
  return copy.slice(0, count);
}

async function seat(contestId: ObjectId, players: Person[], status: string, at: number) {
  if (players.length === 0) return;
  await db.collection('seats').insertMany(players.map((player) => ({
    contestId, userId: player._id, status, active: true, waitlistPos: null, createdAt: new Date(at - rng.next() * 5 * DAY), seeded: true,
  })));
  await db.collection('contests').updateOne({ _id: contestId }, { $set: { reserved: players.length } });
}

/** Simulated attempts become scored submissions, then standings and first solves are built from them. */
async function playContest(contest: { _id: ObjectId; startsAt: Date }, players: Person[], problems: Seeded[], minutes: number) {
  const sim: SimProblem[] = problems.map((p) => ({ id: String(p.problemId), rating: p.rating, wrongVerdicts: p.wrong.map((w) => w.verdict) }));
  const attempts = simulateContest(rng, players.map((p) => ({ id: String(p._id), skill: p.skill })), sim, minutes);
  const byId = new Map(problems.map((p) => [String(p.problemId), p]));
  const rows = attempts.map((attempt) => {
    const problem = byId.get(attempt.problemId)!;
    const wrong = attempt.wrongIndex >= 0 ? problem.wrong[attempt.wrongIndex] : undefined;
    const code = attempt.verdict === 'AC' || !wrong ? problem.reference : wrong;
    const submittedAt = new Date(contest.startsAt.getTime() + attempt.minute * MINUTE + Math.floor(rng.next() * 50_000));
    return {
      _id: new ObjectId(),
      userId: new ObjectId(attempt.userId),
      contestId: contest._id,
      problemVersionId: problem.versionId,
      problemId: problem.problemId,
      language: code.language,
      code: code.code,
      kind: 'contest',
      status: 'scored',
      idempotencyKey: null,
      claimToken: null,
      verdict: attempt.verdict,
      reason: null,
      submittedAt,
      judgedAt: new Date(submittedAt.getTime() + 1500 + Math.floor(rng.next() * 3000)),
      seeded: true,
    };
  });
  if (rows.length) await db.collection('submissions').insertMany(rows);
  for (const row of rows.filter((r) => r.verdict === 'AC')) {
    await awardFirstSolve(db, { contestId: contest._id, problemId: row.problemId, userId: row.userId, submissionId: row._id, submittedAt: row.submittedAt });
  }
  for (const userId of new Set(rows.map((r) => String(r.userId)))) await recomputeStanding(db, String(contest._id), userId);
  return rows.length;
}

const past: { title: string; startsAt: number; players: Person[]; problems: Seeded[]; minutes: number }[] = [];
past.push({ title: 'Library cup', startsAt: hourOf(now - 14 * DAY), players: sample(people, 40), problems: libraryPool, minutes: 240 });

let contestSubmissions = 0;
for (const item of past) {
  const created = await createContest({ title: item.title, status: 'published', startsAt: item.startsAt, minutes: item.minutes, problems: item.problems });
  await seat(created._id, item.players, 'competing', created.startsAt.getTime());
  contestSubmissions += await playContest(created, item.players, item.problems, item.minutes);
  await applyRatings(db, String(created._id));
}

// The live round: history so far is simulated; a few fresh submissions go to the real judge.
const liveStart = Math.floor((now - 40 * MINUTE) / MINUTE) * MINUTE;
const warmup = await createContest({ title: 'Warmup round', type: 'mixed', status: 'running', startsAt: liveStart, minutes: 180, problems: warmupPool });
const warmupPlayers = sample(people, 30);
await seat(warmup._id, warmupPlayers, 'competing', liveStart);
contestSubmissions += await playContest(warmup, warmupPlayers, warmupPool, 38);
const live: { id: ObjectId }[] = [];
for (const player of sample(warmupPlayers, 8)) {
  const problem = pick(warmupPool);
  const code = rng.next() < 0.7 || problem.wrong.length === 0 ? problem.reference : pick(problem.wrong);
  const { insertedId } = await db.collection('submissions').insertOne({
    userId: player._id, contestId: warmup._id, problemVersionId: problem.versionId, problemId: problem.problemId,
    language: code.language, code: code.code, kind: 'contest', status: 'queued', idempotencyKey: null, claimToken: null,
    verdict: null, reason: null, submittedAt: new Date(), judgedAt: null, seeded: true,
  });
  live.push({ id: insertedId });
}
try {
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  for (const row of live) await redis.xadd('judge:contest', '*', 'submissionId', String(row.id));
  await redis.quit();
} catch {
  console.log('redis unreachable: the server re-queues the live submissions within two minutes');
}

// ---------- practice history: streaks and the activity heatmap ----------
const today = Math.floor(now / DAY) * DAY;
for (const person of people) {
  const reachable = practice.filter((p) => p.rating <= person.skill + 150);
  const pool = reachable.length ? reachable : practice;
  for (const day of practiceDays(rng)) {
    const start = today - day * DAY;
    const span = day === 0 ? Math.max(MINUTE, now - start - MINUTE) : DAY;
    const solves = 1 + (rng.next() < 0.4 ? 1 : 0) + (rng.next() < 0.15 ? 1 : 0);
    for (let k = 0; k < solves; k += 1) {
      const problem = pick(pool);
      const at = start + Math.floor(rng.next() * span);
      const add = (code: { language: SourceLanguage; code: string }, verdict: string, offset: number) => submissions.push({
        userId: person._id, contestId: null, problemVersionId: problem.versionId, problemId: problem.problemId,
        language: code.language, code: code.code, kind: 'practice', status: 'judged', idempotencyKey: null, claimToken: null,
        verdict, reason: null, submittedAt: new Date(at + offset), judgedAt: new Date(at + offset + 2000), seeded: true,
      });
      if (problem.wrong.length && rng.next() < 0.35) {
        const wrong = pick(problem.wrong);
        add(wrong, wrong.verdict, -Math.floor(rng.next() * 20) * MINUTE - MINUTE);
      }
      add(problem.reference, 'AC', 0);
    }
  }
}
for (let i = 0; i < submissions.length; i += 1000) await db.collection('submissions').insertMany(submissions.slice(i, i + 1000));

// ---------- quiz bank ----------
for (const question of [...QUIZ_BANK, ...MORE_QUIZ]) {
  await db.collection('quiz_bank').updateOne(
    { prompt: question.prompt },
    { $setOnInsert: { ...question, basePoints: 1000, windowSec: 30 } },
    { upsert: true },
  );
}

const visible = practice.length + libraryPool.length;
console.log(`problems: ${CATALOG.length + MORE.length} catalog (${visible} in the archive)`);
console.log(`users: ${people.length} participants, ${STAFF.length} staff, admin ${admin.email}`);
console.log(`contests: ${past.length} published, Warmup round live`);
console.log(`submissions: ${contestSubmissions} in contests, ${submissions.length} practice, ${live.length} sent to the judge`);
console.log(`quiz bank: ${QUIZ_BANK.length + MORE_QUIZ.length} questions`);
console.log(`every demo account uses the password "${DEMO_PASSWORD}"`);
await client.close();
