import {
  quizScore, streakBonus, defaultLimits, draftSpec, parseSpec, ROLES, SOURCE_LANGUAGES, SpecError, validateInput,
  type ContestStatus, type Role,
} from '@codeclash/shared';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import { BSON, type Db, ObjectId } from 'mongodb';
import { z } from 'zod';
import { auditCollection } from '../db/audit.js';
import { transitionContest } from '../domain/contests.js';
import { HttpError, isDuplicateKey } from '../domain/errors.js';
import { enqueueSubmission, latestPublished, publishedVersions } from '../domain/judging.js';
import { assertArchiveAccess, runPublishCheck, testsFromZip, type RunCase } from '../domain/problems.js';
import { reserveSeat, withdrawSeat } from '../domain/registration.js';
import { leaderboard } from '../domain/scoring.js';
import { checkPassword, hashPassword, issueRefresh, readAccess, revokeRefresh, rotateRefresh, signAccess } from './auth.js';
import { assertVerified, newVerifyToken, publicUser, rejudgeSubmissions, runSamples, solveRecord, verifyEmail } from '../domain/product.js';

export interface AppDeps {
  db: Db;
  redis: {
    xadd: (stream: string, id: string, ...fields: string[]) => Promise<unknown>;
    publish: (channel: string, message: string) => Promise<unknown>;
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

const STAFF: Role[] = ['setter', 'organiser', 'admin'];
const STARTED = ['running', 'frozen', 'ended', 'published'];

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
    const record = await solveRecord(db, user.sub);
    res.json({ ...profile, email: doc.email, streak: record.streak, days: record.days });
  }));

  app.patch('/api/me', asyncRoute(async (req, res) => {
    const user = auth(req);
    const body = z.object({ displayName: z.string().trim().min(1).max(40) }).parse(req.body);
    const doc = await db.collection('users').findOne({ _id: new ObjectId(user.sub) });
    if (!doc) throw new HttpError(401, 'User no longer exists');
    await db.collection('users').updateOne({ _id: doc._id }, { $set: { displayName: body.displayName } });
    await audit(db, user.sub, 'profile.update', user.sub, 'allow', { before: doc.displayName, after: body.displayName, reason: 'display name' });
    const profile = publicUser({ ...doc, displayName: body.displayName, role: doc.role as Role });
    res.json(profile);
  }));

  app.post('/api/me/password', asyncRoute(async (req, res) => {
    const user = auth(req);
    const body = z.object({ current: z.string().min(1), next: z.string().min(8).max(200) }).parse(req.body);
    const doc = await db.collection('users').findOne({ _id: new ObjectId(user.sub) });
    if (!doc || !(await checkPassword(body.current, doc.passwordHash as string))) throw new HttpError(400, 'Current password is wrong');
    if (body.current === body.next) throw new HttpError(400, 'Choose a different password');
    await db.collection('users').updateOne({ _id: doc._id }, { $set: { passwordHash: await hashPassword(body.next) } });
    await audit(db, user.sub, 'profile.password', user.sub, 'allow', { reason: 'password changed' });
    res.status(204).end();
  }));

  app.post('/api/contests', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['organiser', 'admin']);
    const body = z.object({
      title: z.string().min(1),
      type: z.enum(['coding', 'quiz', 'mixed']),
      capacity: z.number().int().positive(),
      startsAt: z.string().datetime(),
      endsAt: z.string().datetime(),
      freezeAt: z.string().datetime(),
      registrationOpensAt: z.string().datetime(),
      scoringMode: z.enum(['icpc', 'quiz']),
      problemIds: z.array(z.string()).default([]),
    }).parse(req.body);
    if (new Date(body.endsAt) <= new Date(body.startsAt)) throw new HttpError(400, 'End must be after start');
    if (new Date(body.freezeAt) < new Date(body.startsAt) || new Date(body.freezeAt) > new Date(body.endsAt)) {
      throw new HttpError(400, 'Freeze must fall between start and end');
    }
    const inserted = await db.collection('contests').insertOne({
      ...body,
      startsAt: new Date(body.startsAt),
      endsAt: new Date(body.endsAt),
      freezeAt: new Date(body.freezeAt),
      registrationOpensAt: new Date(body.registrationOpensAt),
      problemIds: body.problemIds.map((id) => new ObjectId(id)),
      status: 'draft',
      reserved: 0,
      waitlistSeq: 0,
      createdBy: new ObjectId(user.sub),
    });
    res.status(201).json({ id: String(inserted.insertedId) });
  }));

  app.post('/api/contests/:id/transition', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['organiser', 'admin']);
    const body = z.object({ to: z.enum(['registration_open', 'running', 'frozen', 'ended', 'published', 'cancelled']) }).parse(req.body);
    const result = await transitionContest(db, req.params.id, body.to as ContestStatus, user.sub);
    if (result.to === 'running') await redis.publish('contest:running', '1');
    res.json(result);
  }));

  app.get('/api/contests/:id', asyncRoute(async (req, res) => {
    const contest = await db.collection('contests').findOne({ _id: new ObjectId(req.params.id) });
    if (!contest) throw new HttpError(404, 'Contest not found');
    const viewer = optionalAuth(req);
    const status = contest.status as string;
    const showProblems = STARTED.includes(status) || (viewer !== null && STAFF.includes(viewer.role));
    const versions = showProblems ? await publishedVersions(db, (contest.problemIds as ObjectId[]) ?? []) : [];
    res.json({
      id: String(contest._id),
      title: contest.title,
      type: contest.type,
      status,
      scoringMode: contest.scoringMode,
      capacity: contest.capacity,
      reserved: contest.reserved,
      startsAt: contest.startsAt,
      freezeAt: contest.freezeAt,
      endsAt: contest.endsAt,
      serverNow: new Date().toISOString(),
      problemCount: ((contest.problemIds as ObjectId[]) ?? []).length,
      problems: versions.map((v) => ({
        problemId: String(v.problemId),
        versionId: String(v._id),
        title: v.title,
        statement: v.statement,
        samples: v.samples,
        limits: v.limits ?? null,
        editorial: status === 'ended' || status === 'published' ? v.editorial ?? null : null,
      })),
    });
  }));

  app.get('/api/contests/:id/seat', asyncRoute(async (req, res) => {
    const user = auth(req);
    const seat = await db.collection('seats').findOne({
      contestId: new ObjectId(req.params.id),
      userId: new ObjectId(user.sub),
      active: true,
    });
    res.json(seat ? { seatId: String(seat._id), status: seat.status, position: seat.waitlistPos ?? null } : null);
  }));

  app.get('/api/contests/:id/submissions/mine', asyncRoute(async (req, res) => {
    const user = auth(req);
    const rows = await db.collection('submissions')
      .find({ contestId: new ObjectId(req.params.id), userId: new ObjectId(user.sub) })
      .project({ code: 0 })
      .sort({ submittedAt: -1 })
      .limit(50)
      .toArray();
    res.json(rows.map((row) => ({
      id: String(row._id),
      problemId: String(row.problemId),
      language: row.language,
      status: row.status,
      verdict: row.verdict,
      submittedAt: row.submittedAt,
    })));
  }));

  app.get('/api/catalog', asyncRoute(async (req, res) => {
    requireRole(req, STAFF);
    const versions = await publishedVersions(db);
    res.json(versions.map((v) => ({ problemId: String(v.problemId), versionId: String(v._id), title: v.title, tags: v.tags ?? [] })));
  }));

  app.get('/api/contests', asyncRoute(async (_req, res) => {
    const rows = await db.collection('contests').find({}).sort({ startsAt: 1 }).limit(100).toArray();
    res.json(rows.map((c) => ({
      id: String(c._id),
      title: c.title,
      type: c.type,
      status: c.status,
      capacity: c.capacity,
      reserved: c.reserved,
      scoringMode: c.scoringMode,
      startsAt: c.startsAt,
      freezeAt: c.freezeAt,
      endsAt: c.endsAt,
    })));
  }));

  app.post('/api/contests/:id/seats', asyncRoute(async (req, res) => {
    const user = auth(req);
    await assertVerified(db, user.sub);
    const result = await reserveSeat(db, req.params.id, user.sub);
    const status = result.outcome === 'reserved' ? 201 : 200;
    res.status(status).json(result);
  }));

  app.delete('/api/seats/:id', asyncRoute(async (req, res) => {
    const user = auth(req);
    const result = await withdrawSeat(db, req.params.id, user.sub);
    res.json(result);
  }));

  app.post('/api/problems', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['setter', 'admin']);
    const body = z.object({
      title: z.string().min(1),
      statement: z.string().min(1),
      samples: z.string().default(''),
      editorial: z.string().default(''),
      tags: z.array(z.string()).default([]),
      difficulty: z.enum(['easy', 'medium', 'hard']).default('medium'),
    }).parse(req.body);
    const problem = await db.collection('problems').insertOne({ ...body, createdBy: new ObjectId(user.sub), createdAt: new Date() });
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      ...body,
      limits: defaultLimits(),
      tests: [],
      reference: null,
      wrongSolutions: [],
      status: 'draft',
      report: [],
    });
    res.status(201).json({ problemId: String(problem.insertedId), versionId: String(version.insertedId) });
  }));

  app.get('/api/problems', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const rows = await db.collection('problem_versions').aggregate([
      { $project: { problemId: 1, version: 1, title: 1, status: 1 } },
      { $sort: { version: -1 } },
      { $group: { _id: '$problemId', doc: { $first: '$$ROOT' } } },
      { $replaceRoot: { newRoot: '$doc' } },
      { $sort: { title: 1 } },
    ]).toArray();
    res.json(rows.map((v) => ({
      problemId: String(v.problemId),
      versionId: String(v._id),
      version: v.version,
      title: v.title,
      status: v.status,
    })));
  }));

  app.post('/api/problems/:id/versions', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const body = z.object({
      statement: z.string().min(1).optional(),
      samples: z.string().optional(),
      editorial: z.string().optional(),
      tags: z.array(z.string()).optional(),
    }).parse(req.body ?? {});
    const problem = await db.collection('problems').findOne({ _id: new ObjectId(req.params.id) });
    if (!problem) throw new HttpError(404, 'Problem not found');
    const latest = await db.collection('problem_versions').find({ problemId: problem._id }).sort({ version: -1 }).limit(1).next();
    const version = ((latest?.version as number) ?? 0) + 1;
    const inserted = await db.collection('problem_versions').insertOne({
      problemId: problem._id,
      version,
      title: latest?.title ?? problem.title,
      statement: body.statement ?? latest?.statement,
      samples: body.samples ?? latest?.samples ?? '',
      editorial: body.editorial ?? latest?.editorial ?? '',
      tags: body.tags ?? latest?.tags ?? [],
      difficulty: latest?.difficulty ?? 'medium',
      limits: latest?.limits,
      tests: latest?.tests ?? [],
      reference: latest?.reference ?? null,
      wrongSolutions: latest?.wrongSolutions ?? [],
      inputSpec: latest?.inputSpec ?? '',
      status: 'draft',
      report: [],
    });
    res.status(201).json({ versionId: String(inserted.insertedId), version });
  }));

  app.get('/api/problem-versions/:id', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(req.params.id) });
    if (!version) throw new HttpError(404, 'Version not found');
    res.json({
      problemId: String(version.problemId),
      versionId: String(version._id),
      version: version.version,
      title: version.title,
      statement: version.statement ?? '',
      samples: version.samples ?? '',
      editorial: version.editorial ?? '',
      tags: version.tags ?? [],
      difficulty: version.difficulty ?? 'medium',
      limits: version.limits ?? {},
      tests: version.tests ?? [],
      reference: version.reference ?? null,
      wrongSolutions: version.wrongSolutions ?? [],
      inputSpec: version.inputSpec ?? '',
      status: version.status,
      report: version.report ?? [],
    });
  }));

  app.patch('/api/problem-versions/:id', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const body = z.object({
      title: z.string().min(1).optional(),
      statement: z.string().min(1).optional(),
      samples: z.string().optional(),
      editorial: z.string().optional(),
      tags: z.array(z.string()).optional(),
      difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
      inputSpec: z.string().max(4000).optional(),
    }).parse(req.body);
    if (body.inputSpec?.trim()) {
      try {
        parseSpec(body.inputSpec);
      } catch (error) {
        throw new HttpError(400, error instanceof SpecError ? `Input spec: ${error.message}` : 'Input spec does not parse');
      }
    }
    const updated = await db.collection('problem_versions').updateOne(
      { _id: new ObjectId(req.params.id), status: { $in: ['draft', 'blocked'] } },
      { $set: { ...body, status: 'draft' } },
    );
    if (updated.matchedCount === 0) throw new HttpError(409, 'Only draft or blocked versions can be edited');
    res.json({ ok: true });
  }));

  /** Checks a spec against every stored test, and drafts one from the statement for comparison. */
  app.post('/api/problem-versions/:id/spec-check', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const body = z.object({ inputSpec: z.string().max(4000) }).parse(req.body);
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(req.params.id) });
    if (!version) throw new HttpError(404, 'Version not found');
    const tests = (version.tests as { input: string }[]) ?? [];
    const drafted = draftSpec(String(version.statement ?? ''), tests.map((t) => t.input));
    if (!body.inputSpec.trim()) {
      res.json({ ok: false, parseError: 'The spec is empty', failures: [], checked: 0, drafted });
      return;
    }
    let spec;
    try {
      spec = parseSpec(body.inputSpec);
    } catch (error) {
      res.json({ ok: false, parseError: error instanceof SpecError ? error.message : 'does not parse', failures: [], checked: 0, drafted });
      return;
    }
    const failures = tests
      .map((test, index) => ({ test: index + 1, result: validateInput(spec, test.input) }))
      .filter((row) => !row.result.ok)
      .slice(0, 20)
      .map((row) => ({ test: row.test, error: row.result.ok ? '' : row.result.error }));
    res.json({ ok: failures.length === 0, parseError: null, failures, checked: tests.length, drafted });
  }));

  app.put('/api/problem-versions/:id/tests', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const body = z.object({
      tests: z.array(z.object({
        input: z.string(),
        output: z.string(),
        hidden: z.boolean().default(true),
      })),
      reference: z.object({ language: z.enum(SOURCE_LANGUAGES), code: z.string() }).nullable().default(null),
      wrongSolutions: z.array(z.object({ label: z.string(), language: z.enum(SOURCE_LANGUAGES), code: z.string() })).default([]),
      limits: z.record(z.object({ timeMs: z.number().int().positive(), memoryMb: z.number().int().positive() })).optional(),
    }).parse(req.body);
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(req.params.id) });
    if (!version) throw new HttpError(404, 'Version not found');
    if (!['draft', 'blocked'].includes(version.status as string)) throw new HttpError(409, 'Only draft or blocked versions can change');
    await db.collection('problem_versions').updateOne(
      { _id: version._id },
      { $set: { tests: body.tests, reference: body.reference?.code ? body.reference : null, wrongSolutions: body.wrongSolutions, ...(body.limits ? { limits: body.limits } : {}), status: 'draft' } },
    );
    res.json({ ok: true });
  }));

  app.post('/api/problem-versions/:id/tests-zip', asyncRoute(async (req, res) => {
    requireRole(req, ['setter', 'admin']);
    const body = z.object({ zipBase64: z.string().min(1) }).parse(req.body);
    const tests = testsFromZip(Buffer.from(body.zipBase64, 'base64'));
    const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(req.params.id) });
    if (!version) throw new HttpError(404, 'Version not found');
    if (!['draft', 'blocked'].includes(version.status as string)) throw new HttpError(409, 'Only draft or blocked versions can change');
    await db.collection('problem_versions').updateOne({ _id: version._id }, { $set: { tests, status: 'draft' } });
    res.json({ count: tests.length });
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

  app.get('/api/stats', asyncRoute(async (_req, res) => {
    const [problems, participants, contests, judged] = await Promise.all([
      archiveRows(db, null).then((rows) => rows.length),
      db.collection('users').countDocuments({ role: 'participant' }),
      db.collection('contests').countDocuments({ status: { $in: ['ended', 'published'] } }),
      db.collection('submissions').estimatedDocumentCount(),
    ]);
    res.json({ problems, participants, contests, submissions: judged, languages: SOURCE_LANGUAGES.length });
  }));

  app.get('/api/archive/:problemId', asyncRoute(async (req, res) => {
    await assertArchiveAccess(db, req.params.problemId);
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
    await assertArchiveAccess(db, String(version.problemId));
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

  app.post('/api/contests/:id/submissions', asyncRoute(async (req, res) => {
    const user = auth(req);
    await assertVerified(db, user.sub);
    const body = z.object({
      problemVersionId: z.string(),
      language: z.enum(SOURCE_LANGUAGES),
      code: z.string().min(1).max(64_000),
    }).parse(req.body);
    await submitLimit(user.sub);
    const queued = await enqueueSubmission(db, { ...body, userId: user.sub, contestId: req.params.id, kind: 'contest', idempotencyKey: idempotencyKey(req) });
    if (!queued.replay) {
      await redis.xadd(queued.stream, '*', 'submissionId', queued.id);
    }
    res.status(queued.replay ? 200 : 202).json({ id: queued.id, replay: queued.replay });
  }));

  app.post('/api/contests/:id/rejudge', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['organiser', 'admin']);
    const body = z.object({
      reason: z.string().min(3).max(500),
      submissionId: z.string().optional(),
      problemId: z.string().optional(),
    }).parse(req.body);
    const result = await rejudgeSubmissions(db, redis, { contestId: req.params.id, actor: user.sub, reason: body.reason, submissionId: body.submissionId, problemId: body.problemId });
    await audit(db, user.sub, 'contest.rejudge', req.params.id, 'allow', { before: result.before, after: result.after, reason: body.reason });
    res.status(202).json({ count: result.count });
  }));

  app.post('/api/run', asyncRoute(async (req, res) => {
    const user = auth(req);
    await assertVerified(db, user.sub);
    const body = z.object({
      problemVersionId: z.string(),
      language: z.enum(SOURCE_LANGUAGES),
      code: z.string().min(1).max(64_000),
      contestId: z.string().optional(),
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
    await assertArchiveAccess(db, String(version.problemId));
    await submitLimit(user.sub);
    const queued = await enqueueSubmission(db, { ...body, userId: user.sub, kind: 'practice', idempotencyKey: idempotencyKey(req) });
    if (!queued.replay) {
      await redis.xadd(queued.stream, '*', 'submissionId', queued.id);
    }
    res.status(queued.replay ? 200 : 202).json({ id: queued.id, replay: queued.replay });
  }));

  app.get('/api/contests/:id/leaderboard', asyncRoute(async (req, res) => {
    const viewer = optionalAuth(req);
    const reveal = viewer !== null && (viewer.role === 'organiser' || viewer.role === 'admin');
    res.json(await leaderboard(db, req.params.id, { reveal }));
  }));

  async function queueOutbox(type: string, payload: Record<string, unknown>) {
    await db.collection('outbox').insertOne({ type, payload, createdAt: new Date(), sentAt: null });
  }

  async function requireLiveContest(contestId: ObjectId) {
    const contest = await db.collection('contests').findOne({ _id: contestId });
    if (!contest) throw new HttpError(404, 'Contest not found');
    if (!['running', 'frozen'].includes(contest.status as string)) throw new HttpError(409, 'Contest is not running');
    if (contest.type === 'coding') throw new HttpError(409, 'This contest has no quiz');
    return contest;
  }

  app.post('/api/contests/:id/quiz', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['organiser', 'admin']);
    const body = z.object({
      prompt: z.string(),
      options: z.array(z.string()).min(2),
      correctIndex: z.number().int().nonnegative(),
      basePoints: z.number().int().positive().default(1000),
      windowSec: z.number().int().positive().default(30),
    }).parse(req.body);
    const inserted = await db.collection('quiz_questions').insertOne({
      contestId: new ObjectId(req.params.id),
      ...body,
      opensAt: null,
    });
    await audit(db, user.sub, 'quiz.create', String(inserted.insertedId), 'allow');
    res.status(201).json({ id: String(inserted.insertedId) });
  }));

  app.post('/api/contests/:id/quiz/next', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['organiser', 'admin']);
    const contestId = new ObjectId(req.params.id);
    await requireLiveContest(contestId);
    const open = await db.collection('quiz_questions').findOne({ contestId, opensAt: { $gt: new Date(Date.now() - 120_000) } }, { sort: { opensAt: -1 } });
    if (open && Date.now() - (open.opensAt as Date).getTime() < (open.windowSec as number) * 1000) {
      throw new HttpError(409, 'The current question is still open');
    }
    const used = await db.collection('quiz_questions').find({ contestId }).project({ prompt: 1 }).toArray();
    const next = await db.collection('quiz_bank').find({ prompt: { $nin: used.map((row) => row.prompt) } }).limit(1).next();
    if (!next) throw new HttpError(404, 'The quiz bank is empty');
    const opensAt = new Date();
    const inserted = await db.collection('quiz_questions').insertOne({
      contestId,
      prompt: next.prompt,
      options: next.options,
      correctIndex: next.correctIndex,
      basePoints: next.basePoints ?? 1000,
      windowSec: next.windowSec ?? 30,
      opensAt,
    });
    await audit(db, user.sub, 'quiz.open', String(inserted.insertedId), 'allow');
    await queueOutbox('QuizOpened', { contestId: req.params.id, questionId: String(inserted.insertedId) });
    res.status(201).json({ id: String(inserted.insertedId), prompt: next.prompt, opensAt });
  }));

  app.post('/api/quiz/:id/open', asyncRoute(async (req, res) => {
    requireRole(req, ['organiser', 'admin']);
    const question = await db.collection('quiz_questions').findOne({ _id: new ObjectId(req.params.id) });
    if (!question) throw new HttpError(404, 'Question not found');
    if (question.opensAt) throw new HttpError(409, 'Question was already opened');
    await requireLiveContest(question.contestId as ObjectId);
    const opensAt = new Date();
    await db.collection('quiz_questions').updateOne({ _id: question._id }, { $set: { opensAt } });
    await queueOutbox('QuizOpened', { contestId: String(question.contestId), questionId: req.params.id });
    res.json({ opensAt });
  }));

  app.get('/api/contests/:id/quiz/current', asyncRoute(async (req, res) => {
    const user = auth(req);
    const question = await db.collection('quiz_questions')
      .find({ contestId: new ObjectId(req.params.id), opensAt: { $ne: null } })
      .sort({ opensAt: -1 })
      .limit(1)
      .next();
    const now = new Date();
    const answer = question
      ? await db.collection('quiz_answers').findOne({ questionId: question._id, userId: new ObjectId(user.sub) })
      : null;
    const closed = question ? now.getTime() - (question.opensAt as Date).getTime() > (question.windowSec as number) * 1000 : false;
    res.json({
      serverNow: now.toISOString(),
      question: question ? {
        id: String(question._id),
        prompt: question.prompt,
        options: question.options,
        basePoints: question.basePoints,
        windowSec: question.windowSec,
        opensAt: question.opensAt,
        closed,
        correctIndex: closed ? question.correctIndex : null,
      } : null,
      answer: answer ? { choice: answer.choice, score: answer.score } : null,
    });
  }));

  app.post('/api/quiz/:id/answer', asyncRoute(async (req, res) => {
    const user = auth(req);
    const body = z.object({ choice: z.number().int().nonnegative() }).parse(req.body);
    const question = await db.collection('quiz_questions').findOne({ _id: new ObjectId(req.params.id) });
    if (!question?.opensAt) throw new HttpError(409, 'Question is not open');
    const receivedAt = new Date();
    await requireLiveContest(question.contestId as ObjectId);
    const seat = await db.collection('seats').findOne({
      contestId: question.contestId,
      userId: new ObjectId(user.sub),
      status: { $in: ['reserved', 'modified', 'competing'] },
    });
    if (!seat) throw new HttpError(403, 'A reserved seat is required');
    if (body.choice >= (question.options as string[]).length) throw new HttpError(400, 'No such option');
    const t = (receivedAt.getTime() - (question.opensAt as Date).getTime()) / 1000;
    const correct = body.choice === question.correctIndex;
    const earlier = await db.collection('quiz_answers').find({ contestId: question.contestId, userId: new ObjectId(user.sub) }).sort({ receivedAt: 1 }).toArray();
    let priorCorrect = 0;
    for (const answer of earlier) priorCorrect = (answer.score as number) > 0 ? priorCorrect + 1 : 0;
    const base = quizScore(question.basePoints as number, t, question.windowSec as number, correct);
    const bonus = correct && base !== null ? streakBonus(question.basePoints as number, priorCorrect) : 0;
    const score = base === null ? null : base + bonus;
    if (score === null) throw new HttpError(409, 'Answer window has closed');
    try {
      await db.collection('quiz_answers').insertOne({
        questionId: question._id,
        contestId: question.contestId,
        userId: new ObjectId(user.sub),
        choice: body.choice,
        score,
        receivedAt,
      });
    } catch (error) {
      if (isDuplicateKey(error)) throw new HttpError(409, 'You already answered this question');
      throw error;
    }
    await queueOutbox('QuizAnswered', { contestId: String(question.contestId), userId: user.sub });
    res.json({ score, correct, streak: correct ? priorCorrect + 1 : 0 });
  }));

  /** Sandbox-heavy work runs after the response; the client polls. At most two at a time per process. */
  let backgroundJobs = 0;
  function background(label: string, job: () => Promise<void>) {
    if (backgroundJobs >= 2) throw new HttpError(429, 'Two checks are already running; try again shortly');
    backgroundJobs += 1;
    void job()
      .catch((error) => deps.log?.info({ err: error }, label))
      .finally(() => { backgroundJobs -= 1; });
  }

  app.post('/api/problem-versions/:id/publish-check', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['setter', 'admin']);
    const claimed = await db.collection('problem_versions').findOneAndUpdate(
      { _id: new ObjectId(req.params.id), status: { $in: ['draft', 'blocked'] } },
      { $set: { status: 'checking', report: [] } },
    );
    if (!claimed) throw new HttpError(409, 'Only a draft or blocked version can be checked');
    const versionId = req.params.id;
    try {
      background('publish-check', async () => {
        try {
          const report = await runPublishCheck(db, versionId, deps.runCase ?? runInSandbox);
          await audit(db, user.sub, 'problem.publish-check', versionId, report.ok ? 'published' : 'blocked');
        } catch (error) {
          await db.collection('problem_versions').updateOne(
            { _id: new ObjectId(versionId) },
            { $set: { status: 'blocked', report: [`check failed: ${error instanceof Error ? error.message : 'error'}`] } },
          );
          throw error;
        }
      });
    } catch (error) {
      await db.collection('problem_versions').updateOne({ _id: claimed._id }, { $set: { status: claimed.status } });
      throw error;
    }
    res.status(202).json({ status: 'checking' });
  }));

  app.get('/api/admin/audit', asyncRoute(async (req, res) => {
    requireRole(req, ['admin']);
    const q = String(req.query.q ?? '').trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = q ? { $or: ['action', 'actor', 'target', 'decision'].map((field) => ({ [field]: { $regex: q, $options: 'i' } })) } : {};
    const rows = await auditCollection(db).find(filter).sort({ at: -1 }).limit(100).toArray();
    res.json(rows.map((r) => ({ ...r, _id: String(r._id) })));
  }));

  app.get('/api/admin/users', asyncRoute(async (req, res) => {
    requireRole(req, ['admin']);
    const q = String(req.query.q ?? '').trim();
    const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const filter = q ? { $or: [{ email: { $regex: escaped, $options: 'i' } }, { displayName: { $regex: escaped, $options: 'i' } }] } : {};
    const rows = await db.collection('users').find(filter).project({ passwordHash: 0 }).sort({ createdAt: -1 }).limit(50).toArray();
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

  app.post('/api/admin/workers', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['admin']);
    const body = z.object({ name: z.string(), slots: z.number().int().positive() }).parse(req.body);
    const inserted = await db.collection('workers').insertOne({ ...body, status: 'active', lastSeen: new Date() });
    await audit(db, user.sub, 'worker.register', String(inserted.insertedId), 'allow');
    res.status(201).json({ id: String(inserted.insertedId) });
  }));

  app.post('/api/admin/workers/:id/drain', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['admin']);
    await db.collection('workers').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'draining' } });
    await audit(db, user.sub, 'worker.drain', req.params.id, 'allow');
    res.json({ status: 'draining' });
  }));

  app.post('/api/admin/workers/:id/evict', asyncRoute(async (req, res) => {
    const user = requireRole(req, ['admin']);
    await db.collection('workers').updateOne({ _id: new ObjectId(req.params.id) }, { $set: { status: 'evicted' } });
    await audit(db, user.sub, 'worker.evict', req.params.id, 'allow');
    res.json({ status: 'evicted' });
  }));

  app.get('/api/admin/workers', asyncRoute(async (req, res) => {
    requireRole(req, ['admin']);
    const rows = await db.collection('workers').find({}).toArray();
    res.json(rows.map((w) => ({ id: String(w._id), name: w.name, slots: w.slots, status: w.status })));
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

/** Latest published version of every problem not held by an unpublished contest, with stats, in three queries. */
async function archiveRows(db: Db, viewerId: string | null): Promise<ArchiveRow[]> {
  const [versions, held] = await Promise.all([
    db.collection('problem_versions').aggregate([
      { $match: { status: 'published' } },
      { $sort: { version: -1 } },
      { $group: { _id: '$problemId', doc: { $first: { _id: '$_id', title: '$title', tags: '$tags', difficulty: '$difficulty', rating: '$rating', source: '$source' } } } },
    ]).toArray(),
    db.collection('contests').distinct('problemIds', { status: { $ne: 'published' } }),
  ]);
  const hidden = new Set(held.map(String));
  const visible = versions.filter((row) => !hidden.has(String(row._id)));
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
