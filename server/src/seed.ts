import { defaultLimits } from '@codeclash/shared';
import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { MongoClient } from 'mongodb';
import { ensureIndexes } from './db/indexes.js';

// First demo data: the admin account and one practice problem, enough to sign in and get a verdict.
const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
await ensureIndexes(db);

const passwordHash = await hash('codeclash');
await db.collection('users').updateOne(
  { email: 'admin@codeclash.local' },
  {
    $set: { emailVerified: true, rating: 1200 },
    $setOnInsert: { email: 'admin@codeclash.local', passwordHash, displayName: 'Admin', role: 'admin', createdAt: new Date() },
  },
  { upsert: true },
);

const statement = [
  'You are given two integers a and b. Print their sum.',
  'Input\nThe only line contains two integers `a` and `b` (`-10^9 ≤ a, b ≤ 10^9`).',
  'Output\nPrint one integer: `a + b`.',
].join('\n\n');
const problem = (await db.collection('problems').findOneAndUpdate(
  { title: 'Sum of two integers' },
  { $set: { statement, samples: 'Input\n1 2\nOutput\n3', tags: ['math'] }, $setOnInsert: { title: 'Sum of two integers', createdAt: new Date() } },
  { upsert: true, returnDocument: 'after' },
))!;
await db.collection('problem_versions').updateOne(
  { problemId: problem._id, version: 1 },
  {
    $set: {
      title: 'Sum of two integers',
      statement,
      samples: 'Input\n1 2\nOutput\n3',
      editorial: 'Read both values and print their sum in 64-bit arithmetic.',
      tags: ['math'],
      difficulty: 'easy',
      limits: defaultLimits(),
      tests: [
        { input: '1 2\n', output: '3\n', hidden: false },
        { input: '-5 5\n', output: '0\n', hidden: true },
        { input: '1000000000 1000000000\n', output: '2000000000\n', hidden: true },
      ],
      reference: { language: 'python', code: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a + b)\n' },
      wrongSolutions: [{ label: 'difference', language: 'python', code: 'import sys\na, b = map(int, sys.stdin.read().split())\nprint(a - b)\n' }],
      status: 'published',
      report: [],
    },
  },
  { upsert: true },
);

console.log('seeded admin@codeclash.local (password "codeclash") and one practice problem');
await client.close();
