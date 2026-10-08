import { compareStanding, icpcRow, problemCells, type ProblemCell, type StandingRow, type Verdict } from '@codeclash/shared';
import { type Db, ObjectId } from 'mongodb';

async function quizTotal(db: Db, contestId: ObjectId, userId: ObjectId, before?: Date) {
  const rows = await db.collection('quiz_answers').aggregate([
    { $match: { contestId, userId, ...(before ? { receivedAt: { $lt: before } } : {}) } },
    { $group: { _id: null, points: { $sum: '$score' } } },
  ]).toArray();
  return (rows[0]?.points as number) ?? 0;
}

/** Stores the standing row of one participant. */
export async function recomputeStanding(db: Db, contestId: string, userId: string) {
  const contest = await db.collection('contests').findOne({ _id: new ObjectId(contestId) });
  if (!contest) return null;
  const uid = new ObjectId(userId);
  const subs = await db
    .collection('submissions')
    .find({ contestId: contest._id, userId: uid, status: 'scored', kind: 'contest' })
    .toArray();
  const attempts = subs.map((s) => ({
    problemId: String(s.problemId),
    verdict: s.verdict as Verdict,
    submittedAt: s.submittedAt as Date,
    submissionId: String(s._id),
  }));
  const startsAt = contest.startsAt as Date;
  const endsAt = contest.endsAt as Date;
  const row = icpcRow(attempts, startsAt, endsAt);
  const quizPoints = await quizTotal(db, contest._id, uid);
  await db.collection('standings').updateOne(
    { contestId: contest._id, userId: uid },
    {
      $set: {
        ...row,
        cells: problemCells(attempts, startsAt, endsAt),
        quizPoints,
        contestId: contest._id,
        userId: uid,
      },
    },
    { upsert: true },
  );
  return { ...row, quizPoints };
}

export interface BoardRow extends StandingRow {
  displayName: string;
  cells: Record<string, ProblemCell>;
}

export async function leaderboard(db: Db, contestId: string): Promise<BoardRow[]> {
  const rows = await db
    .collection('standings')
    .find({ contestId: new ObjectId(contestId) })
    .toArray();
  const users = await db.collection('users')
    .find({ _id: { $in: rows.map((r) => r.userId as ObjectId) } })
    .project({ displayName: 1 })
    .toArray();
  const names = new Map(users.map((u) => [String(u._id), u.displayName as string]));
  return rows
    .map((r) => {
      const source = r as Record<string, unknown>;
      return {
        userId: String(r.userId),
        displayName: names.get(String(r.userId)) ?? 'unknown',
        solved: (source.solved as number) ?? 0,
        penalty: (source.penalty as number) ?? 0,
        lastAcAt: (source.lastAcAt as Date | null) ?? null,
        quizPoints: (source.quizPoints as number) ?? 0,
        cells: (source.cells as Record<string, ProblemCell>) ?? {},
      };
    })
    .sort(compareStanding);
}

/** Earliest submittedAt wins; ties break on the lower submission id. */
export async function awardFirstSolve(
  db: Db,
  input: { contestId: ObjectId; problemId: ObjectId; userId: ObjectId; submissionId: ObjectId; submittedAt: Date },
) {
  try {
    await db.collection('first_solves').insertOne(input);
    return true;
  } catch (error) {
    if (typeof error === 'object' && error && (error as { code?: number }).code !== 11000) throw error;
  }
  const updated = await db.collection('first_solves').updateOne(
    {
      contestId: input.contestId,
      problemId: input.problemId,
      $or: [
        { submittedAt: { $gt: input.submittedAt } },
        { submittedAt: input.submittedAt, submissionId: { $gt: input.submissionId } },
      ],
    },
    { $set: { userId: input.userId, submissionId: input.submissionId, submittedAt: input.submittedAt } },
  );
  return updated.modifiedCount === 1;
}

/** Higher is better, in the same order as compareStanding (penalty stays under 1e5 minutes). */
export function standingScore(row: { solved: number; penalty: number; quizPoints?: number }) {
  return row.solved * 1e12 + (row.quizPoints ?? 0) * 1e5 - row.penalty;
}

export async function dispatchOutbox(
  db: Db,
  redis: {
    set: (key: string, value: string) => Promise<unknown>;
    zadd: (key: string, score: number, member: string) => Promise<unknown>;
  },
  emit: (room: string, event: string, payload: unknown) => void,
) {
  const rows = await db.collection('outbox').find({ sentAt: null }).sort({ createdAt: 1 }).limit(50).toArray();
  for (const row of rows) {
    const payload = (row.payload ?? {}) as {
      contestId?: string | null;
      userId?: string;
      kind?: string;
      verdict?: string;
      submissionId?: string;
      problemId?: string;
      submittedAt?: Date;
    };
    let rescore = row.type === 'QuizAnswered';
    if (row.type === 'VerdictCommitted' && payload.kind === 'contest' && payload.contestId && payload.userId && payload.submissionId) {
      rescore = true;
      const submission = await db.collection('submissions').findOne({ _id: new ObjectId(payload.submissionId) });
      if (submission && submission.status !== 'scored') {
        if (payload.verdict === 'AC' && payload.problemId) {
          await awardFirstSolve(db, {
            contestId: new ObjectId(payload.contestId),
            problemId: new ObjectId(payload.problemId),
            userId: new ObjectId(payload.userId),
            submissionId: submission._id,
            submittedAt: payload.submittedAt ?? (submission.submittedAt as Date),
          });
        }
        await db.collection('submissions').updateOne({ _id: submission._id }, { $set: { status: 'scored' } });
      }
    }
    if (rescore && payload.contestId && payload.userId) {
      const standing = await recomputeStanding(db, payload.contestId, payload.userId);
      if (standing) await redis.zadd(`lb:${payload.contestId}:rank`, standingScore(standing), payload.userId);
      const board = await leaderboard(db, payload.contestId);
      await redis.set(`lb:${payload.contestId}:board`, JSON.stringify(board));
      emit(`contest:${payload.contestId}`, 'leaderboard', board);
    }
    // Verdicts stay private: a broadcast would leak results during the freeze.
    if (payload.contestId && row.type !== 'VerdictCommitted') emit(`contest:${payload.contestId}`, String(row.type), payload);
    await db.collection('outbox').updateOne({ _id: row._id }, { $set: { sentAt: new Date() } });
  }
}
