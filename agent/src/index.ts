import 'dotenv/config';
import { MongoClient, ObjectId } from 'mongodb';
import { harden } from './loop.js';
import { providerFromEnv } from './providers.js';

const url = process.env.MONGO_URL ?? 'mongodb://app:codeclash@127.0.0.1:27017/codeclash?replicaSet=rs0&authSource=codeclash';
const client = new MongoClient(url);
await client.connect();
const db = client.db();
const auditClient = new MongoClient(process.env.AUDIT_MONGO_URL ?? 'mongodb://auditWriter:codeclash@127.0.0.1:27017/codeclash_audit?replicaSet=rs0&authSource=codeclash_audit');
await auditClient.connect();
const auditDb = auditClient.db();
const cap = Number(process.env.AGENT_MONTHLY_TOKEN_CAP ?? 200_000);

async function usedThisMonth() {
  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);
  const rows = await auditDb.collection('audit').aggregate([
    { $match: { action: 'agent.tool', at: { $gte: start } } },
    { $group: { _id: null, tokens: { $sum: '$payload.tokens' } } },
  ]).toArray();
  return (rows[0]?.tokens as number) ?? 0;
}

async function work(versionId: string) {
  const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(versionId) });
  if (!version?.reference) return;
  const result = await harden({
    provider: providerFromEnv({ samples: String(version.samples ?? '') }),
    statement: String(version.statement ?? ''),
    samples: String(version.samples ?? ''),
    reference: version.reference as { language: 'javascript' | 'python'; code: string },
    existingInputs: ((version.tests as { input: string }[]) ?? []).map((t) => t.input),
    monthlyUsed: await usedThisMonth(),
    monthlyCap: cap,
    runSandbox: async (code, language, stdin) => {
      const { runInDocker } = await import('@codeclash/judge/runner');
      const outcome = await runInDocker({
        language,
        code,
        stdin,
        expected: '',
        timeMs: 2000,
        memoryMb: 256,
      });
      return { verdict: outcome.verdict, stdout: outcome.stdout };
    },
    audit: async (row) => {
      await auditDb.collection('audit').insertOne({
        actor: 'test-hardening-agent',
        actorType: 'agent',
        action: 'agent.tool',
        target: versionId,
        decision: row.decision,
        payload: { tool: row.tool, model: row.model, tokens: row.tokens },
        at: new Date(),
      });
    },
  });
  for (const proposal of result.proposals) {
    await db.collection('proposals').insertOne({ ...proposal, problemVersionId: version._id, createdAt: new Date() });
  }
  await db.collection('agent_runs').insertOne({ problemVersionId: version._id, ...result, at: new Date() });
}

const id = process.argv[2];
if (!id) {
  console.log('agent idle; use Harden tests in authoring, or pass a problemVersionId');
  await new Promise(() => {});
}
await work(id);
await client.close();
await auditClient.close();
