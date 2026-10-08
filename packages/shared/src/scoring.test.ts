import { describe, expect, it } from 'vitest';
import {
  canTransition,
  practiceStreak,
  rateContest,
  streakBonus,
  compareIcpc,
  compareStanding,
  firstSolveBonusPoints,
  icpcRow,
  practiceSlotCap,
  problemCells,
  quizScore,
} from './index.js';

const start = new Date('2026-10-01T10:00:00Z');
const end = new Date('2026-10-01T15:00:00Z');

describe('icpc', () => {
  it('adds 0 penalty for an unsolved problem with wrong attempts', () => {
    const row = icpcRow(
      [
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:10:00Z'), submissionId: '1' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:20:00Z'), submissionId: '2' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:30:00Z'), submissionId: '3' },
      ],
      start,
      end,
    );
    expect(row).toEqual({ solved: 0, penalty: 0, lastAcAt: null });
  });

  it('counts only rejections before the first AC, and never CE', () => {
    const row = icpcRow(
      [
        { problemId: 'a', verdict: 'CE', submittedAt: new Date('2026-10-01T10:05:00Z'), submissionId: '1' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:10:00Z'), submissionId: '2' },
        { problemId: 'a', verdict: 'AC', submittedAt: new Date('2026-10-01T10:30:00Z'), submissionId: '3' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T11:00:00Z'), submissionId: '4' },
      ],
      start,
      end,
    );
    expect(row.solved).toBe(1);
    expect(row.penalty).toBe(30 + 20);
  });

  it('builds standings cells with the same rules', () => {
    const cells = problemCells(
      [
        { problemId: 'a', verdict: 'CE', submittedAt: new Date('2026-10-01T10:05:00Z'), submissionId: '1' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:10:00Z'), submissionId: '2' },
        { problemId: 'a', verdict: 'AC', submittedAt: new Date('2026-10-01T10:30:00Z'), submissionId: '3' },
        { problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T11:00:00Z'), submissionId: '4' },
        { problemId: 'b', verdict: 'TLE', submittedAt: new Date('2026-10-01T10:40:00Z'), submissionId: '5' },
      ],
      start,
      end,
    );
    expect(cells).toEqual({
      a: { solved: true, tries: 1, minute: 30 },
      b: { solved: false, tries: 1, minute: null },
    });
  });

  it('drops a problem when a rejudge turns the only AC into WA', () => {
    const row = icpcRow(
      [{ problemId: 'a', verdict: 'WA', submittedAt: new Date('2026-10-01T10:30:00Z'), submissionId: '3' }],
      start,
      end,
    );
    expect(row.penalty).toBe(0);
    expect(row.solved).toBe(0);
  });

  it('ranks solved desc, then penalty asc, then earlier last AC', () => {
    const rows = [
      { userId: 'b', solved: 1, penalty: 40, lastAcAt: new Date('2026-10-01T11:00:00Z') },
      { userId: 'a', solved: 2, penalty: 100, lastAcAt: new Date('2026-10-01T12:00:00Z') },
      { userId: 'c', solved: 1, penalty: 40, lastAcAt: new Date('2026-10-01T10:40:00Z') },
    ].sort(compareIcpc);
    expect(rows.map((r) => r.userId)).toEqual(['a', 'c', 'b']);
  });

  it('breaks a solved tie on quiz points before penalty in a mixed contest', () => {
    const rows = [
      { userId: 'a', solved: 1, penalty: 10, lastAcAt: null, quizPoints: 500 },
      { userId: 'b', solved: 1, penalty: 90, lastAcAt: null, quizPoints: 900 },
      { userId: 'c', solved: 2, penalty: 300, lastAcAt: null, quizPoints: 0 },
    ].sort(compareStanding);
    expect(rows.map((r) => r.userId)).toEqual(['c', 'b', 'a']);
  });
});

describe('quiz', () => {
  it('scores B at t=0 and B/2 at the deadline, and rejects late answers', () => {
    expect(quizScore(1000, 0, 30, true)).toBe(1000);
    expect(quizScore(1000, 30, 30, true)).toBe(500);
    expect(quizScore(1000, 6, 30, true)).toBeGreaterThan(quizScore(1000, 25, 30, true)!);
    expect(quizScore(1000, 31, 30, true)).toBeNull();
    expect(quizScore(1000, 5, 30, false)).toBe(0);
  });
});

describe('rules', () => {
  it('rejects illegal contest jumps', () => {
    expect(canTransition('draft', 'running')).toBe(false);
    expect(canTransition('draft', 'registration_open')).toBe(true);
    expect(canTransition('running', 'frozen')).toBe(true);
  });

  it('gives practice at most 20% of slots while a contest runs', () => {
    expect(practiceSlotCap(24, true)).toBe(4);
    expect(practiceSlotCap(4, true)).toBe(0);
    expect(practiceSlotCap(4, false)).toBe(4);
  });

  it('keeps the ICPC bonus as a badge', () => {
    expect(firstSolveBonusPoints(1000, 'icpc')).toBe(0);
    expect(firstSolveBonusPoints(1000, 'quiz')).toBe(100);
  });

  it('allows cancelling a contest that has not published', () => {
    expect(canTransition('registration_open', 'cancelled')).toBe(true);
    expect(canTransition('running', 'cancelled')).toBe(true);
    expect(canTransition('published', 'cancelled')).toBe(false);
    expect(canTransition('cancelled', 'running')).toBe(false);
  });

  it('adds a capped streak bonus on top of a correct quiz answer', () => {
    expect(streakBonus(1000, 0)).toBe(0);
    expect(streakBonus(1000, 1)).toBe(100);
    expect(streakBonus(1000, 9)).toBe(500);
  });

  it('counts a practice streak through yesterday when today is empty', () => {
    expect(practiceStreak(['2026-09-29', '2026-09-30'], new Date('2026-10-01T12:00:00Z'))).toBe(2);
    expect(practiceStreak(['2026-09-28'], new Date('2026-10-01T12:00:00Z'))).toBe(0);
  });

  it('moves rating toward the result of the contest and floors it at 100', () => {
    const rated = rateContest([
      { userId: 'a', rating: 1200, place: 1 },
      { userId: 'b', rating: 1200, place: 2 },
    ]);
    expect(rated.find((row) => row.userId === 'a')!.delta).toBeGreaterThan(0);
    expect(rated.find((row) => row.userId === 'b')!.delta).toBeLessThan(0);
    expect(rateContest([{ userId: 'a', rating: 100, place: 2 }, { userId: 'b', rating: 2000, place: 1 }])[0]!.after).toBeGreaterThanOrEqual(100);
  });
});
