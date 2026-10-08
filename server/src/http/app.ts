import { type Role } from '@codeclash/shared';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { BSON, type Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { HttpError } from '../domain/errors.js';
import { checkPassword, hashPassword, issueRefresh, readAccess, revokeRefresh, rotateRefresh, signAccess } from './auth.js';
import { newVerifyToken, publicUser, verifyEmail } from '../domain/product.js';

export interface AppDeps {
  db: Db;
  redis: {
    incr: (key: string) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<unknown>;
    get: (key: string) => Promise<string | null>;
    ping?: () => Promise<string>;
  };
  log?: { info: (obj: unknown, msg?: string) => void };
}

function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };
}

function auth(req: Request) {
  const header = req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new HttpError(401, 'Sign in required');
  return readAccess(token);
}

export function createApp(deps: AppDeps) {
  const { db, redis } = deps;
  const app = express();
  app.use(cors({ origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' }));
  app.use(express.json({ limit: '256kb' }));

  app.get('/health', asyncRoute(async (_req, res) => {
    await db.command({ ping: 1 });
    if (redis.ping) await redis.ping();
    else await redis.get('health:ping');
    res.json({ ok: true, mongo: true, redis: true });
  }));

  app.post('/api/auth/register', asyncRoute(async (req, res) => {
    const body = z.object({
      email: z.string().email(),
      password: z.string().min(8),
      displayName: z.string().min(1).max(40),
    }).parse(req.body);
    const passwordHash = await hashPassword(body.password);
    const verify = newVerifyToken();
    try {
      const inserted = await db.collection('users').insertOne({
        email: body.email.toLowerCase(),
        passwordHash,
        displayName: body.displayName,
        role: 'participant' as Role,
        rating: 1200,
        emailVerified: false,
        verifyTokenHash: verify.tokenHash,
        verifyExpires: verify.expiresAt,
        createdAt: new Date(),
      });
      const id = String(inserted.insertedId);
      const access = signAccess({ id, role: 'participant' });
      const refresh = await issueRefresh(db, id);
      res.status(201).json({
        access,
        refresh,
        user: { id, role: 'participant', displayName: body.displayName, emailVerified: false, rating: 1200 },
        ...(process.env.NODE_ENV === 'production' ? {} : { verifyToken: verify.token }),
      });
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new HttpError(409, 'Email is already registered');
      throw error;
    }
  }));

  app.post('/api/auth/login', asyncRoute(async (req, res) => {
    const body = z.object({ email: z.string().email(), password: z.string() }).parse(req.body);
    const key = `login:${body.email.toLowerCase()}`;
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, 60);
    if (attempts > 10) throw new HttpError(429, 'Too many sign-in attempts');
    const user = await db.collection('users').findOne({ email: body.email.toLowerCase() });
    if (!user || !(await checkPassword(body.password, user.passwordHash as string))) {
      throw new HttpError(401, 'Wrong email or password');
    }
    const id = String(user._id);
    const access = signAccess({ id, role: user.role as Role });
    const refresh = await issueRefresh(db, id);
    res.json({
      access,
      refresh,
      user: { id, role: user.role, displayName: user.displayName, emailVerified: user.emailVerified !== false, rating: user.rating ?? 1200 },
    });
  }));

  app.post('/api/auth/verify', asyncRoute(async (req, res) => {
    const body = z.object({ token: z.string().min(10) }).parse(req.body);
    res.json(await verifyEmail(db, body.token));
  }));

  app.post('/api/auth/verify/resend', asyncRoute(async (req, res) => {
    const user = auth(req);
    const verify = newVerifyToken();
    const updated = await db.collection('users').updateOne(
      { _id: new ObjectId(user.sub), emailVerified: false },
      { $set: { verifyTokenHash: verify.tokenHash, verifyExpires: verify.expiresAt } },
    );
    if (updated.matchedCount === 0) throw new HttpError(409, 'This email is already verified');
    res.json(process.env.NODE_ENV === 'production' ? { sent: true } : { sent: true, verifyToken: verify.token });
  }));

  app.post('/api/auth/refresh', asyncRoute(async (req, res) => {
    const body = z.object({ refresh: z.string() }).parse(req.body);
    res.json(await rotateRefresh(db, body.refresh));
  }));

  app.post('/api/auth/logout', asyncRoute(async (req, res) => {
    const body = z.object({ refresh: z.string() }).parse(req.body);
    await revokeRefresh(db, body.refresh);
    res.status(204).end();
  }));

  app.get('/api/me', asyncRoute(async (req, res) => {
    const user = auth(req);
    const doc = await db.collection('users').findOne({ _id: new ObjectId(user.sub) });
    if (!doc) throw new HttpError(401, 'User no longer exists');
    const profile = publicUser({ ...doc, _id: doc._id, role: doc.role as Role, displayName: doc.displayName as string });
    res.json({ ...profile, email: doc.email });
  }));

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof z.ZodError) {
      res.status(400).json({ error: error.issues.map((i) => i.message).join('; ') });
      return;
    }
    if (error instanceof HttpError) {
      res.status(error.status).json({ error: error.message });
      return;
    }
    if (error instanceof BSON.BSONError) {
      res.status(400).json({ error: 'Invalid id' });
      return;
    }
    deps.log?.info({ err: error }, 'unhandled');
    res.status(500).json({ error: 'Internal error' });
  });

  return app;
}
