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
