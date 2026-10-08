import { defaultLimit, type SourceLanguage } from '@codeclash/shared';
import 'dotenv/config';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { MongoClient, ObjectId } from 'mongodb';
import { canTakePractice } from './slots.js';
import { judgeCases } from './decide.js';
import { judgeBatch, runInDocker } from './runner.js';

const mongo = new MongoClient(process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash');
await mongo.connect();
const db = mongo.db();
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const redis = new Redis(redisUrl);
const workerId = process.env.WORKER_ID ?? `worker-${hostname()}`;
const slots = Math.max(1, Number(process.env.JUDGE_SLOTS ?? 4));
const group = 'judges';
const reclaimIdleMs = 60_000;
/** A claim older than this belongs to a worker that died mid-job; it no longer holds a practice slot. */
const inflightWindowMs = 5 * 60_000;

for (const stream of ['judge:contest', 'judge:practice']) {
  try {
    await redis.xgroup('CREATE', stream, group, '$', 'MKSTREAM');
  } catch (error) {
    if (!String(error).includes('BUSYGROUP')) throw error;
  }
}

await db.collection('workers').updateOne(
  { name: workerId },
  { $set: { name: workerId, slots, status: 'active', lastSeen: new Date(), pid: process.pid, host: hostname() } },
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
    { $set: { status: 'claimed', claimToken: token, workerId, claimedAt: new Date() } },
    { returnDocument: 'after' },
  );
  if (!claimed) {
    await redis.xack(stream, group, id);
    return;
  }
  try {
    const version = await db.collection('problem_versions').findOne({ _id: claimed.problemVersionId });
    const tests = (version?.tests as { input: string; output: string; group?: string }[]) ?? [];
    const limits = (version?.limits as Record<string, { timeMs: number; memoryMb: number }>) ?? {};
    const language = claimed.language as SourceLanguage;
    const limit = limits[language] ?? defaultLimit(language);
    await db.collection('submissions').updateOne({ _id: claimed._id, claimToken: token }, { $set: { status: 'running' } });
    const request = { language, code: claimed.code as string, timeMs: limit.timeMs, memoryMb: limit.memoryMb };
    const batched = process.env.JUDGE_BATCH === '1'
      ? new Map((await judgeBatch(request, tests)).map((outcome, i) => [tests[i]!, outcome]))
      : null;
    const run = async (test: { input: string; output: string }) => batched?.get(test)
      ?? runInDocker({ ...request, stdin: test.input, expected: test.output });
    const result = await judgeCases(tests, run);
    const saved = await db.collection('submissions').updateOne(
      { _id: claimed._id, claimToken: token, status: { $in: ['claimed', 'running'] } },
      { $set: { status: 'judged', verdict: result.verdict, reason: result.reason, judgedAt: new Date() } },
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
    await db.collection('submissions').updateOne(
      { _id: claimed._id, claimToken: token, status: { $in: ['claimed', 'running'] } },
      { $unset: { claimedAt: '' } },
    );
  }
}

async function streamsToRead() {
  const [running, backlog, inflight] = await Promise.all([
    db.collection('contests').countDocuments({ status: { $in: ['running', 'frozen'] } }),
    db.collection('submissions').countDocuments({ kind: 'contest', status: 'queued' }),
    db.collection('submissions').countDocuments({
      kind: 'practice',
      status: { $in: ['claimed', 'running'] },
      claimedAt: { $gt: new Date(Date.now() - inflightWindowMs) },
    }),
  ]);
  const streams = ['judge:contest'];
  if (canTakePractice(slots, running > 0, inflight, backlog)) streams.push('judge:practice');
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
