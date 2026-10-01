import { defaultLimit, practiceStreak, rateContest, type Role, type SourceLanguage } from '@codeclash/shared';
import { createHash, randomBytes } from 'node:crypto';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from './errors.js';
import type { RunCase } from './problems.js';
import { leaderboard } from './scoring.js';

export function hashVerifyToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

export function newVerifyToken() {
  const token = randomBytes(24).toString('base64url');
  return { token, tokenHash: hashVerifyToken(token), expiresAt: new Date(Date.now() + 24 * 3600_000) };
}

/** Missing the field counts as verified, so accounts created before this rule keep working. */
export async function assertVerified(db: Db, userId: string) {
  const user = await db.collection('users').findOne({ _id: new ObjectId(userId) });
  if (!user) throw new HttpError(401, 'User no longer exists');
  if (user.emailVerified === false) throw new HttpError(403, 'Verify your email before competing');
  return user;
}

export async function verifyEmail(db: Db, token: string) {
  const user = await db.collection('users').findOne({ verifyTokenHash: hashVerifyToken(token) });
  if (!user || !(user.verifyExpires instanceof Date) || user.verifyExpires.getTime() < Date.now()) {
    throw new HttpError(400, 'This verification link is not valid');
  }
  await db.collection('users').updateOne(
    { _id: user._id },
    { $set: { emailVerified: true }, $unset: { verifyTokenHash: '', verifyExpires: '' } },
  );
  return { id: String(user._id), emailVerified: true };
}

export async function rejudgeSubmissions(
  db: Db,
  redis: { xadd: (stream: string, id: string, ...fields: string[]) => Promise<unknown> },
  input: { contestId: string; actor: string; reason: string; submissionId?: string; problemId?: string },
) {
  const contest = await db.collection('contests').findOne({ _id: new ObjectId(input.contestId) });
  if (!contest) throw new HttpError(404, 'Contest not found');
  if (contest.status === 'cancelled') throw new HttpError(409, 'A cancelled contest cannot be rejudged');
  const filter: Record<string, unknown> = {
    contestId: contest._id,
    kind: 'contest',
    status: { $in: ['judged', 'scored'] },
  };
  if (input.submissionId) filter._id = new ObjectId(input.submissionId);
  if (input.problemId) filter.problemId = new ObjectId(input.problemId);
  const rows = await db.collection('submissions').find(filter).toArray();
  if (rows.length === 0) throw new HttpError(404, 'No finished submissions match');
  const before = rows.map((row) => ({ id: String(row._id), verdict: row.verdict, points: row.points ?? null }));
  for (const row of rows) {
    await db.collection('submissions').updateOne(
      { _id: row._id },
      { $set: { status: 'queued', claimToken: null, verdict: null, reason: null, points: null, judgedAt: null }, $unset: { workerId: '' } },
    );
    await redis.xadd('judge:contest', '*', 'submissionId', String(row._id));
  }
  const users = [...new Set(rows.map((row) => String(row.userId)))];
  const { recomputeStanding } = await import('./scoring.js');
  for (const userId of users) await recomputeStanding(db, input.contestId, userId);
  return { count: rows.length, before, after: { status: 'queued' } };
}

/** Runs the visible sample tests and stores nothing. */
export async function runSamples(
  db: Db,
  run: RunCase,
  input: { problemVersionId: string; language: SourceLanguage; code: string; userId: string; contestId?: string },
) {
  const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(input.problemVersionId) });
  if (!version) throw new HttpError(404, 'Problem version not found');
  if (input.contestId) {
    const contest = await db.collection('contests').findOne({ _id: new ObjectId(input.contestId) });
    if (!contest || !['running', 'frozen'].includes(contest.status as string)) throw new HttpError(409, 'Contest is not running');
    const seat = await db.collection('seats').findOne({
      contestId: contest._id,
      userId: new ObjectId(input.userId),
      status: { $in: ['reserved', 'modified', 'competing'] },
    });
    if (!seat) throw new HttpError(403, 'A reserved seat is required');
  } else {
    const { assertArchiveAccess } = await import('./problems.js');
    await assertArchiveAccess(db, String(version.problemId));
  }
  const tests = ((version.tests as { input: string; output: string; hidden?: boolean }[]) ?? []).filter((test) => test.hidden === false);
  if (tests.length === 0) throw new HttpError(400, 'This problem has no sample tests');
  const limits = (version.limits as Record<string, { timeMs: number; memoryMb: number }>) ?? {};
  const limit = limits[input.language] ?? defaultLimit(input.language);
  const results = [];
  for (const test of tests) {
    const outcome = await run({
      language: input.language,
      code: input.code,
      stdin: test.input,
      expected: test.output,
      timeMs: limit.timeMs,
      memoryMb: limit.memoryMb,
    });
    results.push({ verdict: outcome.verdict, stdout: outcome.stdout.slice(0, 2000) });
  }
  return { results };
}

export async function applyRatings(db: Db, contestId: string) {
  const contest = await db.collection('contests').findOne({ _id: new ObjectId(contestId) });
  if (!contest) throw new HttpError(404, 'Contest not found');
  if (contest.ratingsApplied) return (contest.ratingDeltas as unknown[]) ?? [];
  const board = await leaderboard(db, contestId, { reveal: true });
  const ids = board.map((row) => new ObjectId(row.userId));
  const users = ids.length ? await db.collection('users').find({ _id: { $in: ids } }).toArray() : [];
  const ratingOf = new Map(users.map((user) => [String(user._id), (user.rating as number) ?? 1200]));
  const deltas = rateContest(board.map((row, index) => ({
    userId: row.userId,
    rating: ratingOf.get(row.userId) ?? 1200,
    place: index + 1,
  })));
  for (const row of deltas) {
    await db.collection('users').updateOne({ _id: new ObjectId(row.userId) }, { $set: { rating: row.after } });
  }
  await db.collection('contests').updateOne(
    { _id: contest._id, ratingsApplied: { $ne: true } },
    { $set: { ratingsApplied: true, ratingDeltas: deltas } },
  );
  return deltas;
}

export async function solveRecord(db: Db, userId: string) {
  const rows = await db.collection('submissions').find({
    userId: new ObjectId(userId),
    verdict: 'AC',
    status: { $in: ['judged', 'scored'] },
  }).project({ judgedAt: 1, submittedAt: 1 }).toArray();
  const days = [...new Set(rows.map((row) => {
    const when = (row.judgedAt as Date | undefined) ?? (row.submittedAt as Date);
    return when.toISOString().slice(0, 10);
  }))].sort();
  return { streak: practiceStreak(days), days };
}

export async function solveStreak(db: Db, userId: string) {
  return (await solveRecord(db, userId)).streak;
}

export async function problemStats(db: Db, problemId: ObjectId, viewerId: string | null) {
  const rows = await db.collection('submissions').find({ problemId, verdict: { $ne: null } }).project({ verdict: 1, userId: 1 }).toArray();
  const accepted = rows.filter((row) => row.verdict === 'AC').length;
  const acceptance = rows.length === 0 ? null : Math.round((100 * accepted) / rows.length);
  let status: 'solved' | 'attempted' | 'unsolved' = 'unsolved';
  if (viewerId) {
    const mine = rows.filter((row) => String(row.userId) === viewerId);
    status = mine.some((row) => row.verdict === 'AC') ? 'solved' : mine.length > 0 ? 'attempted' : 'unsolved';
  }
  return { acceptance, status, solvedCount: accepted, attempts: rows.length };
}

export function publicUser(user: { _id: ObjectId; role: Role; displayName: string; email?: string; emailVerified?: boolean; rating?: number }) {
  return {
    id: String(user._id),
    role: user.role,
    displayName: user.displayName,
    email: user.email,
    emailVerified: user.emailVerified !== false,
    rating: user.rating ?? 1200,
  };
}
