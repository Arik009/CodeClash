import type { SourceLanguage } from '@codeclash/shared';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from './errors.js';

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
  },
) {
  const requested = await db.collection('problem_versions').findOne({ _id: new ObjectId(input.problemVersionId) });
  if (!requested) throw new HttpError(404, 'Problem version not found');
  const version = await latestPublished(db, requested.problemId as ObjectId);
  if (!version) throw new HttpError(404, 'Problem version is not published');

  const doc = {
    userId: new ObjectId(input.userId),
    contestId: input.contestId ? new ObjectId(input.contestId) : null,
    problemVersionId: version._id,
    problemId: version.problemId,
    language: input.language,
    code: input.code,
    kind: input.kind,
    status: 'queued',
    claimToken: null,
    verdict: null,
    reason: null,
    submittedAt: new Date(),
    judgedAt: null,
  };
  const inserted = await db.collection('submissions').insertOne(doc);
  return { id: String(inserted.insertedId), stream: input.kind === 'contest' ? 'judge:contest' : 'judge:practice' };
}
