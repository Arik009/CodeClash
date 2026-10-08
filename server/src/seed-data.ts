import type { Rng } from '@codeclash/shared';

/** One documented password for every demo account. */
export const DEMO_PASSWORD = 'codeclash';
export const STUDENT_DOMAIN = 'students.codeclash.dev';
export const STAFF_DOMAIN = 'codeclash.dev';

export const PARTICIPANTS = [
  'Aarav Sharma', 'Vivaan Gupta', 'Aditya Verma', 'Ishaan Reddy', 'Arjun Nair', 'Kabir Malhotra', 'Reyansh Joshi',
  'Krishna Iyer', 'Sai Teja Kumar', 'Rohit Kulkarni', 'Siddharth Rao', 'Pranav Deshpande', 'Harsh Agarwal', 'Yash Patil',
  'Nikhil Menon', 'Karthik Subramanian', 'Varun Bhat', 'Abhinav Mishra', 'Dhruv Chauhan', 'Aniket Pawar', 'Rahul Saxena',
  'Manav Kapoor', 'Tanmay Jain', 'Shreyas Hegde', 'Omkar Shinde', 'Aryan Thakur', 'Devansh Bansal', 'Parth Shah',
  'Ritvik Sinha', 'Kunal Das', 'Ananya Krishnan', 'Diya Banerjee', 'Ishita Chatterjee', 'Kavya Pillai', 'Meera Joshi',
  'Nandini Rao', 'Priya Sundaram', 'Riya Mukherjee', 'Sneha Kulkarni', 'Tanvi Desai', 'Aditi Bhatt', 'Pooja Narayanan',
  'Shruti Venkatesh', 'Neha Choudhary', 'Sanya Arora', 'Lucas Moreau', 'Emma Schneider', 'Mateo García', 'Sofia Rossi',
  "Liam O'Connor", 'Yuki Tanaka', 'Minh Anh Nguyen', 'Chen Wei', 'Ji-woo Park', 'Amara Okeke', 'Omar Haddad',
  'Elena Petrova', 'Noah Fischer', 'Hannah Kim', 'Tomás Silva',
];

export const STAFF: { name: string; role: 'setter' | 'organiser' }[] = [
  { name: 'Meghna Raghavan', role: 'setter' },
  { name: 'Arnav Bhattacharya', role: 'setter' },
  { name: 'Daniel Novak', role: 'setter' },
  { name: 'Vikram Sethi', role: 'organiser' },
  { name: 'Laura Bennett', role: 'organiser' },
];

/** `Liam O'Connor` → `liam.oconnor`, `Mateo García` → `mateo.garcia`. */
export function emailFor(name: string, domain: string) {
  const local = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/\s+/).map((part) => part.replace(/[^a-z]/g, '')).filter(Boolean).join('.');
  return `${local}@${domain}`;
}

export function normal(rng: Rng) {
  const u = Math.max(rng.next(), 1e-12);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Starting rating around 1400 with spread 300, clamped to 800..2600. */
export function initialRating(rng: Rng) {
  return Math.min(2600, Math.max(800, Math.round(1400 + 300 * normal(rng))));
}

/**
 * Days (0 = today, 1 = yesterday, ...) with practice in the last `span` days. Activity comes in
 * runs; about a quarter of users are on a streak that ends today or yesterday.
 */
export function practiceDays(rng: Rng, span = 112) {
  const level = 0.08 + 0.55 * rng.next();
  const active = new Set<number>();
  let on = rng.next() < level;
  for (let day = span - 1; day >= 0; day -= 1) {
    const stay = Math.min(0.92, level + 0.3);
    on = on ? rng.next() < stay : rng.next() < level * 0.6;
    if (on) active.add(day);
  }
  if (rng.next() < 0.28) {
    const end = rng.next() < 0.6 ? 0 : 1;
    const length = 2 + Math.floor(rng.next() * 40);
    if (end === 1) active.delete(0);
    for (let day = end; day < end + length && day < span; day += 1) active.add(day);
    active.delete(end + length);
  } else {
    active.delete(0);
    active.delete(1);
  }
  return [...active].sort((a, b) => a - b);
}

export interface SimProblem { id: string; rating: number; wrongVerdicts: string[] }
export interface SimPlayer { id: string; skill: number }
export interface SimAttempt { userId: string; problemId: string; verdict: string; minute: number; wrongIndex: number }

/** Chance that a player of `skill` solves a problem of `rating` within the contest. */
export function solveChance(skill: number, rating: number) {
  return 1 / (1 + Math.exp((rating - skill) / 170));
}

/**
 * Plausible contest history: players work through problems in order, stronger players solve
 * more and sooner, and some solves come after wrong attempts.
 */
export function simulateContest(rng: Rng, players: SimPlayer[], problems: SimProblem[], minutes: number): SimAttempt[] {
  const attempts: SimAttempt[] = [];
  for (const player of players) {
    let clock = 3 + Math.floor(rng.next() * 8);
    for (const problem of problems) {
      // Contest pressure: players perform somewhat below their rating against the clock.
      const chance = solveChance(player.skill - 150 + 80 * normal(rng), problem.rating);
      const tries = rng.next() < chance + 0.2;
      if (!tries) continue;
      const solves = rng.next() < chance;
      const gap = Math.max(4, Math.round((8 + 30 * rng.next()) * (1 + Math.max(-0.6, (problem.rating - player.skill) / 500))));
      const wrongs = solves ? (rng.next() < 0.55 ? 0 : rng.next() < 0.7 ? 1 : 2) : 1 + Math.floor(rng.next() * 3);
      for (let k = 0; k < wrongs; k += 1) {
        const minute = clock + Math.round(((k + 1) * gap) / (wrongs + 1));
        if (minute >= minutes) break;
        const wrongIndex = problem.wrongVerdicts.length ? Math.floor(rng.next() * problem.wrongVerdicts.length) : -1;
        attempts.push({ userId: player.id, problemId: problem.id, verdict: wrongIndex >= 0 ? problem.wrongVerdicts[wrongIndex]! : 'WA', minute, wrongIndex });
      }
      clock += gap;
      if (solves && clock < minutes) attempts.push({ userId: player.id, problemId: problem.id, verdict: 'AC', minute: clock, wrongIndex: -1 });
      if (clock >= minutes) break;
    }
  }
  return attempts.sort((a, b) => a.minute - b.minute);
}
