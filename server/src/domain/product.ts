import { defaultLimit, type Role, type SourceLanguage } from '@codeclash/shared';
import { createHash, randomBytes } from 'node:crypto';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from './errors.js';
import type { RunCase } from './problems.js';

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
