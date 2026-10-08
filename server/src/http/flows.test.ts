import { hash } from '@node-rs/argon2';
import type { Express } from 'express';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import type { RunCase } from '../domain/problems.js';
import { createApp } from './app.js';

let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;
let app: Express;

const redis = {
  published: [] as string[],
  added: [] as string[][],
  async xadd(...args: string[]) { redis.added.push(args); return '0-1'; },
  async publish(channel: string) { redis.published.push(channel); return 1; },
  async incr() { return 1; },
  async expire() { return 1; },
  async get() { return 'ok'; },
};

/** Code containing REF doubles the last number; anything else echoes the first token. */
const runCase: RunCase = async ({ code, stdin, expected }) => {
  const numbers = stdin.match(/-?\d+/g) ?? [];
  const stdout = code.includes('REF') ? `${2 * Number(numbers.at(-1) ?? 0)}\n` : `${stdin.trim().split(/\s+/)[0] ?? ''}\n`;
  if (expected === '') return { verdict: 'AC', stdout };
  return { verdict: stdout.trim() === expected.trim() ? 'AC' : 'WA', stdout };
};

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
function api(method: Method, path: string, token?: string, body?: unknown) {
  const req = request(app)[method](path);
  if (token) req.set('authorization', `Bearer ${token}`);
  return body === undefined ? req : req.send(body as object);
}

let neha = { token: '', id: '' };
let ravi = { token: '', id: '' };
let problemId = '';
let versionId = '';

async function signUp(email: string, displayName: string) {
  const res = await api('post', '/api/auth/register', undefined, { email, password: 'longpassword', displayName });
  expect(res.status).toBe(201);
  if (res.body.verifyToken) {
    expect((await api('post', '/api/auth/verify', undefined, { token: res.body.verifyToken })).body.emailVerified).toBe(true);
  }
  return { token: res.body.access as string, id: res.body.user.id as string, refresh: res.body.refresh as string };
}

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db('codeclash-flows');
  await ensureIndexes(db);
  await db.collection('users').insertOne({
    email: 'admin@codeclash.local',
    passwordHash: await hash('codeclash'),
    displayName: 'Admin',
    role: 'admin',
    createdAt: new Date(),
  });
  app = createApp({ db, redis, runCase });
  neha = await signUp('neha@example.com', 'Neha');
  ravi = await signUp('ravi@example.com', 'Ravi');
}, 180000);

afterAll(async () => {
  await client.close();
  await repl.stop();
});

describe('practice', () => {
  beforeAll(async () => {
    const problem = await db.collection('problems').insertOne({ title: 'Double' });
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId, version: 1, status: 'published', title: 'Double', statement: 'Print twice n.',
      samples: 'input\n4\noutput\n8\n', editorial: 'Multiply by two.', tags: ['math'],
      tests: [{ input: '4\n', output: '8\n', hidden: false }, { input: '-3\n', output: '-6\n', hidden: true }],
      limits: { python: { timeMs: 1000, memoryMb: 128 } },
    });
    problemId = String(problem.insertedId);
    versionId = String(version.insertedId);
  });

  it('lists the archive and opens a problem from it', async () => {
    const archive = await api('get', '/api/archive');
    expect(archive.body.items.map((row: { versionId: string }) => row.versionId)).toContain(versionId);
    expect(archive.body).toMatchObject({ page: 1, pageSize: 50, tags: expect.arrayContaining(['math']) });
    const paged = await api('get', '/api/archive?pageSize=1&page=1');
    expect(paged.body.items).toHaveLength(1);
    expect(paged.body.total).toBe(archive.body.total);
    expect((await api('get', `/api/archive/${problemId}`)).body.title).toBe('Double');
    const open = await api('get', `/api/problem-versions/${versionId}/public`);
    expect(open.body).toMatchObject({ tags: ['math'], limits: { python: { timeMs: 1000, memoryMb: 128 } } });
  });

  it('accepts practice submissions on archived problems', async () => {
    const sent = await api('post', '/api/practice/submissions', ravi.token, { problemVersionId: versionId, language: 'javascript', code: 'console.log(1)' });
    expect(sent.status).toBe(202);
    expect((await api('post', '/api/practice/submissions', ravi.token, { problemVersionId: String(new ObjectId()), language: 'python', code: 'x' })).status).toBe(404);
  });

  it('replays the same idempotency key and runs samples without storing', async () => {
    const first = await request(app)
      .post('/api/practice/submissions')
      .set('authorization', `Bearer ${ravi.token}`)
      .set('idempotency-key', 'practice-once')
      .send({ problemVersionId: versionId, language: 'python', code: 'print(1)' });
    const second = await request(app)
      .post('/api/practice/submissions')
      .set('authorization', `Bearer ${ravi.token}`)
      .set('idempotency-key', 'practice-once')
      .send({ problemVersionId: versionId, language: 'python', code: 'print(9)' });
    expect(first.status).toBe(202);
    expect(second.status).toBe(200);
    expect(second.body.replay).toBe(true);
    expect(second.body.id).toBe(first.body.id);

    const ran = await api('post', '/api/run', neha.token, { problemVersionId: versionId, language: 'python', code: '# REF' });
    expect(ran.body.results[0].verdict).toBe('AC');
    expect(await db.collection('submissions').countDocuments({ code: '# REF' })).toBe(0);
  });
});

describe('accounts and administration', () => {
  it('manages sessions, profiles and duplicate sign-ups', async () => {
    const me = await api('get', '/api/me', neha.token);
    expect(me.body).toMatchObject({ displayName: 'Neha', email: 'neha@example.com' });
    expect((await api('get', '/api/me')).status).toBe(401);
    expect((await api('post', '/api/auth/register', undefined, { email: 'neha@example.com', password: 'longpassword', displayName: 'N' })).status).toBe(409);
    expect((await api('post', '/api/auth/register', undefined, { email: 'bad', password: 'x', displayName: '' })).status).toBe(400);

    const session = await signUp('temp@example.com', 'Temp');
    expect((await api('post', '/api/auth/logout', undefined, { refresh: session.refresh })).status).toBe(204);
    expect((await api('post', '/api/auth/refresh', undefined, { refresh: session.refresh })).status).toBe(401);
    expect((await api('get', '/health')).body).toEqual({ ok: true, mongo: true, redis: true });
  });
});
