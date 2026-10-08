import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { MongoClient, ObjectId, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ensureIndexes } from '../db/indexes.js';
import { tickContests, transitionContest } from './contests.js';
import { HttpError } from './errors.js';
import { claimSubmission, commitVerdict, enqueueSubmission, latestPublished, publishedVersions, reclaimSubmission } from './judging.js';
import { applyPublishReport, assertArchiveAccess, publishDecision, runPublishCheck, testsFromZip, approveProposal, approveProposals } from './problems.js';
import { reserveSeat, seatInvariants, withdrawSeat } from './registration.js';
import { awardFirstSolve, dispatchOutbox, leaderboard, recomputeStanding } from './scoring.js';
import AdmZip from 'adm-zip';

let repl: MongoMemoryReplSet;
let client: MongoClient;
let db: Db;

beforeAll(async () => {
  repl = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  client = new MongoClient(repl.getUri());
  await client.connect();
  db = client.db('codeclash');
  await ensureIndexes(db);
}, 180000);

afterAll(async () => {
  await client.close();
  await repl.stop();
});

async function openContest(capacity: number) {
  const inserted = await db.collection('contests').insertOne({
    title: 'burst',
    type: 'coding',
    capacity,
    reserved: 0,
    waitlistSeq: 0,
    status: 'registration_open',
    startsAt: new Date(Date.now() + 3600_000),
    endsAt: new Date(Date.now() + 3 * 3600_000),
    freezeAt: new Date(Date.now() + 2 * 3600_000),
    registrationOpensAt: new Date(Date.now() - 3600_000),
    scoringMode: 'icpc',
    problemIds: [],
  });
  return String(inserted.insertedId);
}

async function user() {
  const inserted = await db.collection('users').insertOne({
    email: `${new ObjectId().toHexString()}@example.com`,
    passwordHash: 'x',
    displayName: 'n',
    role: 'participant',
    createdAt: new Date(),
  });
  return String(inserted.insertedId);
}

async function mapPool<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>) {
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await fn(items[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}

describe('seats', () => {
  it('gives exactly 200 seats to 400 distinct users and no duplicates', async () => {
    const contestId = await openContest(200);
    const ids = await mapPool(Array.from({ length: 400 }), 40, () => user());
    const results = await mapPool(ids, 40, (id) => reserveSeat(db, contestId, id));
    const reserved = results.filter((r) => r.outcome === 'reserved');
    const waitlisted = results.filter((r) => r.outcome === 'waitlisted');
    expect(reserved).toHaveLength(200);
    expect(waitlisted).toHaveLength(200);
    const again = await reserveSeat(db, contestId, ids[0]!);
    expect(again.outcome).toBe('existing');
    const inv = await seatInvariants(db, contestId);
    expect(inv.overCapacity).toBe(false);
    expect(inv.countMismatch).toBe(false);
    expect(inv.duplicateUsers).toBe(0);
    expect(inv.reserved).toBe(200);
  });

  it('promotes the waitlist head, and decrements reserved when the waitlist is empty', async () => {
    const contestId = await openContest(1);
    const a = await user();
    const b = await user();
    const first = await reserveSeat(db, contestId, a);
    const second = await reserveSeat(db, contestId, b);
    expect(first.outcome).toBe('reserved');
    expect(second.outcome).toBe('waitlisted');
    const promoted = await withdrawSeat(db, first.seatId, a);
    expect(promoted.promotedUserId).toBe(b);
    let inv = await seatInvariants(db, contestId);
    expect(inv.reserved).toBe(1);
    const bSeat = await db.collection('seats').findOne({ contestId: new ObjectId(contestId), userId: new ObjectId(b), active: true });
    await withdrawSeat(db, String(bSeat!._id), b);
    inv = await seatInvariants(db, contestId);
    expect(inv.reserved).toBe(0);
    expect(inv.reservedCount).toBe(0);
  });
});

describe('contests', () => {
  it('rejects a jump from draft to running', async () => {
    const inserted = await db.collection('contests').insertOne({
      title: 'jump',
      status: 'draft',
      capacity: 2,
      reserved: 0,
      waitlistSeq: 0,
      startsAt: new Date(Date.now() - 1000),
      endsAt: new Date(Date.now() + 3600_000),
      freezeAt: new Date(Date.now() + 1800_000),
      registrationOpensAt: new Date(Date.now() - 2000),
      scoringMode: 'icpc',
      problemIds: [],
      type: 'coding',
    });
    await expect(transitionContest(db, String(inserted.insertedId), 'running', 'organiser')).rejects.toBeInstanceOf(HttpError);
    const moved = await tickContests(db);
    expect(moved).toContain(String(inserted.insertedId));
  });
});

describe('publish check', () => {
  it('blocks when a wrong solution still passes', () => {
    return expect(publishDecision(['AC', 'AC'], [{ label: 'quadratic', verdicts: ['AC', 'AC'] }])).resolves.toMatchObject({
      ok: false,
    });
  });

  it('passes when the reference is AC and every wrong solution fails somewhere', () => {
    return expect(publishDecision(['AC', 'AC'], [{ label: 'quadratic', verdicts: ['AC', 'TLE'] }])).resolves.toMatchObject({
      ok: true,
    });
  });
});

describe('exactly once', () => {
  it('ignores a stale claim token and awards first solve once', async () => {
    const contestId = await openContest(10);
    const uid = await user();
    await db.collection('seats').insertOne({
      contestId: new ObjectId(contestId),
      userId: new ObjectId(uid),
      status: 'competing',
      active: true,
      waitlistPos: null,
      createdAt: new Date(),
    });
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    await db.collection('contests').updateOne(
      { _id: new ObjectId(contestId) },
      { $set: { status: 'running', problemIds: [problem.insertedId], endsAt: new Date(Date.now() + 3600_000) } },
    );
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      status: 'published',
      title: 'p',
      statement: 's',
    });
    const queued = await enqueueSubmission(db, {
      userId: uid,
      contestId,
      problemVersionId: String(version.insertedId),
      language: 'python',
      code: 'print(1)',
      kind: 'contest',
    });
    await claimSubmission(db, queued.id, 'token-a', 'worker-1');
    await reclaimSubmission(db, queued.id, 'token-b', 'worker-2');
    const stale = await commitVerdict(db, queued.id, 'token-a', 'WA', null);
    const fresh = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(stale).toBeNull();
    expect(fresh).not.toBeNull();
    const again = await commitVerdict(db, queued.id, 'token-b', 'AC', null);
    expect(again).toBeNull();
    const solves = await db.collection('first_solves').countDocuments({ contestId: new ObjectId(contestId) });
    expect(solves).toBe(1);
    const board = await leaderboard(db, contestId);
    expect(board[0]?.solved).toBe(1);
    const won = await awardFirstSolve(db, {
      contestId: new ObjectId(contestId),
      problemId: problem.insertedId,
      userId: new ObjectId(uid),
      submissionId: new ObjectId(),
      submittedAt: new Date('2030-01-01'),
    });
    expect(won).toBe(false);
  });

  it('refuses a submission without a seat', async () => {
    const contestId = await openContest(10);
    await db.collection('contests').updateOne({ _id: new ObjectId(contestId) }, { $set: { status: 'running' } });
    const version = await db.collection('problem_versions').insertOne({
      problemId: new ObjectId(),
      version: 1,
      status: 'published',
      title: 'p',
    });
    await expect(
      enqueueSubmission(db, {
        userId: await user(),
        contestId,
        problemVersionId: String(version.insertedId),
        language: 'python',
        code: 'print(1)',
        kind: 'contest',
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('problems', () => {
  it('hides an unpublished contest problem from the archive', async () => {
    const problem = await db.collection('problems').insertOne({ title: 'hidden', statement: 's', samples: '', tags: [] });
    await db.collection('contests').insertOne({
      title: 'live',
      status: 'running',
      problemIds: [problem.insertedId],
      capacity: 1,
      reserved: 0,
      waitlistSeq: 0,
      type: 'coding',
      startsAt: new Date(),
      endsAt: new Date(),
      freezeAt: new Date(),
      registrationOpensAt: new Date(),
      scoringMode: 'icpc',
    });
    await expect(assertArchiveAccess(db, String(problem.insertedId))).rejects.toMatchObject({ status: 403 });
  });

  it('reads paired .in and .out files from a zip', () => {
    const zip = new AdmZip();
    zip.addFile('1.in', Buffer.from('1 2\n'));
    zip.addFile('1.out', Buffer.from('3\n'));
    zip.addFile('sample-1.in', Buffer.from('0 0\n'));
    zip.addFile('sample-1.out', Buffer.from('0\n'));
    const tests = testsFromZip(zip.toBuffer());
    expect(tests).toHaveLength(2);
    expect(tests.find((t) => t.input.startsWith('0'))?.hidden).toBe(false);
    expect(tests.find((t) => t.input.startsWith('1'))?.hidden).toBe(true);
  });

  it('publishes only from sandbox verdicts', async () => {
    const problem = await db.collection('problems').insertOne({ title: 'sum', statement: 's', samples: '', tags: [] });
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      status: 'draft',
      title: 'sum',
      statement: 's',
      tests: [{ input: '1 2\n', output: '3\n' }],
      reference: { language: 'python', code: 'print(3)' },
      wrongSolutions: [{ label: 'sub', language: 'python', code: 'wrong' }],
      limits: { python: { timeMs: 2000, memoryMb: 256 } },
    });
    const report = await runPublishCheck(db, String(version.insertedId), async (input) => ({
      verdict: input.code === 'wrong' ? 'WA' : 'AC',
      stdout: '3\n',
    }));
    expect(report.ok).toBe(true);
    const stored = await db.collection('problem_versions').findOne({ _id: version.insertedId });
    expect(stored?.status).toBe('published');
  });

  it('approves a held test into a new draft version', async () => {
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    const version = await db.collection('problem_versions').insertOne({
      problemId: problem.insertedId,
      version: 1,
      status: 'draft',
      title: 'p',
      statement: 's',
      samples: '',
      tests: [],
      reference: { language: 'python', code: 'print(1)' },
      wrongSolutions: [],
    });
    const proposal = await db.collection('proposals').insertOne({
      problemVersionId: version.insertedId,
      kind: 'test',
      language: 'python',
      code: 'gen',
      stdin: '4\n',
      expected: '4\n',
      status: 'held',
    });
    const approved = await approveProposal(db, String(proposal.insertedId), 'setter');
    const next = await db.collection('problem_versions').findOne({ _id: new ObjectId(approved.versionId) });
    expect(next?.status).toBe('draft');
    expect(next?.tests).toEqual([{ input: '4\n', output: '4\n', hidden: true }]);
  });

  describe('approving onto the latest version', () => {
    const fields = {
      title: 'Kept', statement: 's', samples: '', tags: ['dp'], difficulty: 'hard', editorial: 'e',
      subtasks: [{ name: 'all', points: 100 }], limits: { python: { timeMs: 1500, memoryMb: 128 } },
      inputSpec: 'n int 1..9', source: { name: 'Codeforces 1B', license: 'CC BY 4.0' },
      reference: { language: 'python', code: 'print(1)' }, wrongSolutions: [{ label: 'w', language: 'python', code: 'x' }],
    };
    async function problemWith(status: string) {
      const problemId = new ObjectId();
      const v1 = await db.collection('problem_versions').insertOne({
        problemId, version: 1, status, tests: [{ input: '1\n', output: '1\n', hidden: false }], ...fields,
      });
      const hold = async (input: string, extra: Record<string, unknown> = {}) => String((await db.collection('proposals').insertOne({
        problemVersionId: v1.insertedId, type: 'test', input, expected: input, status: 'held', ...extra,
      })).insertedId);
      return { problemId, v1: v1.insertedId, hold };
    }

    it('appends to an editable draft and keeps every field, twice in a row', async () => {
      const { v1, hold } = await problemWith('blocked');
      const first = await approveProposals(db, [await hold('2\n'), await hold('3\n')], 'setter');
      const second = await approveProposals(db, [await hold('4\n'), await hold('2\n')], 'setter');
      expect(first.versionId).toBe(String(v1));
      expect(second.versionId).toBe(String(v1));
      const stored = await db.collection('problem_versions').findOne({ _id: v1 });
      expect(stored).toMatchObject({ ...fields, status: 'draft', report: [] });
      expect(stored!.tests.map((t: { input: string }) => t.input)).toEqual(['1\n', '2\n', '3\n', '4\n']);
    });

    it('copies a published version into a new draft, then appends to that draft', async () => {
      const { problemId, v1, hold } = await problemWith('published');
      const wrong = String((await db.collection('proposals').insertOne({
        problemVersionId: v1, type: 'wrong_solution', language: 'python', code: 'print(2)', status: 'held',
      })).insertedId);
      const first = await approveProposals(db, [await hold('5\n'), wrong], 'setter');
      expect(first.versionId).not.toBe(String(v1));
      const draft = await db.collection('problem_versions').findOne({ _id: new ObjectId(first.versionId) });
      expect(draft).toMatchObject({ ...fields, wrongSolutions: [...fields.wrongSolutions, expect.objectContaining({ code: 'print(2)' })], version: 2, status: 'draft' });
      expect((await db.collection('problem_versions').findOne({ _id: v1 }))!.status).toBe('published');
      const again = await approveProposals(db, [await hold('6\n')], 'setter');
      expect(again.versionId).toBe(first.versionId);
      expect(await db.collection('problem_versions').countDocuments({ problemId })).toBe(2);
      const proposal = await db.collection('proposals').findOne({ _id: new ObjectId(wrong) });
      expect(proposal).toMatchObject({ status: 'approved', approvedBy: 'setter' });
    });

    it('lets exactly one of two racing approvals of the same proposal win', async () => {
      const { v1, hold } = await problemWith('draft');
      const id = await hold('7\n');
      const results = await Promise.allSettled([approveProposals(db, [id], 'a'), approveProposals(db, [id], 'b')]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const stored = await db.collection('problem_versions').findOne({ _id: v1 });
      expect(stored!.tests.filter((t: { input: string }) => t.input === '7\n')).toHaveLength(1);
    });

    it('keeps both of two racing approvals onto a published version in one new draft', async () => {
      const { problemId, hold } = await problemWith('published');
      const [a, b] = [await hold('8\n'), await hold('9\n')];
      const ids = [a, b];
      const results = await Promise.allSettled(ids.map((id) => approveProposals(db, [id], 'setter')));
      for (const [i, result] of results.entries()) {
        if (result.status === 'fulfilled') continue;
        expect(result.reason.status).toBe(409);
        await approveProposals(db, [ids[i]!], 'setter');
      }
      const drafts = await db.collection('problem_versions').find({ problemId, status: 'draft' }).toArray();
      expect(drafts).toHaveLength(1);
      expect(drafts[0]!.tests.map((t: { input: string }) => t.input).sort()).toEqual(['1\n', '8\n', '9\n']);
    });

    it('rejects an empty list, proposals that are not waiting, and mixed problems', async () => {
      await expect(approveProposals(db, [], 'x')).rejects.toMatchObject({ status: 400 });
      await expect(approveProposals(db, [String(new ObjectId())], 'x')).rejects.toMatchObject({ status: 404 });
      const one = await problemWith('draft');
      const two = await problemWith('draft');
      await expect(approveProposals(db, [await one.hold('1 1\n'), await two.hold('2 2\n')], 'x')).rejects.toMatchObject({ status: 400 });
    });
  });

  it('scores a judged contest submission from the outbox into the sorted set', async () => {
    const contestId = await openContest(10);
    const uid = await user();
    const problem = await db.collection('problems').insertOne({ title: 'p', statement: 's', samples: '', tags: [] });
    const submission = await db.collection('submissions').insertOne({
      userId: new ObjectId(uid),
      contestId: new ObjectId(contestId),
      problemId: problem.insertedId,
      status: 'judged',
      verdict: 'WA',
      kind: 'contest',
      submittedAt: new Date(),
    });
    await db.collection('outbox').insertOne({
      type: 'VerdictCommitted',
      payload: {
        submissionId: String(submission.insertedId),
        contestId,
        userId: uid,
        problemId: String(problem.insertedId),
        verdict: 'WA',
        kind: 'contest',
        submittedAt: new Date(),
      },
      createdAt: new Date(),
      sentAt: null,
    });
    const scores: Record<string, number> = {};
    const events: string[] = [];
    await dispatchOutbox(db, {
      async set() { return 'OK'; },
      async zadd(key, score, member) { scores[`${key}:${member}`] = score; return 1; },
    }, (room, event) => { events.push(`${room}:${event}`); });
    const stored = await db.collection('submissions').findOne({ _id: submission.insertedId });
    expect(stored?.status).toBe('scored');
    expect(scores[`lb:${contestId}:rank:${uid}`]).toBe(0);
    expect(events.some((e) => e.endsWith(':leaderboard'))).toBe(true);
    expect(events.some((e) => e.endsWith(':VerdictCommitted'))).toBe(false);
  });

  it('retires the older published version when a new one publishes', async () => {
    const problem = await db.collection('problems').insertOne({ title: 'v', statement: 's', samples: '', tags: [] });
    const old = await db.collection('problem_versions').insertOne({ problemId: problem.insertedId, version: 1, status: 'published', title: 'v' });
    const next = await db.collection('problem_versions').insertOne({ problemId: problem.insertedId, version: 2, status: 'checking', title: 'v' });
    await applyPublishReport(db, String(next.insertedId), { ok: true, failures: [] });
    expect((await db.collection('problem_versions').findOne({ _id: old.insertedId }))?.status).toBe('superseded');
    const latest = await latestPublished(db, problem.insertedId);
    expect(String(latest?._id)).toBe(String(next.insertedId));
    expect((await publishedVersions(db, [problem.insertedId]))).toHaveLength(1);
  });
});

describe('contest rules', () => {
  async function liveContest(overrides: Record<string, unknown> = {}) {
    const problem = await db.collection('problems').insertOne({ title: 'in', statement: 's', samples: '', tags: [] });
    const version = await db.collection('problem_versions').insertOne({ problemId: problem.insertedId, version: 1, status: 'published', title: 'in' });
    const now = Date.now();
    const contest = await db.collection('contests').insertOne({
      title: 'rules',
      type: 'mixed',
      status: 'running',
      capacity: 10,
      reserved: 0,
      waitlistSeq: 0,
      startsAt: new Date(now - 3600_000),
      freezeAt: new Date(now - 60_000),
      endsAt: new Date(now + 3600_000),
      registrationOpensAt: new Date(now - 7200_000),
      scoringMode: 'icpc',
      problemIds: [problem.insertedId],
      ...overrides,
    });
    const uid = await user();
    await db.collection('seats').insertOne({ contestId: contest.insertedId, userId: new ObjectId(uid), status: 'competing', active: true, waitlistPos: null, createdAt: new Date() });
    return { contestId: String(contest.insertedId), versionId: String(version.insertedId), problemId: problem.insertedId, uid };
  }

  it('refuses a problem that is not part of the contest', async () => {
    const { contestId, uid } = await liveContest();
    const other = await db.collection('problem_versions').insertOne({ problemId: new ObjectId(), version: 1, status: 'published', title: 'x' });
    await expect(enqueueSubmission(db, {
      userId: uid, contestId, problemVersionId: String(other.insertedId), language: 'python', code: 'print(1)', kind: 'contest',
    })).rejects.toMatchObject({ status: 400 });
  });

  it('accepts submissions while frozen and hides post-freeze solves from the public board', async () => {
    const { contestId, versionId, uid } = await liveContest({ status: 'frozen' });
    const queued = await enqueueSubmission(db, {
      userId: uid, contestId, problemVersionId: versionId, language: 'python', code: 'print(1)', kind: 'contest',
    });
    await claimSubmission(db, queued.id, 'tok', 'w');
    await commitVerdict(db, queued.id, 'tok', 'AC', null);
    const hidden = await leaderboard(db, contestId);
    expect(hidden[0]?.solved).toBe(0);
    const revealed = await leaderboard(db, contestId, { reveal: true });
    expect(revealed[0]?.solved).toBe(1);
    await db.collection('contests').updateOne({ _id: new ObjectId(contestId) }, { $set: { status: 'ended' } });
    expect((await leaderboard(db, contestId))[0]?.solved).toBe(1);
  });

  it('adds quiz points to the standing', async () => {
    const { contestId, uid } = await liveContest({ freezeAt: new Date(Date.now() + 600_000) });
    await db.collection('quiz_answers').insertOne({
      questionId: new ObjectId(), contestId: new ObjectId(contestId), userId: new ObjectId(uid), choice: 0, score: 750, receivedAt: new Date(),
    });
    await recomputeStanding(db, contestId, uid);
    const board = await leaderboard(db, contestId);
    expect(board[0]).toMatchObject({ quizPoints: 750, displayName: 'n' });
  });

  it('allows one answer per question', async () => {
    const questionId = new ObjectId();
    const row = { questionId, userId: new ObjectId(), contestId: new ObjectId(), choice: 1, score: 0, receivedAt: new Date() };
    await db.collection('quiz_answers').insertOne({ ...row });
    await expect(db.collection('quiz_answers').insertOne({ ...row, _id: new ObjectId() })).rejects.toMatchObject({ code: 11000 });
  });
});
