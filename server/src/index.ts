import 'dotenv/config';
import { createServer } from 'node:http';
import { Redis } from 'ioredis';
import { MongoClient } from 'mongodb';
import pino from 'pino';
import { createApp } from './http/app.js';

const log = pino({ level: process.env.LOG_LEVEL ?? 'info' });
const mongoUrl = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

const mongo = new MongoClient(mongoUrl);
await mongo.connect();
const db = mongo.db();

const redis = new Redis(redisUrl);
const app = createApp({
  db,
  redis: {
    get: (key) => redis.get(key),
    ping: () => redis.ping(),
  },
  log,
});

const server = createServer(app);

const port = Number(process.env.PORT ?? 4000);
server.listen(port, () => log.info({ port }, 'codeclash server listening'));
