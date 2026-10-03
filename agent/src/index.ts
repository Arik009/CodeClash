import 'dotenv/config';
import { hostname } from 'node:os';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import { HARDEN_STREAM, processRun } from './worker.js';

const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
const auditClient = new MongoClient(process.env.AUDIT_MONGO_URL ?? 'mongodb://auditWriter:codeclash@127.0.0.1:27017/codeclash_audit?replicaSet=rs0&authSource=codeclash_audit');
await auditClient.connect();
const auditDb = auditClient.db();
const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
const group = 'hardeners';
const consumer = `${process.env.WORKER_ID ?? hostname()}-agent-${process.pid}`;

try {
  await redis.xgroup('CREATE', HARDEN_STREAM, group, '0', 'MKSTREAM');
} catch (error) {
  if (!String(error).includes('BUSYGROUP')) throw error;
}

async function monthlyUsed() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await auditDb.collection('audit').aggregate([
    { $match: { action: 'agent.tool', at: { $gte: start } } },
    { $group: { _id: null, tokens: { $sum: '$payload.tokens' } } },
  ]).toArray();
  return (rows[0]?.tokens as number) ?? 0;
}

const deps = {
  db,
  audit: async (row: Record<string, unknown>) => { await auditDb.collection('audit').insertOne(row); },
  monthlyUsed,
  runBatch: async (req: Parameters<typeof import('@codeclash/judge/runner').runBatch>[0]) => {
    const { runBatch } = await import('@codeclash/judge/runner');
    return runBatch(req);
  },
};

type Entry = [string, string[]];
function runIdOf(fields: string[]) {
  for (let i = 0; i < fields.length; i += 2) if (fields[i] === 'runId') return fields[i + 1];
  return undefined;
}

async function handle(id: string, fields: string[]) {
  const runId = runIdOf(fields);
  if (runId) await processRun(deps, runId);
  await redis.xack(HARDEN_STREAM, group, id);
}

console.log(`agent worker ${consumer} waiting on ${HARDEN_STREAM}`);
for (;;) {
  try {
    const reply = await redis.xreadgroup('GROUP', group, consumer, 'COUNT', 1, 'BLOCK', 5000, 'STREAMS', HARDEN_STREAM, '>') as [string, Entry[]][] | null;
    for (const [, messages] of reply ?? []) for (const [id, fields] of messages) await handle(id, fields);
    const [, stale] = await redis.xautoclaim(HARDEN_STREAM, group, consumer, 5 * 60_000, '0-0', 'COUNT', 1) as [string, Entry[]];
    for (const [id, fields] of stale ?? []) await handle(id, fields);
  } catch (error) {
    console.error('agent worker', error);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
}
