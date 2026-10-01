import 'dotenv/config';
import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import { Server } from 'socket.io';
import { setAuditDb } from './db/audit.js';
import { ensureIndexes } from './db/indexes.js';
import { tickContests } from './domain/contests.js';
import { type RunCase } from './domain/problems.js';
import { dispatchOutbox } from './domain/scoring.js';
import { createApp } from './http/app.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const mongoUrl = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const auditUrl = process.env.AUDIT_MONGO_URL ?? 'mongodb://auditWriter:codeclash@127.0.0.1:27017/codeclash_audit?replicaSet=rs0&authSource=codeclash_audit';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const mongo = new MongoClient(mongoUrl);
await mongo.connect();
const db = mongo.db();
await ensureIndexes(db);
await db.collection('problem_versions').updateMany({ status: 'checking' }, { $set: { status: 'blocked', report: ['check interrupted by a restart; run it again'] } });
await db.collection('agent_runs').updateMany({ status: 'running' }, { $set: { status: 'no_proposals', reason: 'interrupted' } });
const auditClient = new MongoClient(auditUrl);
await auditClient.connect();
const auditDb = auditClient.db();
setAuditDb(auditDb);

const redis = new Redis(redisUrl);
const app = createApp({
  db,
  redis: {
    xadd: (stream, id, ...fields) => redis.xadd(stream, id, ...fields),
    publish: (channel, message) => redis.publish(channel, message),
    incr: (key) => redis.incr(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    get: (key) => redis.get(key),
    ping: () => redis.ping(),
  },
  log,
  runCase: runInSandbox,
});

const server = createServer(app);
const io = new Server(server, { cors: { origin: process.env.CLIENT_ORIGIN ?? 'http://localhost:5173' } });
io.on('connection', (socket) => {
  socket.on('join', (contestId: string) => {
    socket.join(`contest:${contestId}`);
  });
});

setInterval(() => {
  dispatchOutbox(
    db,
    {
      set: (key, value) => redis.set(key, value),
      zadd: (key, score, member) => redis.zadd(key, score, member),
    },
    (room, event, payload) => { io.to(room).emit(event, payload); },
  ).catch((error) => log.info({ err: error }, 'outbox'));
}, 300);

async function runInSandbox(input: Parameters<RunCase>[0]) {
  const { runInDocker } = await import('@codeclash/judge/runner');
  return runInDocker(input);
}

setInterval(() => {
  tickContests(db).catch((error) => log.info({ err: error }, 'scheduler'));
}, 5000);

// A submission saved while Redis was unreachable never reached the stream; send it again.
setInterval(() => {
  void (async () => {
    const cutoff = new Date(Date.now() - 120_000);
    const stuck = await db.collection('submissions')
      .find({ status: 'queued', submittedAt: { $lt: cutoff }, $or: [{ requeuedAt: { $exists: false } }, { requeuedAt: { $lt: cutoff } }] })
      .limit(100)
      .toArray();
    for (const row of stuck) {
      await redis.xadd(row.kind === 'contest' ? 'judge:contest' : 'judge:practice', '*', 'submissionId', String(row._id));
      await db.collection('submissions').updateOne({ _id: row._id }, { $set: { requeuedAt: new Date() } });
    }
    if (stuck.length) log.info({ count: stuck.length }, 'requeued stuck submissions');
  })().catch((error) => log.info({ err: error }, 'requeue'));
}, 60_000);

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => log.info({ port }, 'codeclash server listening'));
