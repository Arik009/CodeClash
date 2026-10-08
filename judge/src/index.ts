import { defaultLimit, type SourceLanguage } from '@codeclash/shared';
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';
import { judgeCases } from './decide.js';
import { runInDocker } from './runner.js';

const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash');
await mongo.connect();
const db = mongo.db();
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);
const workerId = process.env.WORKER_ID ?? `worker-${hostname()}`;
const slots = Math.max(1, Number(process.env.JUDGE_SLOTS ?? 4));
const group = 'judges';

for (const stream of ['judge:contest', 'judge:practice']) {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (error) {
    if (!String(error).includes('BUSYGROUP')) throw error;
  }
}

type Entry = [string, string[]];

function submissionIdOf(fields: string[]) {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'submissionId') return fields[i + 1];
  return undefined;
}

async function handle(stream: string, id: string, submissionId: string) {
  const token = randomBytes(16).toString('hex');
  const claimed = await db.collection('submissions').findOneAndUpdate(
    { _id: new ObjectId(submissionId), status: 'queued' },
    { $set: { status: 'claimed', claimToken: token, workerId } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    await redis.xack(stream, group, id);
    return;
  }
  const version = await db.collection('problem_versions').findOne({ _id: claimed.problemVersionId });
  const tests = (version?.tests as { input: string; output: string }[]) ?? [];
  const limits = (version?.limits as Record<string, { timeMs: number; memoryMb: number }>) ?? {};
  const language = claimed.language as SourceLanguage;
  const limit = limits[language] ?? defaultLimit(language);
  await db.collection('submissions').updateOne({ _id: claimed._id, claimToken: token }, { $set: { status: 'running' } });
  const request = { language, code: claimed.code as string, timeMs: limit.timeMs, memoryMb: limit.memoryMb };
  const run = (test: { input: string; output: string }) => runInDocker({ ...request, stdin: test.input, expected: test.output });
  const result = await judgeCases(tests, run);
  const saved = await db.collection('submissions').updateOne(
    { _id: claimed._id, claimToken: token, status: { $in: ['claimed', 'running'] } },
    { $set: { status: 'judged', verdict: result.verdict, reason: result.reason, judgedAt: new Date() } },
  );
  if (saved.matchedCount === 1) {
    await redis.xack(stream, group, id);
  }
}

async function slotLoop(index: number) {
  const conn = new Redis(redisUrl);
  const consumer = `${workerId}#${index}`;
  for (;;) {
    const streams = ['judge:contest', 'judge:practice'];
    const reply = await conn.xreadgroup(
      'GROUP', group, consumer, 'COUNT', 1, 'BLOCK', 2000,
      'STREAMS', ...streams, ...streams.map(() => '>'),
    ) as [string, Entry[]][] | null;
    for (const [stream, messages] of reply ?? []) {
      for (const [id, fields] of messages) {
        const submissionId = submissionIdOf(fields);
        if (submissionId) await handle(stream, id, submissionId);
        else await conn.xack(stream, group, id);
      }
    }
  }
}

Promise.all(Array.from({ length: slots }, (_, index) => slotLoop(index)))
  .then(async () => {
    redis.disconnect();
    await mongo.close();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
