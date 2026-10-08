import { hash } from '@node-rs/argon2';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, type Db } from 'mongodb';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import { createApp } from './app.js';

let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

const redis = {
  async xadd() { return '0-1'; },
  async publish() { return 1; },
  async incr(key: string) {
    redis.counts[key] = (redis.counts[key] ?? 0) + 1;
    return redis.counts[key]!;
  },
  async expire() { return 1; },
  async get() { return 'ok'; },
  counts: {} as Record<string, number>,
};

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db('codeclash-http');
  await ensureIndexes(db);
  await db.collection('users').insertOne({
    email: 'admin@codeclash.local',
    passwordHash: await hash('codeclash'),
    displayName: 'Admin',
    role: 'admin',
    createdAt: new Date(),
  });
}, 180000);

afterAll(async () => {
  await client.close();
  await repl.stop();
});

describe('authz', () => {
  it('signs up, confirms the email and rejects a wrong password', async () => {
    const app = createApp({ db, redis });
    const registered = await request(app).post('/api/auth/register').send({
      email: 'neha@example.com',
      password: 'longpassword',
      displayName: 'Neha',
    });
    expect(registered.status).toBe(201);
    if (registered.body.verifyToken) {
      expect((await request(app).post('/api/auth/verify').send({ token: registered.body.verifyToken })).status).toBe(200);
    }
    const admin = await request(app).post('/api/auth/login').send({
      email: 'admin@codeclash.local',
      password: 'codeclash',
    });
    expect(admin.status).toBe(200);

    const wrong = await request(app).post('/api/auth/login').send({
      email: 'admin@codeclash.local',
      password: 'nope',
    });
    expect(wrong.status).toBe(401);
  });
});

describe('routes', () => {
  it('revokes the whole refresh chain when a used token is replayed', async () => {
    const app = createApp({ db, redis });
    const login = await request(app).post('/api/auth/login').send({ email: 'neha@example.com', password: 'longpassword' });
    const first = login.body.refresh as string;
    const rotated = await request(app).post('/api/auth/refresh').send({ refresh: first });
    expect(rotated.status).toBe(200);
    const replay = await request(app).post('/api/auth/refresh').send({ refresh: first });
    expect(replay.status).toBe(401);
    const afterReplay = await request(app).post('/api/auth/refresh').send({ refresh: rotated.body.refresh });
    expect(afterReplay.status).toBe(401);
  });
});
