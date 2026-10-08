import { hash, verify } from '@node-rs/argon2';
import { type Role } from '@codeclash/shared';
import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { type Db, ObjectId } from 'mongodb';
import { HttpError } from '../domain/errors.js';

const ACCESS_TTL = '15m';

export async function hashPassword(password: string) {
  return hash(password);
}

export async function checkPassword(password: string, stored: string) {
  return verify(stored, password);
}

function secret() {
  const value = process.env.JWT_SECRET;
  if (value && value.length >= 16) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('JWT_SECRET must be set (16+ characters) in production');
  return 'dev-only-change-me';
}

export function signAccess(user: { id: string; role: Role }) {
  return jwt.sign({ sub: user.id, role: user.role }, secret(), { expiresIn: ACCESS_TTL });
}

export function readAccess(token: string): { sub: string; role: Role } {
  try {
    return jwt.verify(token, secret()) as { sub: string; role: Role };
  } catch {
    throw new HttpError(401, 'Invalid or expired access token');
  }
}

function hashToken(raw: string) {
  return createHash('sha256').update(raw).digest('hex');
}

/** Tokens from one sign-in share a family, so a replayed token can revoke the whole chain. */
export async function issueRefresh(db: Db, userId: string, family = randomBytes(12).toString('hex')) {
  const raw = randomBytes(32).toString('base64url');
  await db.collection('refresh_tokens').insertOne({
    userId: new ObjectId(userId),
    tokenHash: hashToken(raw),
    family,
    expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
    revoked: false,
  });
  return raw;
}

export async function rotateRefresh(db: Db, raw: string) {
  const tokens = db.collection('refresh_tokens');
  const existing = await tokens.findOne({ tokenHash: hashToken(raw) });
  if (!existing || (existing.expiresAt as Date) <= new Date()) throw new HttpError(401, 'Refresh token is not valid');
  const used = await tokens.updateOne({ _id: existing._id, revoked: false }, { $set: { revoked: true, usedAt: new Date() } });
  if (used.modifiedCount === 0) {
    if (existing.family) await tokens.updateMany({ family: existing.family }, { $set: { revoked: true } });
    throw new HttpError(401, 'Refresh token was already used; sign in again');
  }
  const user = await db.collection('users').findOne({ _id: existing.userId });
  if (!user) throw new HttpError(401, 'User no longer exists');
  const access = signAccess({ id: String(user._id), role: user.role });
  const refresh = await issueRefresh(db, String(user._id), existing.family as string | undefined);
  return {
    access,
    refresh,
    user: { id: String(user._id), role: user.role as Role, displayName: user.displayName as string },
  };
}

export async function revokeRefresh(db: Db, raw: string) {
  await db.collection('refresh_tokens').updateOne({ tokenHash: hashToken(raw) }, { $set: { revoked: true } });
}
