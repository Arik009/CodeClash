import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { recomputeStanding } from './domain/scoring.js';

// Recomputes every stored standing, e.g. after the standings shape changes. The next verdict refreshes the Redis board.
const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
const rows = await db.collection('standings').find({}).project({ contestId: 1, userId: 1 }).toArray();
for (const row of rows) await recomputeStanding(db, String(row.contestId), String(row.userId));
console.log(`rescored ${rows.length} standings`);
await client.close();
