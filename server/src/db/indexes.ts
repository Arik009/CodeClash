import type { Db } from 'mongodb';

export async function ensureIndexes(db: Db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ family: 1 });
  await db.collection('refresh_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('users').createIndex({ verifyTokenHash: 1 }, { sparse: true });
}
