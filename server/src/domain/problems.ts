import type { SourceLanguage } from '@codeclash/shared';
import AdmZip from 'adm-zip';
import { type Db, ObjectId } from 'mongodb';
import { auditCollection } from '../db/audit.js';
import { HttpError, isDuplicateKey } from './errors.js';

export interface RunCaseInput {
  language: SourceLanguage;
  code: string;
  stdin: string;
  expected: string;
  timeMs: number;
  memoryMb: number;
}

export type RunCase = (input: RunCaseInput) => Promise<{ verdict: string; stdout: string }>;

export async function archiveVisible(db: Db, problemId: ObjectId): Promise<boolean> {
  const hidden = await db.collection('contests').findOne({
    problemIds: problemId,
    status: { $ne: 'published' },
  });
  return !hidden;
}

export async function assertArchiveAccess(db: Db, problemId: string) {
  const ok = await archiveVisible(db, new ObjectId(problemId));
  if (!ok) throw new HttpError(403, 'This problem belongs to a contest that is not published');
}

export interface PublishReport {
  ok: boolean;
  failures: string[];
}

/** Decision uses only sandbox verdicts. `run` returns the verdict for one solution. */
export async function publishDecision(
  referenceVerdicts: string[],
  wrongSolutions: { label: string; verdicts: string[] }[],
): Promise<PublishReport> {
  const failures: string[] = [];
  if (referenceVerdicts.some((v) => v !== 'AC')) failures.push('reference did not get AC on every test');
  for (const wrong of wrongSolutions) {
    if (wrong.verdicts.length > 0 && wrong.verdicts.every((v) => v === 'AC')) {
      failures.push(`wrong solution survived: ${wrong.label}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

export function testsFromZip(buffer: Buffer) {
  const zip = new AdmZip(buffer);
  const files = new Map<string, string>();
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/').split('/').pop() ?? '';
    files.set(name, entry.getData().toString('utf8'));
  }
  const tests: { input: string; output: string; hidden: boolean }[] = [];
  for (const [name, input] of files) {
    if (!name.endsWith('.in')) continue;
    const output = files.get(`${name.slice(0, -3)}.out`);
    if (output === undefined) continue;
    tests.push({ input, output, hidden: !name.startsWith('sample') });
  }
  if (tests.length === 0) throw new HttpError(400, 'Zip needs paired .in and .out files');
  return tests;
}

/** Runs the reference and the wrong solutions. Only those verdicts decide. */
export async function runPublishCheck(db: Db, versionId: string, run: RunCase): Promise<PublishReport> {
  const version = await db.collection('problem_versions').findOne({ _id: new ObjectId(versionId) });
  if (!version) throw new HttpError(404, 'Version not found');
  if (version.status === 'published') throw new HttpError(409, 'Published versions are immutable');
  await db.collection('problem_versions').updateOne({ _id: version._id }, { $set: { status: 'checking' } });

  const tests = (version.tests as { input: string; output: string }[]) ?? [];
  const reference = version.reference as { language: SourceLanguage; code: string } | null;
  const limits = (version.limits as Record<string, { timeMs: number; memoryMb: number }>) ?? {};
  const missing: string[] = [];
  if (!reference) missing.push('no reference solution');
  if (tests.length === 0) missing.push('no tests');

  const referenceVerdicts: string[] = [];
  if (reference && tests.length > 0) {
    const limit = limits[reference.language] ?? { timeMs: 2000, memoryMb: 256 };
    for (const test of tests) {
      const outcome = await run({
        language: reference.language,
        code: reference.code,
        stdin: test.input,
        expected: test.output,
        timeMs: limit.timeMs,
        memoryMb: limit.memoryMb,
      });
      referenceVerdicts.push(outcome.verdict);
    }
  }

  const wrongSolutions = (version.wrongSolutions as { label: string; language: SourceLanguage; code: string }[]) ?? [];
  const wrongReports: { label: string; verdicts: string[] }[] = [];
  for (const wrong of wrongSolutions) {
    const limit = limits[wrong.language] ?? { timeMs: 2000, memoryMb: 256 };
    const verdicts: string[] = [];
    for (const test of tests) {
      const outcome = await run({
        language: wrong.language,
        code: wrong.code,
        stdin: test.input,
        expected: test.output,
        timeMs: limit.timeMs,
        memoryMb: limit.memoryMb,
      });
      verdicts.push(outcome.verdict);
      if (outcome.verdict !== 'AC') break;
    }
    wrongReports.push({ label: wrong.label, verdicts });
  }

  const decision = await publishDecision(referenceVerdicts, wrongReports);
  const report = { ok: missing.length === 0 && decision.ok, failures: [...missing, ...decision.failures] };
  return applyPublishReport(db, versionId, report);
}

const EDITABLE = ['draft', 'blocked'];

function normalizeInput(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}

/**
 * Approved proposals always land on the newest version of the problem: appended to it while it is
 * still editable, otherwise copied into a fresh draft. Every other field is carried over unchanged.
 */
export async function approveProposals(db: Db, proposalIds: string[], actorId: string) {
  if (proposalIds.length === 0) throw new HttpError(400, 'Pick at least one proposal');
  const ids = proposalIds.map((id) => new ObjectId(id));
  const session = db.client.startSession();
  let versionId = '';
  let before = '';
  let summary = '';
  try {
    await session.withTransaction(async () => {
      const proposals = await db.collection('proposals').find({ _id: { $in: ids }, status: 'held' }, { session }).toArray();
      if (proposals.length !== ids.length) throw new HttpError(404, 'Proposal is not waiting');
      const base = await db.collection('problem_versions').findOne({ _id: proposals[0]!.problemVersionId }, { session });
      if (!base) throw new HttpError(404, 'Version not found');
      const versionIds = new Set(proposals.map((p) => String(p.problemVersionId)));
      const siblings = await db.collection('problem_versions')
        .find({ _id: { $in: [...versionIds].map((id) => new ObjectId(id)) } }, { session, projection: { problemId: 1 } })
        .toArray();
      if (siblings.some((v) => String(v.problemId) !== String(base.problemId))) throw new HttpError(400, 'Proposals belong to different problems');
      const latest = await db.collection('problem_versions')
        .find({ problemId: base.problemId }, { session }).sort({ version: -1 }).limit(1).next();
      if (!latest) throw new HttpError(404, 'Version not found');

      const known = new Set(((latest.tests as { input: string }[]) ?? []).map((t) => normalizeInput(t.input)));
      const tests: { input: string; output: string; hidden: boolean }[] = [];
      const wrongSolutions: { label: string; language: string; code: string }[] = [];
      for (const proposal of proposals) {
        const type = (proposal.type ?? proposal.kind) as string;
        if (type === 'wrong_solution') {
          wrongSolutions.push({ label: `agent-${String(proposal._id).slice(-6)}`, language: proposal.language, code: proposal.code });
          continue;
        }
        const input = String(proposal.input ?? proposal.stdin ?? '');
        if (known.has(normalizeInput(input))) continue;
        known.add(normalizeInput(input));
        tests.push({ input, output: String(proposal.expected ?? ''), hidden: true });
      }

      if (EDITABLE.includes(latest.status as string)) {
        const updated = await db.collection('problem_versions').updateOne(
          { _id: latest._id, status: { $in: EDITABLE } },
          {
            $push: { tests: { $each: tests }, wrongSolutions: { $each: wrongSolutions } } as never,
            $set: { status: 'draft', report: [] },
          },
          { session },
        );
        if (updated.matchedCount !== 1) throw new HttpError(409, 'The draft changed. Try again.');
        versionId = String(latest._id);
      } else {
        const { _id, status: _status, report: _report, version, ...fields } = latest;
        const inserted = await db.collection('problem_versions').insertOne({
          ...fields,
          version: (version as number) + 1,
          tests: [...((latest.tests as unknown[]) ?? []), ...tests],
          wrongSolutions: [...((latest.wrongSolutions as unknown[]) ?? []), ...wrongSolutions],
          status: 'draft',
          report: [],
        }, { session });
        versionId = String(inserted.insertedId);
      }

      const marked = await db.collection('proposals').updateMany(
        { _id: { $in: ids }, status: 'held' },
        { $set: { status: 'approved', approvedBy: actorId, approvedAt: new Date(), versionId: new ObjectId(versionId) } },
        { session },
      );
      if (marked.modifiedCount !== ids.length) throw new HttpError(409, 'Another approval got there first');
      before = String(latest._id);
      summary = `${tests.length} test(s), ${wrongSolutions.length} wrong solution(s)`;
    });
  } catch (error) {
    if (isDuplicateKey(error)) throw new HttpError(409, 'Another approval created the next draft first. Try again.');
    throw error;
  } finally {
    await session.endSession();
  }
  // The audit database is a separate connection, so it cannot join the transaction.
  await auditCollection(db).insertOne({
    actor: actorId,
    actorType: 'user',
    action: 'proposal.approve',
    target: proposalIds.join(','),
    decision: 'allow',
    payload: { before, after: versionId, reason: summary },
    at: new Date(),
  });
  return { versionId };
}

export async function approveProposal(db: Db, proposalId: string, actorId: string) {
  return approveProposals(db, [proposalId], actorId);
}

/** A newly published version retires the older published one of the same problem. */
export async function applyPublishReport(db: Db, versionId: string, report: PublishReport) {
  const id = new ObjectId(versionId);
  await db.collection('problem_versions').updateOne(
    { _id: id },
    { $set: { status: report.ok ? 'published' : 'blocked', report: report.failures } },
  );
  if (report.ok) {
    const version = await db.collection('problem_versions').findOne({ _id: id });
    if (version) {
      await db.collection('problem_versions').updateMany(
        { problemId: version.problemId, status: 'published', _id: { $ne: id } },
        { $set: { status: 'superseded' } },
      );
    }
  }
  return report;
}
