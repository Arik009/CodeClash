import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import { tickContests, transitionContest } from './contests.js';
import { HttpError } from './errors.js';
import { claimSubmission, commitVerdict, enqueueSubmission, reclaimSubmission } from './judging.js';
import { reserveSeat, seatInvariants } from './registration.js';

let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db('codeclash');
  await ensureIndexes(db);
}, 180000);

afterAll(async () => {
  await client.close();
  await repl.stop();
});

async function openContest(capacity: number) {
  const inserted = await db.collection('contests').insertOne({
    title: 'burst',
    type: 'coding',
    capacity,
    reserved: 0,
    waitlistSeq: 0,
    status: 'registration_open',
    startsAt: new Date(Date.now() + 3600_000),
    endsAt: new Date(Date.now() + 3 * 3600_000),
    freezeAt: new Date(Date.now() + 2 * 3600_000),
    registrationOpensAt: new Date(Date.now() - 3600_000),
    scoringMode: 'icpc',
    problemIds: [],
  });
  return String(inserted.insertedId);
}

async function user() {
  const inserted = await db.collection('users').insertOne({
    email: `${new ObjectId().toHexString()}@example.com`,
    passwordHash: 'x',
    displayName: 'n',
    role: 'participant',
    createdAt: new Date(),
  });
  return String(inserted.insertedId);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

describe('seats', () => {
  it('gives exactly 200 seats to 400 distinct users and no duplicates', async () => {
    const contestId = await openContest(200);
    const ids = await mapPool(Array.from({ length: 400 }), 40, () => user());
    const results = await mapPool(ids, 40, (id) => reserveSeat(db, contestId, id).catch((error: { status?: number }) => error));
    const reserved = results.filter((r) => 'outcome' in r && r.outcome === 'reserved');
    const full = results.filter((r) => 'status' in r && r.status === 409);
    expect(reserved).toHaveLength(200);
    expect(full).toHaveLength(200);
    const again = await reserveSeat(db, contestId, ids[0]!);
    expect(again.outcome).toBe('existing');
    const inv = await seatInvariants(db, contestId);
    expect(inv.overCapacity).toBe(false);
    expect(inv.countMismatch).toBe(false);
    expect(inv.duplicateUsers).toBe(0);
    expect(inv.reserved).toBe(200);
  });
});

describe('contests', () => {
  it('rejects a jump from draft to running', async () => {
    const inserted = await db.collection('contests').insertOne({
      title: 'jump',
      status: 'draft',
      capacity: 2,
      reserved: 0,
      waitlistSeq: 0,
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600_000),
      freezeAt: new Date(Date.now() + 1800_000),
      registrationOpensAt: new Date(Date.now() - 2000),
      scoringMode: 'icpc',
      problemIds: [],
      type: 'coding',
    });
    await expect(transitionContest(db, String(inserted.insertedId), 'running', 'organiser')).rejects.toBeInstanceOf(HttpError);
    const moved = await tickContests(db);
    expect(moved).toContain(String(inserted.insertedId));
  });
});

describe('exactly once', () => {
  it('ignores a stale claim token and commits one verdict', async () => {
    const uid = await user();
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      status: 'published',
      title: 'p',
      statement: 's',
    });
    const queued = await enqueueSubmission(db, {
      userId: uid,
      problemVersionId: String(version.insertedId),
      language: 'python',
      code: 'print(1)',
      kind: 'practice',
    });
    await claimSubmission(db, queued.id, 'token-a', 'worker-1');
    await reclaimSubmission(db, queued.id, 'token-b', 'worker-2');
    const stale = await commitVerdict(db, queued.id, 'token-a', 'WA', null);
    const fresh = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();
    const again = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(again).toBeNull();
  });
});
