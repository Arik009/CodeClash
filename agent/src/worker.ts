import { randomBytes } from 'node:crypto';
import { draftSpec, parseSpec, SpecError, type SourceLanguage } from '@codeclash/shared';
import { type Db, ObjectId } from 'mongodb';
import { auditArgs, createPlanner, type AuditRow } from './engine/ai.js';
import { HardeningError, runHardening, type Batch, type BatchRun, type HardeningInput } from './engine/pipeline.js';
import { providerFromEnv, type ProviderConfig } from './providers.js';

export const HARDEN_STREAM = 'agent:harden';
export const ACTIVE_RUN = ['queued', 'running'];
export const STALE_AFTER_MS = 3 * 60_000;
export const MAX_RUN_MS = 10 * 60_000;

export interface WorkerDeps {
  db: Db;
  audit: (row: Record<string, unknown>) => Promise<void>;
  monthlyUsed: () => Promise<number>;
  runBatch: (req: { language: SourceLanguage; code: string; inputs: string[]; timeMs: number; memoryMb: number }) => Promise<BatchRun>;
  providers?: ProviderConfig;
  env?: NodeJS.ProcessEnv;
  heartbeatMs?: number;
}

class Stopped extends Error {}

/**
 * Claims a queued hardening run, runs the engine, and stores mutations and proposals. Only one
 * worker can claim a run, and results are written only while the claim still holds.
 */
export async function processRun(deps: WorkerDeps, runId: string): Promise<'done' | 'skipped'> {
  const { db } = deps;
  const env = deps.env ?? process.env;
  const token = randomBytes(12).toString('hex');
  const startedAt = new Date();
  const run = await db.collection('hardening_runs').findOneAndUpdate(
    { _id: new ObjectId(runId), status: 'queued' },
    { $set: { status: 'running', claimToken: token, startedAt, updatedAt: startedAt, stage: 'starting' } },
    { returnDocument: 'after' },
  );
  if (!run) return 'skipped';
  const mine = { _id: run._id, claimToken: token, status: 'running' };
  const heartbeat = setInterval(() => {
    void db.collection('hardening_runs').updateOne(mine, { $set: { updatedAt: new Date() } }).catch(() => {});
  }, deps.heartbeatMs ?? 20_000);

  const audit = async (row: AuditRow | Record<string, unknown>, decision = 'allow') => {
    const r = row as AuditRow;
    await deps.audit({
      actor: 'test-hardening-agent',
      actorType: 'agent',
      action: 'agent.tool',
      target: String(run.baseVersionId),
      decision: r.decision ?? decision,
      payload: { tool: r.tool, model: r.model, tokens: r.tokens ?? 0, args: r.args, reason: r.reason ?? null, runId },
      at: new Date(),
    });
  };

  try {
    const version = await db.collection('problem_versions').findOne({ _id: run.baseVersionId });
    if (!version) throw new HardeningError('The problem version no longer exists');
    const reference = version.reference as { language: SourceLanguage; code: string } | null;
    if (!reference) throw new HardeningError('Add a reference solution first');
    const tests = ((version.tests as { input: string; output: string; hidden?: boolean }[]) ?? []);
    const limits = (version.limits as HardeningInput['limits']) ?? {};
    const statement = String(version.statement ?? '');

    let spec: HardeningInput['spec'] = null;
    const notes: string[] = [];
    const given = typeof version.inputSpec === 'string' ? version.inputSpec.trim() : '';
    if (given) {
      try {
        spec = { text: given, parsed: parseSpec(given), origin: 'given' };
      } catch (error) {
        notes.push(`The input spec does not parse (${error instanceof SpecError ? error.message : 'error'}), so it was ignored.`);
      }
    }
    if (!spec) {
      const drafted = draftSpec(statement, tests.map((t) => t.input));
      if (drafted) spec = { text: drafted, parsed: parseSpec(drafted), origin: 'drafted' };
    }

    const batch: Batch = async (program, inputs) => {
      const limit = limits[program.language] ?? (program.language === 'java' ? { timeMs: 3000, memoryMb: 512 } : { timeMs: 2000, memoryMb: 256 });
      return deps.runBatch({ ...program, inputs, timeMs: limit.timeMs, memoryMb: limit.memoryMb });
    };

    const config = deps.providers ?? providerFromEnv(env);
    const planner = config.provider
      ? createPlanner({
        provider: config.provider,
        audit: (row) => audit(row),
        runTokenCap: Number(env.AGENT_RUN_TOKEN_CAP ?? 20_000),
        monthlyUsed: await deps.monthlyUsed(),
        monthlyCap: Number(env.AGENT_MONTHLY_TOKEN_CAP ?? 200_000),
      })
      : undefined;

    const result = await runHardening({
      statement,
      reference,
      tests,
      spec,
      limits,
      wrongSolutions: (version.wrongSolutions as HardeningInput['wrongSolutions']) ?? [],
      batch,
      planner,
      seed: Number.parseInt(String(run._id).slice(-6), 16),
      progress: async (stage) => {
        const now = new Date();
        if (now.getTime() - startedAt.getTime() > MAX_RUN_MS) throw new Stopped('timed_out');
        const updated = await db.collection('hardening_runs').updateOne(mine, { $set: { stage, updatedAt: now } });
        if (updated.matchedCount === 0) throw new Stopped('stopped');
      },
      onBatch: async (program, inputs, source) => {
        await audit({ tool: 'sandbox.batch', decision: 'allow', args: auditArgs({ language: program.language, code: program.code, inputs, source }), model: 'sandbox', tokens: 0 });
      },
    });
    if (!config.provider && config.reason) result.notes.splice(1, 0, config.reason);

    const now = new Date();
    const mutationIds = new Map<string, ObjectId>();
    if (result.mutations.length) {
      const rows = result.mutations.map((m) => {
        const _id = new ObjectId();
        mutationIds.set(m.id, _id);
        return {
          _id,
          runId: run._id,
          problemVersionId: run.baseVersionId,
          key: m.id,
          operator: m.operator,
          source: m.source,
          description: m.description,
          diff: m.diff,
          language: m.language,
          code: m.code.slice(0, 20_000),
          compileStatus: m.status === 'compile_error' ? 'error' : 'ok',
          status: m.status,
          survived: m.status === 'survived' || m.status === 'equivalent',
          equivalent: m.status === 'equivalent',
          survivedRandom: m.survivedRandom,
          killedByProposalId: null as ObjectId | null,
          createdAt: now,
        };
      });
      await db.collection('mutations').insertMany(rows);
    }
    const proposalIds = new Map<string, ObjectId>();
    if (result.proposals.length) {
      await db.collection('proposals').insertMany(result.proposals.map((p) => {
        const _id = new ObjectId();
        proposalIds.set(p.key, _id);
        return {
          _id,
          runId: run._id,
          problemId: run.problemId,
          problemVersionId: run.baseVersionId,
          baseVersionId: run.baseVersionId,
          type: p.type,
          kind: p.type === 'wrong_solution' ? 'wrong_solution' : 'test',
          input: p.input ?? null,
          expected: p.expected ?? null,
          language: p.language ?? null,
          code: p.code ?? null,
          reason: p.reason,
          source: p.source,
          attack: p.attack,
          targetMutationId: p.targetMutationIds[0] ? mutationIds.get(p.targetMutationIds[0]) ?? null : null,
          targetMutationIds: p.targetMutationIds.map((key) => mutationIds.get(key)).filter(Boolean),
          evidence: p.evidence,
          status: 'held',
          createdAt: now,
        };
      }));
      for (const mutation of result.mutations) {
        if (mutation.killedByProposal && proposalIds.has(mutation.killedByProposal)) {
          await db.collection('mutations').updateOne(
            { _id: mutationIds.get(mutation.id) },
            { $set: { killedByProposalId: proposalIds.get(mutation.killedByProposal) } },
          );
        }
      }
    }
    const finished = await db.collection('hardening_runs').updateOne(mine, {
      $set: {
        status: 'completed',
        aiStatus: result.ai.status,
        metrics: result.metrics,
        notes: [...notes, ...result.notes],
        calls: result.ai.calls,
        tokens: result.ai.tokens,
        draftedSpec: spec?.origin === 'drafted' ? spec.text : null,
        proposals: result.proposals.length,
        stage: 'done',
        finishedAt: new Date(),
        updatedAt: new Date(),
      },
    });
    if (finished.matchedCount === 0) {
      await db.collection('mutations').deleteMany({ runId: run._id });
      await db.collection('proposals').deleteMany({ runId: run._id });
    }
    return 'done';
  } catch (error) {
    if (error instanceof Stopped) {
      if (error.message === 'timed_out') {
        await db.collection('hardening_runs').updateOne(mine, {
          $set: { status: 'timed_out', error: 'The run went over 10 minutes and was stopped.', finishedAt: new Date(), updatedAt: new Date() },
        });
      }
      return 'done';
    }
    const message = error instanceof HardeningError ? error.message : `The run failed: ${error instanceof Error ? error.message : String(error)}`;
    await db.collection('hardening_runs').updateOne(mine, {
      $set: { status: 'failed', error: message, finishedAt: new Date(), updatedAt: new Date() },
    });
    return 'done';
  } finally {
    clearInterval(heartbeat);
  }
}

/** Moves runs whose worker went quiet, or that ran too long, to timed_out. */
export async function expireRuns(db: Db, now = new Date()) {
  const quiet = new Date(now.getTime() - STALE_AFTER_MS);
  const tooOld = new Date(now.getTime() - MAX_RUN_MS);
  const stale = await db.collection('hardening_runs').updateMany(
    { status: 'running', $or: [{ updatedAt: { $lt: quiet } }, { startedAt: { $lt: tooOld } }] },
    { $set: { status: 'timed_out', error: 'The agent worker stopped reporting progress.', finishedAt: now, updatedAt: now } },
  );
  const unclaimed = await db.collection('hardening_runs').updateMany(
    { status: 'queued', createdAt: { $lt: tooOld } },
    { $set: { status: 'timed_out', error: 'No agent worker picked this run up. Is `npm run dev` running the agent?', finishedAt: now, updatedAt: now } },
  );
  return stale.modifiedCount + unclaimed.modifiedCount;
}
