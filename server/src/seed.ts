import { defaultLimits, seededRng, SOURCE_LANGUAGES, type SourceLanguage } from '@codeclash/shared';
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { Redis } from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { CATALOG, QUIZ_BANK } from './catalog.js';
import { MORE } from './catalog-more.js';
import { ensureIndexes } from './db/indexes.js';
import { applyRatings } from './domain/product.js';
import { tidyStatement } from './import/codecontests.js';
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

// ---------- problems ----------
interface Imported {
  title: string; statement: string; samples: string; tags: string[]; difficulty: 'easy' | 'medium' | 'hard'; rating: number;
  limits: { timeMs: number; memoryMb: number }; inputSpec: string | null; tests: { input: string; output: string; hidden: boolean }[];
  reference: { language: SourceLanguage; code: string };
  wrongSolutions: { label: string; language: SourceLanguage; code: string; expected: string }[];
  source: { platform: string; contestId: number; index: string; url: string; dataset: string; license: string };
}

interface Seeded {
  problemId: ObjectId;
  versionId: ObjectId;
  rating: number;
  reference: { language: SourceLanguage; code: string };
  wrong: { language: SourceLanguage; code: string; verdict: string }[];
}

const CATALOG_RATING = { easy: 900, medium: 1300, hard: 1700 };

function languageLimits({ timeMs, memoryMb }: { timeMs: number; memoryMb: number }) {
  return Object.fromEntries(SOURCE_LANGUAGES.map((language) => [language, language === 'java'
    ? { timeMs: Math.round(timeMs * 1.5), memoryMb: Math.max(memoryMb, 512) }
    : { timeMs, memoryMb: ['javascript', 'go'].includes(language) ? Math.max(memoryMb, 128) : memoryMb }]));
}

async function upsertProblem(item: {
  title: string; statement: string; samples: string; editorial: string; tags: string[]; difficulty: string; rating?: number;
  limits: Record<string, { timeMs: number; memoryMb: number }>; subtasks: unknown[]; inputSpec: string | null;
  tests: unknown[]; reference: Seeded['reference']; wrong: Seeded['wrong']; source?: Imported['source']; author: ObjectId;
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
    ...(item.source ? { source: { ...item.source, name: `${item.source.platform} ${item.source.contestId}${item.source.index}` } } : {}),
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

const imported = (JSON.parse(gunzipSync(readFileSync(new URL('../data/codecontests.json.gz', import.meta.url))).toString()) as { problems: Imported[] }).problems;
const importedSeeded = new Map<Imported, Seeded>();
for (const item of imported) {
  importedSeeded.set(item, await upsertProblem({
    title: item.title,
    statement: tidyStatement(item.statement),
    samples: item.samples,
    editorial: '',
    tags: item.tags,
    difficulty: item.difficulty,
    rating: item.rating,
    limits: languageLimits(item.limits),
    subtasks: [],
    inputSpec: item.inputSpec,
    tests: item.tests,
    reference: item.reference,
    wrong: item.wrongSolutions.map((w) => ({ language: w.language, code: w.code, verdict: w.expected })),
    source: item.source,
    author: pick(setters)._id,
  }));
}

// Codeforces rounds with three or more problems become past contests; two more are mixed from the rest.
const byRound = new Map<number, Imported[]>();
for (const item of imported) byRound.set(item.source.contestId, [...(byRound.get(item.source.contestId) ?? []), item]);
const used = new Set<Imported>();
const rounds: Imported[][] = [...byRound.values()].filter((list) => list.length >= 3).slice(0, 5);
for (const round of rounds) round.forEach((item) => used.add(item));
function mixed(shape: ('easy' | 'medium' | 'hard')[]) {
  const set: Imported[] = [];
  for (const difficulty of shape) {
    const item = imported.find((p) => !used.has(p) && p.difficulty === difficulty);
    if (item) { used.add(item); set.push(item); }
  }
  return set.sort((a, b) => a.rating - b.rating);
}
rounds.push(mixed(['easy', 'medium', 'medium', 'hard']), mixed(['easy', 'easy', 'medium', 'hard']));
const autumn = mixed(['easy', 'medium', 'medium', 'hard', 'hard']);
const winter = mixed(['easy', 'medium', 'medium', 'hard']);
for (const item of imported) if (!used.has(item)) practice.push(importedSeeded.get(item)!);
const toSeeded = (list: Imported[]) => list.map((item) => importedSeeded.get(item)!);

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

const PAST = ['Monsoon Starter', 'CodeClash Round 1', 'CodeClash Round 2', 'Midsummer Sprint', 'CodeClash Round 3', 'Campus Qualifier', 'CodeClash Round 4'];
const past = rounds.map((round, index) => ({
  title: PAST[index] ?? `CodeClash Round ${index}`,
  startsAt: hourOf(now - (110 - index * 14) * DAY),
  players: sample(people, 26 + Math.floor(rng.next() * 22)),
  problems: toSeeded(round),
  minutes: 120,
}));
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

const autumnStart = hourOf(now + 5 * DAY);
const autumnOpen = await createContest({ title: 'Autumn Open', status: 'registration_open', startsAt: autumnStart, minutes: 150, problems: toSeeded(autumn) });
await db.collection('contests').updateOne({ _id: autumnOpen._id }, { $set: { registrationOpensAt: new Date(now - 2 * DAY) } });
await seat(autumnOpen._id, sample(people, 40), 'reserved', now);
await createContest({ title: 'Winter Invitational', status: 'draft', startsAt: hourOf(now + 27 * DAY), minutes: 180, problems: toSeeded(winter) });

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

const visible = practice.length + libraryPool.length + rounds.reduce((n, r) => n + r.length, 0);
console.log(`problems: ${CATALOG.length + MORE.length} catalog + ${imported.length} from CodeContests (${visible} in the archive)`);
console.log(`users: ${people.length} participants, ${STAFF.length} staff, admin ${admin.email}`);
console.log(`contests: ${past.length} published, Warmup round live, Autumn Open registering, Winter Invitational draft`);
console.log(`submissions: ${contestSubmissions} in contests, ${submissions.length} practice, ${live.length} sent to the judge`);
console.log(`quiz bank: ${QUIZ_BANK.length + MORE_QUIZ.length} questions`);
console.log(`every demo account uses the password "${DEMO_PASSWORD}"`);
await client.close();
