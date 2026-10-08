import { canTransition, type ContestStatus } from '@codeclash/shared';
import { type Db, ObjectId } from 'mongodb';
import { auditCollection } from '../db/audit.js';
import { HttpError } from './errors.js';

export async function transitionContest(db: Db, contestId: string, to: ContestStatus, actorId: string) {
  const contest = await db.collection('contests').findOne({ _id: new ObjectId(contestId) });
  if (!contest) throw new HttpError(404, 'Contest not found');
  const from = contest.status as ContestStatus;
  if (!canTransition(from, to)) throw new HttpError(409, `Cannot move from ${from} to ${to}`);
  await db.collection('contests').updateOne({ _id: contest._id, status: from }, { $set: { status: to } });
  if (to === 'cancelled') {
    await db.collection('seats').updateMany(
      { contestId: contest._id, active: true },
      { $set: { status: 'withdrawn', active: false } },
    );
    await db.collection('contests').updateOne({ _id: contest._id }, { $set: { reserved: 0 } });
  }
  if (to === 'running') {
    await db.collection('seats').updateMany(
      { contestId: contest._id, status: { $in: ['reserved', 'modified'] } },
      { $set: { status: 'competing' } },
    );
  }
  await db.collection('outbox').insertOne({
    type: 'ContestStatus',
    payload: { contestId, status: to },
    createdAt: new Date(),
    sentAt: null,
  });
  let ratingDeltas: unknown[] = [];
  if (to === 'published') {
    const { applyRatings } = await import('./product.js');
    ratingDeltas = await applyRatings(db, contestId);
  }
  await auditCollection(db).insertOne({
    actor: actorId,
    actorType: 'user',
    action: 'contest.transition',
    target: contestId,
    decision: `${from}->${to}`,
    payload: { before: { status: from }, after: { status: to }, reason: to === 'cancelled' ? 'cancelled by organiser' : '', ratingDeltas },
    at: new Date(),
  });
  return { from, to, ratings: ratingDeltas.length };
}

export async function tickContests(db: Db, now = new Date()) {
  const due = await db
    .collection('contests')
    .find({
      $or: [
        { status: 'draft', registrationOpensAt: { $lte: now } },
        { status: 'registration_open', startsAt: { $lte: now } },
        { status: 'running', freezeAt: { $lte: now } },
        { status: 'frozen', endsAt: { $lte: now } },
      ],
    })
    .toArray();
  const moved: string[] = [];
  for (const contest of due) {
    const next: ContestStatus =
      contest.status === 'draft'
        ? 'registration_open'
        : contest.status === 'registration_open'
          ? 'running'
          : contest.status === 'running'
            ? 'frozen'
            : 'ended';
    try {
      await transitionContest(db, String(contest._id), next, 'scheduler');
      moved.push(String(contest._id));
    } catch {
      /* a concurrent tick already moved it */
    }
  }
  return moved;
}
