import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('submissions').createIndex({ status: 1, submittedAt: 1 });
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ family: 1 });
  await db.collection('refresh_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('submissions').createIndex({ problemId: 1, verdict: 1 });
  await db.collection('submissions').createIndex({ userId: 1, verdict: 1 });
  await db.collection('problem_versions').createIndex({ status: 1, problemId: 1, version: -1 });
  await db.collection('submissions').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
  );
  await db.collection('users').createIndex({ verifyTokenHash: 1 }, { sparse: true });
}
