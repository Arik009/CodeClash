import { ROLES, SOURCE_LANGUAGES, type Role } from '@codeclash/shared';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { BSON, type Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { auditCollection } from '../db/audit.js';
import { HttpError } from '../domain/errors.js';
import { enqueueSubmission, latestPublished } from '../domain/judging.js';
import { type RunCase } from '../domain/problems.js';
import { checkPassword, hashPassword, issueRefresh, readAccess, revokeRefresh, rotateRefresh, signAccess } from './auth.js';
import { assertVerified, newVerifyToken, publicUser, runSamples, verifyEmail } from '../domain/product.js';

export interface AppDeps {
  db: Db;
  redis: {
    xadd: (stream: string, id: string, ...fields: string[]) => Promise<unknown>;
    incr: (key: string) => Promise<number>;
    expire: (key: string, seconds: number) => Promise<unknown>;
    get: (key: string) => Promise<string | null>;
    ping?: () => Promise<string>;
  };
  log?: { info: (obj: unknown, msg?: string) => void };
  runCase?: RunCase;
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

function requireRole(req: Request, roles: Role[]) {
  const user = auth(req);
  if (!roles.includes(user.role)) throw new HttpError(403, 'Forbidden');
  return user;
}

function optionalAuth(req: Request) {
  try {
    return auth(req);
  } catch {
    return null;
  }
}

async function audit(
  db: Db,
  actor: string,
  action: string,
  target: string,
  decision: string,
  detail: { before?: unknown; after?: unknown; reason?: string } = {},
) {
  await auditCollection(db).insertOne({
    actor,
    actorType: 'user',
    action,
    target,
    decision,
    payload: { before: detail.before ?? null, after: detail.after ?? null, reason: detail.reason ?? '' },
    at: new Date(),
  });
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

  app.get('/api/archive', asyncRoute(async (req, res) => {
    const viewer = optionalAuth(req);
    const query = z.object({
      q: z.string().default(''),
      tag: z.string().default(''),
      difficulty: z.string().default(''),
      status: z.string().default(''),
      page: z.coerce.number().int().min(1).default(1),
      pageSize: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(req.query);
    const rows = await archiveRows(db, viewer?.sub ?? null);
    const q = query.q.trim().toLowerCase();
    const matching = rows.filter((row) => (!q || row.title.toLowerCase().includes(q))
      && (!query.tag || row.tags.includes(query.tag))
      && (!query.difficulty || row.difficulty === query.difficulty)
      && (!query.status || row.status === query.status));
    const start = (query.page - 1) * query.pageSize;
    res.json({
      items: matching.slice(start, start + query.pageSize),
      total: matching.length,
      page: query.page,
      pageSize: query.pageSize,
      tags: tagsByUse(rows),
    });
  }));

  app.get('/api/archive/:problemId', asyncRoute(async (req, res) => {
    const version = await latestPublished(db, new ObjectId(req.params.problemId));
    if (!version) throw new HttpError(404, 'Not in the archive');
    res.json({
      problemId: req.params.problemId,
      versionId: String(version._id),
      title: version.title,
      statement: version.statement,
      samples: version.samples,
      editorial: version.editorial ?? '',
    });
  }));

  app.get('/api/problem-versions/:id/public', asyncRoute(async (req, res) => {
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(req.params.id), status: 'published' });
    if (!version) throw new HttpError(404, 'Not in the archive');
    res.json({
      problemId: String(version.problemId),
      versionId: String(version._id),
      title: version.title,
      statement: version.statement,
      samples: version.samples,
      tags: version.tags ?? [],
      difficulty: version.difficulty ?? 'medium',
      limits: version.limits ?? null,
      editorial: version.editorial ?? '',
    });
  }));

  app.get('/api/submissions/:id', asyncRoute(async (req, res) => {
    const user = auth(req);
    const submission = await db.collection('submissions').findOne({ _id: new ObjectId(req.params.id) });
    if (!submission) throw new HttpError(404, 'Submission not found');
    if (String(submission.userId) !== user.sub && user.role !== 'admin') throw new HttpError(403, 'Forbidden');
    res.json({
      id: req.params.id,
      status: submission.status,
      verdict: submission.verdict,
      reason: submission.reason,
    });
  }));

  async function submitLimit(userId: string) {
    const key = `submit:${userId}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > Number(process.env.SUBMIT_PER_MINUTE ?? 12)) throw new HttpError(429, 'Too many submissions; wait a minute');
  }

  function idempotencyKey(req: Request) {
    const key = req.header('idempotency-key')?.trim();
    if (!key) return undefined;
    if (key.length > 80) throw new HttpError(400, 'Idempotency-Key is too long');
    return key;
  }

  app.post('/api/run', asyncRoute(async (req, res) => {
    const user = auth(req);
    await assertVerified(db, user.sub);
    const body = z.object({
      problemVersionId: z.string(),
      language: z.enum(SOURCE_LANGUAGES),
      code: z.string().min(1).max(64_000),
    }).parse(req.body);
    res.json(await runSamples(db, deps.runCase ?? runInSandbox, { ...body, userId: user.sub }));
  }));

  app.post('/api/practice/submissions', asyncRoute(async (req, res) => {
    const user = auth(req);
    await assertVerified(db, user.sub);
    const body = z.object({
      problemVersionId: z.string(),
      language: z.enum(SOURCE_LANGUAGES),
      code: z.string().min(1).max(64_000),
    }).parse(req.body);
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(body.problemVersionId) });
    if (!version) throw new HttpError(404, 'Problem version not found');
    await submitLimit(user.sub);
    const queued = await enqueueSubmission(db, { ...body, userId: user.sub, kind: 'practice', idempotencyKey: idempotencyKey(req) });
    if (!queued.replay) {
      await redis.xadd(queued.stream, '*', 'submissionId', queued.id);
    }
    res.status(queued.replay ? 200 : 202).json({ id: queued.id, replay: queued.replay });
  }));

  app.get('/api/admin/audit', asyncRoute(async (req, res) => {
    requireRole(req, ['admin']);
    const rows = await auditCollection(db).find({}).sort({ at: -1 }).limit(100).toArray();
    res.json(rows.map((r) => ({ ...r, _id: String(r._id) })));
  }));

  app.get('/api/admin/users', asyncRoute(async (req, res) => {
    requireRole(req, ['admin']);
    const rows = await db.collection('users').find({}).project({ passwordHash: 0 }).sort({ createdAt: -1 }).limit(50).toArray();
    res.json(rows.map((u) => ({ id: String(u._id), email: u.email, displayName: u.displayName, role: u.role })));
  }));

  app.put('/api/admin/users/:id/role', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['admin']);
    const body = z.object({ role: z.enum(ROLES) }).parse(req.body);
    if (req.params.id === user.sub && body.role !== 'admin') throw new HttpError(409, 'You cannot remove your own admin role');
    const updated = await db.collection('users').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { role: body.role } });
    if (updated.matchedCount === 0) throw new HttpError(404, 'User not found');
    await audit(db, user.sub, 'user.role', req.params.id, body.role);
    res.json({ role: body.role });
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

async function runInSandbox(input: Parameters<RunCase>[0]) {
  const { runInDocker } = await import('@codeclash/judge/runner');
  return runInDocker(input);
}

interface ArchiveRow {
  problemId: string;
  versionId: string;
  title: string;
  tags: string[];
  difficulty: string;
  rating: number | null;
  source: string | null;
  acceptance: number | null;
  solvedCount: number;
  status: 'solved' | 'attempted' | 'unsolved';
}

function tagsByUse(rows: ArchiveRow[]) {
  const uses = new Map<string, number>();
  for (const tag of rows.flatMap((row) => row.tags)) uses.set(tag, (uses.get(tag) ?? 0) + 1);
  return [...uses.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag]) => tag);
}

/** Latest published version of every problem, with stats, in two queries. */
async function archiveRows(db: Db, viewerId: string | null): Promise<ArchiveRow[]> {
  const visible = await db.collection('problem_versions').aggregate([
    { $match: { status: 'published' } },
    { $sort: { version: -1 } },
    { $group: { _id: '$problemId', doc: { $first: { _id: '$_id', title: '$title', tags: '$tags', difficulty: '$difficulty', rating: '$rating', source: '$source' } } } },
  ]).toArray();
  const ids = visible.map((row) => row._id as ObjectId);
  const viewer = viewerId && ObjectId.isValid(viewerId) ? new ObjectId(viewerId) : null;
  const stats = ids.length ? await db.collection('submissions').aggregate([
    { $match: { problemId: { $in: ids }, verdict: { $ne: null } } },
    {
      $group: {
        _id: '$problemId',
        attempts: { $sum: 1 },
        accepted: { $sum: { $cond: [{ $eq: ['$verdict', 'AC'] }, 1, 0] } },
        mine: { $sum: { $cond: [{ $eq: ['$userId', viewer] }, 1, 0] } },
        mineAc: { $sum: { $cond: [{ $and: [{ $eq: ['$userId', viewer] }, { $eq: ['$verdict', 'AC'] }] }, 1, 0] } },
      },
    },
  ]).toArray() : [];
  const byProblem = new Map(stats.map((row) => [String(row._id), row]));
  return visible.map((row): ArchiveRow => {
    const doc = row.doc as Record<string, unknown>;
    const stat = byProblem.get(String(row._id));
    const attempts = (stat?.attempts as number) ?? 0;
    const accepted = (stat?.accepted as number) ?? 0;
    const acceptance = attempts === 0 ? null : Math.round((100 * accepted) / attempts);
    const source = doc.source as { platform?: string; contestId?: number; index?: string; name?: string } | undefined;
    return {
      problemId: String(row._id),
      versionId: String(doc._id),
      title: String(doc.title),
      tags: Array.isArray(doc.tags) ? (doc.tags as string[]) : [],
      difficulty: (doc.difficulty as string | undefined) ?? (acceptance === null ? 'medium' : acceptance >= 70 ? 'easy' : acceptance >= 40 ? 'medium' : 'hard'),
      rating: typeof doc.rating === 'number' ? doc.rating : null,
      source: source ? (source.platform ? `${source.platform} ${source.contestId ?? ''}${source.index ?? ''}`.trim() : source.name ?? null) : null,
      acceptance,
      solvedCount: accepted,
      status: viewer && (stat?.mineAc as number) > 0 ? 'solved' : viewer && (stat?.mine as number) > 0 ? 'attempted' : 'unsolved',
    };
  }).sort((a, b) => a.title.localeCompare(b.title));
}
