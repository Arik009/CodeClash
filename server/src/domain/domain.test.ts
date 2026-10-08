import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import { tickContests, transitionContest } from './contests.js';
import { HttpError } from './errors.js';
import { claimSubmission, commitVerdict, enqueueSubmission, reclaimSubmission } from './judging.js';
import { testsFromZip } from './problems.js';
import { reserveSeat, seatInvariants, withdrawSeat } from './registration.js';
import { dispatchOutbox, leaderboard } from './scoring.js';
import AdmZip from 'adm-zip';

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
    const results = await mapPool(ids, 40, (id) => reserveSeat(db, contestId, id));
    const reserved = results.filter((r) => r.outcome === 'reserved');
    const waitlisted = results.filter((r) => r.outcome === 'waitlisted');
    expect(reserved).toHaveLength(200);
    expect(waitlisted).toHaveLength(200);
    const again = await reserveSeat(db, contestId, ids[0]!);
    expect(again.outcome).toBe('existing');
    const inv = await seatInvariants(db, contestId);
    expect(inv.overCapacity).toBe(false);
    expect(inv.countMismatch).toBe(false);
    expect(inv.duplicateUsers).toBe(0);
    expect(inv.reserved).toBe(200);
  });

  it('promotes the waitlist head, and decrements reserved when the waitlist is empty', async () => {
    const contestId = await openContest(1);
    const a = await user();
    const b = await user();
    const first = await reserveSeat(db, contestId, a);
    const second = await reserveSeat(db, contestId, b);
    expect(first.outcome).toBe('reserved');
    expect(second.outcome).toBe('waitlisted');
    const promoted = await withdrawSeat(db, first.seatId, a);
    expect(promoted.promotedUserId).toBe(b);
    let inv = await seatInvariants(db, contestId);
    expect(inv.reserved).toBe(1);
    const bSeat = await db.collection('seats').findOne({ contestId: new ObjectId(contestId), userId: new ObjectId(b), active: true });
    await withdrawSeat(db, String(bSeat!._id), b);
    inv = await seatInvariants(db, contestId);
    expect(inv.reserved).toBe(0);
    expect(inv.reservedCount).toBe(0);
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
    const contestId = await openContest(10);
    const uid = await user();
    await db.collection('seats').insertOne({
      contestId: new ObjectId(contestId),
      userId: new ObjectId(uid),
      status: 'competing',
      active: true,
      waitlistPos: null,
      createdAt: new Date(),
    });
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    await db.collection('contests').updateOne(
      { _id: new ObjectId(contestId) },
      { $set: { status: 'running', problemIds: [problem.insertedId], endsAt: new Date(Date.now() + 3600_000) } },
    );
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      status: 'published',
      title: 'p',
      statement: 's',
    });
    const queued = await enqueueSubmission(db, {
      userId: uid,
      contestId,
      problemVersionId: String(version.insertedId),
      language: 'python',
      code: 'print(1)',
      kind: 'contest',
    });
    await claimSubmission(db, queued.id, 'token-a', 'worker-1');
    await reclaimSubmission(db, queued.id, 'token-b', 'worker-2');
    const stale = await commitVerdict(db, queued.id, 'token-a', 'WA', null);
    const fresh = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();
    const again = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(again).toBeNull();
    const board = await leaderboard(db, contestId);
    expect(board[0]?.solved).toBe(1);
  });

  it('refuses a submission without a seat', async () => {
    const contestId = await openContest(10);
    await db.collection('contests').updateOne({ _id: new ObjectId(contestId) }, { $set: { status: 'running' } });
    const version = await db.collection('problem_versions').insertOne({
      problemId: new ObjectId(),
      version: 1,
      status: 'published',
      title: 'p',
    });
    await expect(
      enqueueSubmission(db, {
        userId: await user(),
        contestId,
        problemVersionId: String(version.insertedId),
        language: 'python',
        code: 'print(1)',
        kind: 'contest',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('problems', () => {

  it('reads paired .in and .out files from a zip', () => {
    const zip = new AdmZip();
    zip.addFile('1.in', Buffer.from('1 2\n'));
    zip.addFile('1.out', Buffer.from('3\n'));
    zip.addFile('sample-1.in', Buffer.from('0 0\n'));
    zip.addFile('sample-1.out', Buffer.from('0\n'));
    const tests = testsFromZip(zip.toBuffer());
    expect(tests).toHaveLength(2);
    expect(tests.find((t) => t.input.startsWith('0'))?.hidden).toBe(false);
    expect(tests.find((t) => t.input.startsWith('1'))?.hidden).toBe(true);
  });

  it('scores a judged contest submission from the outbox into the sorted set', async () => {
    const contestId = await openContest(10);
    const uid = await user();
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    const submission = await db.collection('submissions').insertOne({
      userId: new ObjectId(uid),
      contestId: new ObjectId(contestId),
      problemId: problem.insertedId,
      status: 'judged',
      verdict: 'WA',
      kind: 'contest',
      submittedAt: new Date(),
    });
    await db.collection('outbox').insertOne({
      type: 'VerdictCommitted',
      payload: {
        submissionId: String(submission.insertedId),
        contestId,
        userId: uid,
        problemId: String(problem.insertedId),
        verdict: 'WA',
        kind: 'contest',
        submittedAt: new Date(),
      },
      createdAt: new Date(),
      sentAt: null,
    });
    const scores: Record<string, number> = {};
    const events: string[] = [];
    await dispatchOutbox(db, {
      async set() { return 'OK'; },
      async zadd(key, score, member) { scores[`${key}:${member}`] = score; return 1; },
    }, (room, event) => { events.push(`${room}:${event}`); });
    const stored = await db.collection('submissions').findOne({ _id: submission.insertedId });
    expect(stored?.status).toBe('scored');
    expect(scores[`lb:${contestId}:rank:${uid}`]).toBe(0);
    expect(events.some((e) => e.endsWith(':leaderboard'))).toBe(true);
    expect(events.some((e) => e.endsWith(':VerdictCommitted'))).toBe(false);
  });
});

describe('contest rules', () => {
  async function liveContest(overrides: Record<string, unknown> = {}) {
    const problem = await db.collection('problems').insertOne({ title: 'in', statement: 's', samples: '', tags: [] });
    const version = await db.collection('problem_versions').insertOne({ problemId: problem.insertedId, version: 1, status: 'published', title: 'in' });
    const now = Date.now();
    const contest = await db.collection('contests').insertOne({
      title: 'rules',
      type: 'mixed',
      status: 'running',
      capacity: 10,
      reserved: 0,
      waitlistSeq: 0,
      startsAt: new Date(now - 3600_000),
      freezeAt: new Date(now - 60_000),
      endsAt: new Date(now + 3600_000),
      registrationOpensAt: new Date(now - 7200_000),
      scoringMode: 'icpc',
      problemIds: [problem.insertedId],
      ...overrides,
    });
    const uid = await user();
    await db.collection('seats').insertOne({ contestId: contest.insertedId, userId: new ObjectId(uid), status: 'competing', active: true, waitlistPos: null, createdAt: new Date() });
    return { contestId: String(contest.insertedId), versionId: String(version.insertedId), problemId: problem.insertedId, uid };
  }

  it('refuses a problem that is not part of the contest', async () => {
    const { contestId, uid } = await liveContest();
    const other = await db.collection('problem_versions').insertOne({ problemId: new ObjectId(), version: 1, status: 'published', title: 'x' });
    await expect(enqueueSubmission(db, {
      userId: uid, contestId, problemVersionId: String(other.insertedId), language: 'python', code: 'print(1)', kind: 'contest',
    })).rejects.toMatchObject({ status: 400 });
  });
});
