import { MongoMemoryServer } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeProvider } from './providers.js';
import { fakeBatch, MAX_REFERENCE, MAX_SPEC, MAX_TESTS } from './testdata/fake-batch.js';
import { expireRuns, processRun, type WorkerDeps } from './worker.js';

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
const audits: Record<string, unknown>[] = [];

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = new MongoClient(server.getUri());
  await client.connect();
  db = client.db('agent-worker');
}, 120_000);

afterAll(async () => {
  await client.close();
  await server.stop();
});

function deps(extra: Partial<WorkerDeps> = {}): WorkerDeps {
  const batch = fakeBatch();
  return {
    db,
    audit: async (row) => { audits.push(row); },
    monthlyUsed: async () => 0,
    runBatch: (req) => batch({ language: req.language, code: req.code }, req.inputs),
    env: {},
    ...extra,
  };
}

async function queue(version: Record<string, unknown>) {
  const problemId = new ObjectId();
  const v = await db.collection('problem_versions').insertOne({ problemId, version: 1, status: 'draft', statement: 'Print the maximum.', ...version });
  const run = await db.collection('hardening_runs').insertOne({
    problemId, baseVersionId: v.insertedId, status: 'queued', createdAt: new Date(), updatedAt: new Date(),
  });
  return String(run.insertedId);
}

const maxVersion = {
  reference: { language: 'javascript', code: MAX_REFERENCE },
  tests: MAX_TESTS,
  inputSpec: MAX_SPEC,
};

describe('agent worker', () => {
  it('claims a run once, stores mutations and proposals, and completes it', async () => {
    const runId = await queue(maxVersion);
    expect(await processRun(deps(), runId)).toBe('done');
    expect(await processRun(deps(), runId)).toBe('skipped');
    const run = await db.collection('hardening_runs').findOne({ _id: new ObjectId(runId) });
    expect(run).toMatchObject({ status: 'completed', aiStatus: 'DISABLED', calls: 0, stage: 'done' });
    expect(run!.metrics.spec).toBe('given');
    expect(run!.notes[0]).toBe('AI-assisted analysis unavailable. Running deterministic hardening suite.');
    expect(run!.notes[1]).toBe('No AGENT_PROVIDER is set.');

    const mutations = await db.collection('mutations').find({ runId: run!._id }).toArray();
    const proposals = await db.collection('proposals').find({ runId: run!._id }).toArray();
    expect(mutations.length).toBe(run!.metrics.mutants.generated);
    expect(proposals.length).toBe(run!.proposals);
    const test = proposals.find((p) => p.type === 'test')!;
    expect(test).toMatchObject({ status: 'held', kind: 'test', source: 'deterministic', baseVersionId: run!.baseVersionId });
    const target = mutations.find((m) => String(m._id) === String(test.targetMutationId))!;
    expect(String(target.killedByProposalId)).toBe(String(test._id));
    expect(audits.some((a) => (a.payload as { tool: string }).tool === 'sandbox.batch')).toBe(true);
  });

  it('drafts a spec from the statement when the version has none', async () => {
    const runId = await queue({
      ...maxVersion,
      inputSpec: undefined,
      statement: 'Given n (1 ≤ n ≤ 1000) and integers a_i (-100 ≤ a_i ≤ 100), print the largest.',
    });
    await processRun(deps(), runId);
    const run = await db.collection('hardening_runs').findOne({ _id: new ObjectId(runId) });
    expect(run!.metrics.spec).toBe('drafted');
    expect(run!.draftedSpec).toBe('n int 1..1000\na int[n] -100..100');
  });

  it('fails clearly when the reference is missing or broken', async () => {
    const missing = await queue({ tests: MAX_TESTS });
    await processRun(deps(), missing);
    expect(await db.collection('hardening_runs').findOne({ _id: new ObjectId(missing) })).toMatchObject({ status: 'failed', error: 'Add a reference solution first' });
    const broken = await queue({ ...maxVersion, reference: { language: 'cpp', code: 'BROKEN' } });
    await processRun(deps(), broken);
    expect((await db.collection('hardening_runs').findOne({ _id: new ObjectId(broken) }))!.error).toMatch(/does not compile/);
  });

  it('stops when the run is cancelled and leaves no proposals behind', async () => {
    const runId = await queue(maxVersion);
    let batches = 0;
    const batch = fakeBatch();
    await processRun(deps({
      runBatch: async (req) => {
        batches += 1;
        if (batches === 3) await db.collection('hardening_runs').updateOne({ _id: new ObjectId(runId) }, { $set: { status: 'cancelled' } });
        return batch({ language: req.language, code: req.code }, req.inputs);
      },
    }), runId);
    expect((await db.collection('hardening_runs').findOne({ _id: new ObjectId(runId) }))!.status).toBe('cancelled');
    expect(await db.collection('proposals').countDocuments({ runId: new ObjectId(runId) })).toBe(0);
  });

  it('uses the model when configured and records its status and tokens', async () => {
    const runId = await queue(maxVersion);
    const provider = new FakeProvider(['{"attacks":[{"type":"edge_case","description":"max last","input":"3\\n1 2 9\\n"}]}']);
    await processRun(deps({ providers: { provider, status: 'AVAILABLE', reason: null }, env: { AGENT_RUN_TOKEN_CAP: '1000' } }), runId);
    const run = await db.collection('hardening_runs').findOne({ _id: new ObjectId(runId) });
    // The equivalent-looking mutants survive the first wave, so the feedback call is made too.
    expect(run).toMatchObject({ status: 'completed', aiStatus: 'AVAILABLE', calls: 2, tokens: 41 });
    expect(run!.metrics.attacks.model).toBe(1);
    expect(audits.some((a) => (a.payload as { tool: string }).tool === 'model.plan')).toBe(true);
  });

  it('times out runs whose worker went quiet or that sat in the queue', async () => {
    const now = new Date();
    const old = new Date(now.getTime() - 4 * 60_000);
    const ancient = new Date(now.getTime() - 11 * 60_000);
    const quiet = await db.collection('hardening_runs').insertOne({ status: 'running', startedAt: old, updatedAt: old });
    const alive = await db.collection('hardening_runs').insertOne({ status: 'running', startedAt: old, updatedAt: now });
    const stuck = await db.collection('hardening_runs').insertOne({ status: 'queued', createdAt: ancient, updatedAt: ancient });
    expect(await expireRuns(db, now)).toBe(2);
    expect((await db.collection('hardening_runs').findOne({ _id: quiet.insertedId }))!.status).toBe('timed_out');
    expect((await db.collection('hardening_runs').findOne({ _id: alive.insertedId }))!.status).toBe('running');
    expect((await db.collection('hardening_runs').findOne({ _id: stuck.insertedId }))!.error).toMatch(/No agent worker/);
  });
});
