import 'dotenv/config';
import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import { ensureIndexes } from './db/indexes.js';
import { type RunCase } from './domain/problems.js';
import { createApp } from './http/app.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const mongoUrl = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const mongo = new MongoClient(mongoUrl);
await mongo.connect();
const db = mongo.db();
await ensureIndexes(db);

const redis = new Redis(redisUrl);
const app = createApp({
  db,
  redis: {
    xadd: (stream, id, ...fields) => redis.xadd(stream, id, ...fields),
    incr: (key) => redis.incr(key),
    expire: (key, seconds) => redis.expire(key, seconds),
    get: (key) => redis.get(key),
    ping: () => redis.ping(),
  },
  log,
  runCase: runInSandbox,
});

const server = createServer(app);

async function runInSandbox(input: Parameters<RunCase>[0]) {
  const { runInDocker } = await import('@codeclash/judge/runner');
  return runInDocker(input);
}

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => log.info({ port }, 'codeclash server listening'));
