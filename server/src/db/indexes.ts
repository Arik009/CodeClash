import type { Db } from 'mongodb';

/** Audit indexes live with the audit database and are created by mongo-init. */
export async function ensureIndexes(db: Db) {
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('seats').createIndex(
    { contestId: 1, userId: 1 },
    { unique: true, partialFilterExpression: { active: true } },
  );
  await db.collection('first_solves').createIndex({ contestId: 1, problemId: 1 }, { unique: true });
  await db.collection('standings').createIndex({ contestId: 1, userId: 1 }, { unique: true });
  await db.collection('submissions').createIndex({ status: 1, submittedAt: 1 });
  await db.collection('problem_versions').createIndex({ problemId: 1, version: 1 }, { unique: true });
  await db.collection('outbox').createIndex({ sentAt: 1, createdAt: 1 });
  await db.collection('refresh_tokens').createIndex({ tokenHash: 1 }, { unique: true });
  await db.collection('refresh_tokens').createIndex({ family: 1 });
  await db.collection('refresh_tokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  await db.collection('quiz_answers').createIndex({ questionId: 1, userId: 1 }, { unique: true });
  await db.collection('quiz_questions').createIndex({ contestId: 1, opensAt: -1 });
  await db.collection('submissions').createIndex({ contestId: 1, userId: 1, submittedAt: -1 });
  await db.collection('submissions').createIndex({ problemId: 1, verdict: 1 });
  await db.collection('submissions').createIndex({ userId: 1, verdict: 1 });
  await db.collection('problem_versions').createIndex({ status: 1, problemId: 1, version: -1 });
  await db.collection('submissions').createIndex(
    { userId: 1, idempotencyKey: 1 },
    { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } },
  );
  await db.collection('users').createIndex({ verifyTokenHash: 1 }, { sparse: true });
  await ensureSchemas(db);
  await db.collection('hardening_runs').createIndex(
    { baseVersionId: 1 },
    { unique: true, name: 'one_active_run', partialFilterExpression: { status: { $in: ['queued', 'running'] } } },
  );
  await db.collection('hardening_runs').createIndex({ problemId: 1, createdAt: -1 });
  await db.collection('hardening_runs').createIndex({ status: 1, updatedAt: 1 });
  await db.collection('mutations').createIndex({ runId: 1 });
  await db.collection('proposals').createIndex({ runId: 1 });
  await db.collection('proposals').createIndex({ problemVersionId: 1, createdAt: -1 });
}

const RUN_STATES = ['queued', 'running', 'completed', 'timed_out', 'failed', 'cancelled'];
const AI_STATES = ['DISABLED', 'AVAILABLE', 'RATE_LIMITED', 'BUDGET_EXCEEDED', 'ERROR'];

const SCHEMAS: Record<string, object> = {
  hardening_runs: {
    bsonType: 'object',
    required: ['baseVersionId', 'status', 'createdAt'],
    properties: {
      baseVersionId: { bsonType: 'objectId' },
      problemId: { bsonType: 'objectId' },
      status: { enum: RUN_STATES },
      aiStatus: { enum: AI_STATES },
      metrics: { bsonType: 'object' },
      calls: { bsonType: ['int', 'long', 'double'] },
      tokens: { bsonType: ['int', 'long', 'double'] },
      error: { bsonType: 'string' },
      createdAt: { bsonType: 'date' },
      updatedAt: { bsonType: 'date' },
    },
  },
  mutations: {
    bsonType: 'object',
    required: ['runId', 'operator', 'source', 'status'],
    properties: {
      runId: { bsonType: 'objectId' },
      operator: { bsonType: 'string' },
      source: { enum: ['deterministic', 'model'] },
      description: { bsonType: 'string' },
      compileStatus: { enum: ['ok', 'error'] },
      status: { enum: ['compile_error', 'trivial', 'killed', 'survived', 'equivalent'] },
      survived: { bsonType: 'bool' },
      equivalent: { bsonType: 'bool' },
      killedByProposalId: { bsonType: ['objectId', 'null'] },
    },
  },
  proposals: {
    bsonType: 'object',
    required: ['problemVersionId', 'status'],
    properties: {
      problemVersionId: { bsonType: 'objectId' },
      runId: { bsonType: 'objectId' },
      type: { enum: ['test', 'wrong_solution', 'performance_test'] },
      source: { enum: ['deterministic', 'model'] },
      status: { enum: ['held', 'approved', 'rejected'] },
    },
  },
};

/**
 * JSON schemas for the hardening collections. A new collection gets its validator at creation;
 * an existing one is updated with collMod when the role allows it (the app role may not).
 */
async function ensureSchemas(db: Db) {
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    const options = { validator: { $jsonSchema: schema }, validationLevel: 'moderate' as const };
    try {
      if (existing.has(name)) await db.command({ collMod: name, ...options });
      else await db.createCollection(name, options);
    } catch (error) {
      if (!/not authorized|Unauthorized|already exists/i.test(String(error))) throw error;
    }
  }
}
