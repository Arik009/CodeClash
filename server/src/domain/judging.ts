import type { SourceLanguage } from '@codeclash/shared';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from './errors.js';

const OPEN = ['claimed', 'compiling', 'running'];

export async function latestPublished(db: Db, problemId: ObjectId) {
  return db.collection('problem_versions')
    .find({ problemId, status: 'published' })
    .sort({ version: -1 })
    .limit(1)
    .next();
}

/** One published version per problem, the newest. */
export async function publishedVersions(db: Db, problemIds?: ObjectId[]) {
  const rows = await db.collection('problem_versions').aggregate([
    { $match: { status: 'published', ...(problemIds ? { problemId: { $in: problemIds } } : {}) } },
    ...(problemIds ? [] : [{ $project: { problemId: 1, version: 1, title: 1, tags: 1 } }]),
    { $sort: { version: -1 } },
    { $group: { _id: '$problemId', doc: { $first: '$$ROOT' } } },
    { $replaceRoot: { newRoot: '$doc' } },
  ]).toArray();
  if (!problemIds) return rows.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  const order = new Map(problemIds.map((id, index) => [String(id), index]));
  return rows.sort((a, b) => (order.get(String(a.problemId)) ?? 0) - (order.get(String(b.problemId)) ?? 0));
}

export async function enqueueSubmission(
  db: Db,
  input: {
    userId: string;
    contestId?: string;
    problemVersionId: string;
    language: SourceLanguage;
    code: string;
    kind: 'contest' | 'practice';
    idempotencyKey?: string;
  },
) {
  const requested = await db.collection('problem_versions').findOne({ _id: new ObjectId(input.problemVersionId) });
  if (!requested) throw new HttpError(404, 'Problem version not found');
  const version = await latestPublished(db, requested.problemId as ObjectId);
  if (!version) throw new HttpError(404, 'Problem version is not published');

  if (input.kind === 'contest') {
    if (!input.contestId) throw new HttpError(400, 'Contest is required');
    const contest = await db.collection('contests').findOne({ _id: new ObjectId(input.contestId) });
    if (!contest || !['running', 'frozen'].includes(contest.status as string)) throw new HttpError(409, 'Contest is not running');
    if ((contest.endsAt as Date).getTime() <= Date.now()) throw new HttpError(409, 'Contest has ended');
    const seat = await db.collection('seats').findOne({
      contestId: contest._id,
      userId: new ObjectId(input.userId),
      status: { $in: ['reserved', 'modified', 'competing'] },
    });
    if (!seat) throw new HttpError(403, 'A reserved seat is required');
    const inContest = ((contest.problemIds as ObjectId[]) ?? []).some((id) => id.equals(version.problemId as ObjectId));
    if (!inContest) throw new HttpError(400, 'This problem is not part of the contest');
  }

  if (input.idempotencyKey) {
    const existing = await db.collection('submissions').findOne({
      userId: new ObjectId(input.userId),
      idempotencyKey: input.idempotencyKey,
    });
    if (existing) {
      return { id: String(existing._id), stream: input.kind === 'contest' ? 'judge:contest' : 'judge:practice', replay: true };
    }
  }

  const doc = {
    userId: new ObjectId(input.userId),
    contestId: input.contestId ? new ObjectId(input.contestId) : null,
    problemVersionId: version._id,
    problemId: version.problemId,
    language: input.language,
    code: input.code,
    kind: input.kind,
    status: 'queued',
    idempotencyKey: input.idempotencyKey ?? null,
    claimToken: null,
    verdict: null,
    reason: null,
    submittedAt: new Date(),
    judgedAt: null,
  };
  try {
    const inserted = await db.collection('submissions').insertOne(doc);
    return { id: String(inserted.insertedId), stream: input.kind === 'contest' ? 'judge:contest' : 'judge:practice', replay: false };
  } catch (error) {
    if (input.idempotencyKey && (error as { code?: number }).code === 11000) {
      const existing = await db.collection('submissions').findOne({
        userId: new ObjectId(input.userId),
        idempotencyKey: input.idempotencyKey,
      });
      if (existing) return { id: String(existing._id), stream: input.kind === 'contest' ? 'judge:contest' : 'judge:practice', replay: true };
    }
    throw error;
  }
}

export async function commitVerdict(
  db: Db,
  submissionId: string,
  claimToken: string,
  verdict: string,
  reason: string | null,
) {
  const updated = await db.collection('submissions').findOneAndUpdate(
    { _id: new ObjectId(submissionId), claimToken, status: { $in: OPEN } },
    { $set: { status: 'judged', verdict, reason, judgedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!updated) return null;
  await db.collection('outbox').insertOne({
    type: 'VerdictCommitted',
    payload: {
      submissionId,
      contestId: updated.contestId ? String(updated.contestId) : null,
      userId: String(updated.userId),
      problemId: String(updated.problemId),
      verdict,
      kind: updated.kind,
      submittedAt: updated.submittedAt,
    },
    createdAt: new Date(),
    sentAt: null,
  });
  if (updated.kind === 'contest' && updated.contestId) {
    const { recomputeStanding } = await import('./scoring.js');
    await db.collection('submissions').updateOne({ _id: updated._id }, { $set: { status: 'scored' } });
    await recomputeStanding(db, String(updated.contestId), String(updated.userId));
  }
  return updated;
}

export async function claimSubmission(db: Db, submissionId: string, claimToken: string, workerId: string) {
  const updated = await db.collection('submissions').findOneAndUpdate(
    { _id: new ObjectId(submissionId), status: 'queued' },
    { $set: { status: 'claimed', claimToken, workerId } },
    { returnDocument: 'after' },
  );
  return updated;
}

/** XAUTOCLAIM path: replace the token so the previous worker's commit matches nothing. */
export async function reclaimSubmission(db: Db, submissionId: string, claimToken: string, workerId: string) {
  return db.collection('submissions').findOneAndUpdate(
    { _id: new ObjectId(submissionId), status: { $in: ['queued', 'claimed', 'compiling', 'running'] } },
    { $set: { status: 'claimed', claimToken, workerId } },
    { returnDocument: 'after' },
  );
}
