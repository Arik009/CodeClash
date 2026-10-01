import type { Db } from 'mongodb';

/** Audit indexes live with the audit database and are created by mongo-init. */
export async function ensureIndexes(db: Db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('seats').createIndex(
    { contestId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  await db.collection('first_solves').createIndex({ contestId: 1, problemId: 1 }, { unique: true });
  await db.collection('standings').createIndex({ contestId: 1, userId: 1 }, { unique: true });
  await db.collection('submissions').createIndex({ status: 1, submittedAt: 1 });
  await db.collection('problem_versions').createIndex({ problemId: 1, version: 1 }, { unique: true });
  await db.collection('outbox').createIndex({ sentAt: 1, createdAt: 1 });
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ family: 1 });
  await db.collection('refresh_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('quiz_answers').createIndex({ questionId: 1, userId: 1 }, { unique: true });
  await db.collection('quiz_questions').createIndex({ contestId: 1, opensAt: -1 });
  await db.collection('submissions').createIndex({ contestId: 1, userId: 1, submittedAt: -1 });
  await db.collection('submissions').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
  );
  await db.collection('users').createIndex({ verifyTokenHash: 1 }, { sparse: true });
}
