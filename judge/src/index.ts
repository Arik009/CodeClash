import { defaultLimit, type SourceLanguage } from '@codeclash/shared';
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';
import { canTakePractice } from './slots.js';
import { judgeCases, judgeSubtasks } from './decide.js';
import { runInDocker } from './runner.js';

const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash');
await mongo.connect();
const db = mongo.db();
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);
const workerId = process.env.WORKER_ID ?? `worker-${hostname()}`;
const slots = Math.max(1, Number(process.env.JUDGE_SLOTS ?? 4));
const group = 'judges';
const reclaimIdleMs = 60_000;

for (const stream of ['judge:contest', 'judge:practice']) {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (error) {
    if (!String(error).includes('BUSYGROUP')) throw error;
  }
}

await db.collection('workers').updateOne(
  { name: workerId },
  { $set: { name: workerId, slots, status: 'active', lastSeen: new Date() } },
  { upsert: true },
);

type Entry = [string, string[]];

function submissionIdOf(fields: string[]) {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'submissionId') return fields[i + 1];
  return undefined;
}

async function workerStatus() {
  const worker = await db.collection('workers').findOne({ name: workerId });
  return (worker?.status as string | undefined) ?? 'active';
}

/** Entries left unacked here are picked up by another worker through XAUTOCLAIM. */
async function handle(stream: string, id: string, submissionId: string) {
  const status = await workerStatus();
  if (status === 'draining' || status === 'evicted') return;
  const token = randomBytes(16).toString('hex');
  const claimed = await db.collection('submissions').findOneAndUpdate(
    { _id: new ObjectId(submissionId), status: { $in: ['queued', 'claimed', 'running'] } },
    { $set: { status: 'claimed', claimToken: token, workerId } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    await redis.xack(stream, group, id);
    return;
  }
  if (claimed.kind === 'practice') await redis.incr('practice:inflight');
  try {
    const version = await db.collection('problem_versions').findOne({ _id: claimed.problemVersionId });
    const tests = (version?.tests as { input: string; output: string; group?: string }[]) ?? [];
    const subtasks = (version?.subtasks as { name: string; points: number }[]) ?? [];
    const limits = (version?.limits as Record<string, { timeMs: number; memoryMb: number }>) ?? {};
    const language = claimed.language as SourceLanguage;
    const limit = limits[language] ?? defaultLimit(language);
    await db.collection('submissions').updateOne({ _id: claimed._id, claimToken: token }, { $set: { status: 'running' } });
    const run = (test: { input: string; output: string }) => runInDocker({
      language,
      code: claimed.code as string,
      stdin: test.input,
      expected: test.output,
      timeMs: limit.timeMs,
      memoryMb: limit.memoryMb,
    });
    const result = subtasks.length > 0 ? await judgeSubtasks(tests, subtasks, run) : await judgeCases(tests, run);
    const points = 'points' in result ? result.points : result.verdict === 'AC' ? 100 : 0;
    const saved = await db.collection('submissions').updateOne(
      { _id: claimed._id, claimToken: token, status: { $in: ['claimed', 'running'] } },
      { $set: { status: 'judged', verdict: result.verdict, reason: result.reason, points, judgedAt: new Date() } },
    );
    if (saved.matchedCount === 1) {
      await db.collection('outbox').insertOne({
        type: 'VerdictCommitted',
        payload: {
          submissionId,
          contestId: claimed.contestId ? String(claimed.contestId) : null,
          userId: String(claimed.userId),
          problemId: String(claimed.problemId),
          verdict: result.verdict,
          kind: claimed.kind,
          submittedAt: claimed.submittedAt,
        },
        createdAt: new Date(),
        sentAt: null,
      });
      await redis.xack(stream, group, id);
    }
  } finally {
    if (claimed.kind === 'practice') await redis.decr('practice:inflight');
  }
}

async function streamsToRead() {
  const [running, backlog, inflight] = await Promise.all([
    db.collection('contests').countDocuments({ status: { $in: ['running', 'frozen'] } }),
    db.collection('submissions').countDocuments({ kind: 'contest', status: 'queued' }),
    redis.get('practice:inflight'),
  ]);
  const streams = ['judge:contest'];
  if (canTakePractice(slots, running > 0, Number(inflight ?? 0), backlog)) streams.push('judge:practice');
  return streams;
}

async function slotLoop(index: number) {
  const conn = new Redis(redisUrl);
  const consumer = `${workerId}#${index}`;
  for (;;) {
    const status = await workerStatus();
    if (status === 'evicted') break;
    if (status === 'draining') {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      continue;
    }
    const streams = await streamsToRead();
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
    for (const stream of ['judge:contest', 'judge:practice']) {
      const [, entries] = await conn.xautoclaim(stream, group, consumer, reclaimIdleMs, '0-0', 'COUNT', 1) as [string, Entry[]];
      for (const [id, fields] of entries ?? []) {
        const submissionId = submissionIdOf(fields);
        if (submissionId) await handle(stream, id, submissionId);
      }
    }
  }
  conn.disconnect();
}

const heartbeat = setInterval(() => {
  void (async () => {
    await db.collection('workers').updateOne({ name: workerId }, { $set: { lastSeen: new Date() } });
    await db.collection('workers').updateMany(
      { name: { $ne: workerId }, status: 'active', lastSeen: { $lt: new Date(Date.now() - 90_000) } },
      { $set: { status: 'stale' } },
    );
  })().catch((error) => console.error('heartbeat', error));
}, 5000);

Promise.all(Array.from({ length: slots }, (_, index) => slotLoop(index)))
  .then(async () => {
    clearInterval(heartbeat);
    redis.disconnect();
    await mongo.close();
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
