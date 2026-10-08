import { practiceStreak, seededRng } from '@codeclash/shared';
import { describe, expect, it } from 'vitest';
import {
  emailFor, initialRating, MORE_QUIZ, PARTICIPANTS, practiceDays, simulateContest, solveChance, STAFF, STAFF_DOMAIN, STUDENT_DOMAIN,
} from './seed-data.js';

describe('seed people', () => {
  it('gives every person a unique, plain email', () => {
    const emails = [...PARTICIPANTS.map((n) => emailFor(n, STUDENT_DOMAIN)), ...STAFF.map((s) => emailFor(s.name, STAFF_DOMAIN))];
    expect(new Set(emails).size).toBe(emails.length);
    for (const email of emails) expect(email).toMatch(/^[a-z]+(\.[a-z]+)+@[a-z.]+$/);
    expect(emailFor("Liam O'Connor", 'x.dev')).toBe('liam.oconnor@x.dev');
    expect(emailFor('Tomás Silva', 'x.dev')).toBe('tomas.silva@x.dev');
  });

  it('draws ratings around 1400 inside 800..2600', () => {
    const rng = seededRng(1);
    const ratings = Array.from({ length: 2000 }, () => initialRating(rng));
    expect(Math.min(...ratings)).toBeGreaterThanOrEqual(800);
    expect(Math.max(...ratings)).toBeLessThanOrEqual(2600);
    const mean = ratings.reduce((a, b) => a + b, 0) / ratings.length;
    expect(mean).toBeGreaterThan(1350);
    expect(mean).toBeLessThan(1450);
  });
});

describe('practice days', () => {
  it('puts about a quarter of users on a live streak', () => {
    const rng = seededRng(2);
    const today = new Date();
    const key = (day: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - day * 86_400_000).toISOString().slice(0, 10);
    let streaking = 0;
    for (let i = 0; i < 400; i += 1) {
      const days = practiceDays(rng);
      expect(days.every((d) => d >= 0 && d < 112)).toBe(true);
      if (practiceStreak(days.map(key), today) > 0) streaking += 1;
    }
    expect(streaking / 400).toBeGreaterThan(0.18);
    expect(streaking / 400).toBeLessThan(0.38);
  });
});

describe('contest simulation', () => {
  it('lets stronger players solve harder problems more often', () => {
    expect(solveChance(1800, 1200)).toBeGreaterThan(0.9);
    expect(solveChance(1000, 1800)).toBeLessThan(0.05);
    expect(solveChance(1400, 1400)).toBeCloseTo(0.5);
  });

  it('keeps attempts inside the contest and ends each solved problem with one AC', () => {
    const rng = seededRng(3);
    const players = Array.from({ length: 40 }, (_, i) => ({ id: `u${i}`, skill: 900 + i * 30 }));
    const problems = [
      { id: 'A', rating: 800, wrongVerdicts: ['WA'] },
      { id: 'B', rating: 1300, wrongVerdicts: ['TLE', 'WA'] },
      { id: 'C', rating: 1900, wrongVerdicts: [] },
    ];
    const attempts = simulateContest(rng, players, problems, 120);
    expect(attempts.length).toBeGreaterThan(40);
    expect(attempts.every((a) => a.minute >= 0 && a.minute < 120)).toBe(true);
    for (const player of players) {
      for (const problem of problems) {
        const mine = attempts.filter((a) => a.userId === player.id && a.problemId === problem.id);
        expect(mine.filter((a) => a.verdict === 'AC').length).toBeLessThanOrEqual(1);
        const ac = mine.findIndex((a) => a.verdict === 'AC');
        if (ac >= 0) expect(ac).toBe(mine.length - 1);
      }
    }
    const solvedA = attempts.filter((a) => a.problemId === 'A' && a.verdict === 'AC').length;
    const solvedC = attempts.filter((a) => a.problemId === 'C' && a.verdict === 'AC').length;
    expect(solvedA).toBeGreaterThan(solvedC);
  });
});

describe('quiz bank', () => {
  it('has well-formed questions with three options', () => {
    expect(MORE_QUIZ.length).toBe(40);
    for (const q of MORE_QUIZ) {
      expect(q.options).toHaveLength(3);
      expect(q.correctIndex).toBeGreaterThanOrEqual(0);
      expect(q.correctIndex).toBeLessThan(3);
    }
    expect(new Set(MORE_QUIZ.map((q) => q.prompt)).size).toBe(MORE_QUIZ.length);
  });
});
