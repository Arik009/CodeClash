import { defaultLimits } from '@codeclash/shared';
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { MongoClient, ObjectId } from 'mongodb';
import { CATALOG, QUIZ_BANK } from './catalog.js';
import { MORE } from './catalog-more.js';
import { ensureIndexes } from './db/indexes.js';

const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
await ensureIndexes(db);

const passwordHash = await hash('codeclash');
const admin = await db.collection('users').findOneAndUpdate(
  { email: 'admin@codeclash.local' },
  {
    $set: { emailVerified: true, rating: 1200 },
    $setOnInsert: { email: 'admin@codeclash.local', passwordHash, displayName: 'Admin', role: 'admin', createdAt: new Date() },
  },
  { upsert: true, returnDocument: 'after' },
);

const contestProblemIds: ObjectId[] = [];
const archiveProblemIds: ObjectId[] = [];
for (const item of [...CATALOG, ...MORE]) {
  const pool = item.pool ?? (item.contest ? 'warmup' : 'practice');
  let problem = await db.collection('problems').findOne({ title: item.title });
  if (!problem) {
    const inserted = await db.collection('problems').insertOne({
      title: item.title,
      statement: item.statement,
      samples: item.samples,
      editorial: item.editorial,
      tags: item.tags,
      createdBy: admin?._id,
      createdAt: new Date(),
    });
    problem = await db.collection('problems').findOne({ _id: inserted.insertedId });
  }
  if (!problem) continue;
  const version = {
    problemId: problem._id,
    version: 1,
    title: item.title,
    statement: item.statement,
    samples: item.samples,
    editorial: item.editorial,
    tags: item.tags,
    difficulty: item.difficulty ?? 'easy',
    limits: defaultLimits(),
    subtasks: item.subtasks ?? [],
    tests: item.tests,
    reference: { language: 'python', code: item.reference },
    wrongSolutions: [{ label: 'incorrect', language: 'python', code: item.wrong }],
    status: 'published',
    report: [],
  };
  await db.collection('problem_versions').updateOne(
    { problemId: problem._id, version: 1 },
    { $set: version },
    { upsert: true },
  );
  if (pool === 'warmup') contestProblemIds.push(problem._id);
  if (pool === 'archive') archiveProblemIds.push(problem._id);
}

const now = Date.now();
await db.collection('contests').updateOne(
  { title: 'Warmup round' },
  {
    $set: {
      title: 'Warmup round',
      type: 'mixed',
      capacity: 200,
      status: 'running',
      scoringMode: 'icpc',
      problemIds: contestProblemIds,
      startsAt: new Date(now - 60_000),
      endsAt: new Date(now + 4 * 3600_000),
      freezeAt: new Date(now + 3 * 3600_000),
      registrationOpensAt: new Date(now - 3600_000),
    },
    $setOnInsert: { reserved: 0, waitlistSeq: 0, createdBy: admin?._id },
  },
  { upsert: true },
);

const day = 24 * 3600_000;
await db.collection('contests').updateOne(
  { title: 'Library cup' },
  {
    $set: {
      title: 'Library cup',
      type: 'coding',
      capacity: 200,
      status: 'published',
      scoringMode: 'icpc',
      problemIds: archiveProblemIds,
      ratingsApplied: false,
      startsAt: new Date(now - 14 * day),
      freezeAt: new Date(now - 14 * day + 3 * 3600_000),
      endsAt: new Date(now - 14 * day + 4 * 3600_000),
      registrationOpensAt: new Date(now - 15 * day),
    },
    $setOnInsert: { reserved: 0, waitlistSeq: 0, createdBy: admin?._id },
  },
  { upsert: true },
);

for (const question of QUIZ_BANK) {
  await db.collection('quiz_bank').updateOne(
    { prompt: question.prompt },
    { $setOnInsert: { ...question, basePoints: 1000, windowSec: 30 } },
    { upsert: true },
  );
}

console.log(`seeded ${CATALOG.length + MORE.length} problems, ${QUIZ_BANK.length} quiz questions`);
console.log('contests: Warmup round (live), Library cup (published, in the problemset)');
console.log('admin@codeclash.local / codeclash');
await client.close();
