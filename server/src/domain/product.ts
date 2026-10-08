import { type Role } from '@codeclash/shared';
import { createHash, randomBytes } from 'node:crypto';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from './errors.js';

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
