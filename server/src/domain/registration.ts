import { type ClientSession, type Db, ObjectId } from 'mongodb';
import { HttpError, isDuplicateKey } from './errors.js';

export interface ReserveResult {
  outcome: 'reserved' | 'waitlisted' | 'existing';
  seatId: string;
  position?: number;
}

async function existingSeat(db: Db, contestId: ObjectId, userId: ObjectId, session: ClientSession) {
  return db.collection('seats').findOne({ contestId, userId, active: true }, { session });
}

export async function reserveSeat(db: Db, contestId: string, userId: string): Promise<ReserveResult> {
  const cid = new ObjectId(contestId);
  const uid = new ObjectId(userId);
  const session = db.client.startSession();
  try {
    let result: ReserveResult | undefined;
    await session.withTransaction(async () => {
      const held = await existingSeat(db, cid, uid, session);
      if (held) {
        result = { outcome: 'existing', seatId: String(held._id), position: held.waitlistPos ?? undefined };
        return;
      }
      const updated = await db.collection('contests').findOneAndUpdate(
        {
          _id: cid,
          status: { $in: ['registration_open', 'running'] },
          $expr: { $lt: ['$reserved', '$capacity'] },
        },
        { $inc: { reserved: 1 } },
        { session, returnDocument: 'after' },
      );
      if (updated) {
        const inserted = await db.collection('seats').insertOne(
          {
            contestId: cid,
            userId: uid,
            status: updated.status === 'running' ? 'competing' : 'reserved',
            active: true,
            waitlistPos: null,
            createdAt: new Date(),
          },
          { session },
        );
        result = { outcome: 'reserved', seatId: String(inserted.insertedId) };
        return;
      }
      const contest = await db.collection('contests').findOne({ _id: cid }, { session });
      if (!contest || !['registration_open', 'running'].includes(contest.status as string)) {
        throw new HttpError(409, 'Registration is not open');
      }
      const sequenced = await db.collection('contests').findOneAndUpdate(
        { _id: cid },
        { $inc: { waitlistSeq: 1 } },
        { session, returnDocument: 'after' },
      );
      const position = sequenced?.waitlistSeq as number;
      const inserted = await db.collection('seats').insertOne(
        {
          contestId: cid,
          userId: uid,
          status: 'waitlisted',
          active: true,
          waitlistPos: position,
          createdAt: new Date(),
        },
        { session },
      );
      result = { outcome: 'waitlisted', seatId: String(inserted.insertedId), position };
    });
    if (!result) throw new HttpError(500, 'Reservation produced no result');
    return result;
  } catch (error) {
    if (isDuplicateKey(error)) {
      const held = await db.collection('seats').findOne({ contestId: cid, userId: uid, active: true });
      if (held) return { outcome: 'existing', seatId: String(held._id) };
    }
    throw error;
  } finally {
    await session.endSession();
  }
}

export async function withdrawSeat(db: Db, seatId: string, userId: string) {
  const session = db.client.startSession();
  try {
    let promoted: string | null = null;
    await session.withTransaction(async () => {
      const seat = await db.collection('seats').findOne(
        { _id: new ObjectId(seatId), userId: new ObjectId(userId), status: { $in: ['reserved', 'modified'] } },
        { session },
      );
      if (!seat) throw new HttpError(404, 'No reserved seat to withdraw');
      await db.collection('seats').updateOne(
        { _id: seat._id },
        { $set: { status: 'withdrawn', active: false } },
        { session },
      );
      const contest = await db.collection('contests').findOne({ _id: seat.contestId }, { session });
      const promotedStatus = contest?.status === 'running' ? 'competing' : 'reserved';
      const head = await db.collection('seats').findOneAndUpdate(
        { contestId: seat.contestId, status: 'waitlisted', active: true },
        { $set: { status: promotedStatus, waitlistPos: null } },
        { sort: { waitlistPos: 1 }, session, returnDocument: 'after' },
      );
      if (head) {
        promoted = String(head.userId);
      } else {
        await db.collection('contests').updateOne({ _id: seat.contestId }, { $inc: { reserved: -1 } }, { session });
      }
      await db.collection('outbox').insertOne(
        {
          type: 'SeatChanged',
          payload: { contestId: String(seat.contestId), promotedUserId: promoted },
          createdAt: new Date(),
          sentAt: null,
        },
        { session },
      );
    });
    return { promotedUserId: promoted };
  } finally {
    await session.endSession();
  }
}

export async function seatInvariants(db: Db, contestId: string) {
  const cid = new ObjectId(contestId);
  const contest = await db.collection('contests').findOne({ _id: cid });
  const reservedCount = await db.collection('seats').countDocuments({
    contestId: cid,
    status: { $in: ['reserved', 'modified', 'competing'] },
  });
  const dupes = await db
    .collection('seats')
    .aggregate([
      { $match: { contestId: cid, active: true } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  return {
    reserved: contest?.reserved ?? -1,
    capacity: contest?.capacity ?? -1,
    reservedCount,
    overCapacity: (contest?.reserved ?? 0) > (contest?.capacity ?? 0),
    countMismatch: (contest?.reserved ?? 0) !== reservedCount,
    duplicateUsers: dupes.length,
  };
}
