import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import { claimSubmission, commitVerdict, enqueueSubmission, reclaimSubmission } from './judging.js';

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
