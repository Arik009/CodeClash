export * from './spec.js';

export const VERDICTS = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'] as const;
export type Verdict = (typeof VERDICTS)[number];

export const CONTEST_STATUSES = [
  'draft',
  'registration_open',
  'running',
  'frozen',
  'ended',
  'published',
  'cancelled',
] as const;
export type ContestStatus = (typeof CONTEST_STATUSES)[number];

export const ROLES = ['participant', 'setter', 'organiser', 'admin'] as const;
export type Role = (typeof ROLES)[number];

export const SOURCE_LANGUAGES = ['python', 'javascript', 'c', 'cpp', 'java', 'go'] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SourceLanguage, string> = {
  python: 'Python 3',
  javascript: 'JavaScript (Node)',
  c: 'C (gcc)',
  cpp: 'C++17 (g++)',
  java: 'Java 21',
  go: 'Go',
};

/** Used when a problem has no limit stored for that language. Java gets more room for the JVM. */
export function defaultLimit(language: SourceLanguage): { timeMs: number; memoryMb: number } {
  if (language === 'java') return { timeMs: 3000, memoryMb: 512 };
  return { timeMs: 2000, memoryMb: 256 };
}

export function defaultLimits(): Record<SourceLanguage, { timeMs: number; memoryMb: number }> {
  return Object.fromEntries(SOURCE_LANGUAGES.map((language) => [language, defaultLimit(language)])) as Record<SourceLanguage, { timeMs: number; memoryMb: number }>;
}

const NEXT: Record<ContestStatus, ContestStatus[]> = {
  draft: ['registration_open', 'cancelled'],
  registration_open: ['running', 'cancelled'],
  running: ['frozen', 'cancelled'],
  frozen: ['ended', 'cancelled'],
  ended: ['published', 'cancelled'],
  published: [],
  cancelled: [],
};

export function allowedTransitions(from: ContestStatus): ContestStatus[] {
  return NEXT[from];
}

export function canTransition(from: ContestStatus, to: ContestStatus): boolean {
  return NEXT[from].includes(to);
}

export interface Attempt {
  problemId: string;
  verdict: Verdict;
  submittedAt: Date;
  submissionId: string;
}

export interface IcpcRow {
  solved: number;
  penalty: number;
  lastAcAt: Date | null;
}

/** ICPC: solved desc, penalty asc, earlier last AC. Unsolved problems add 0. CE never counts. */
export function icpcRow(attempts: Attempt[], contestStart: Date, contestEnd: Date): IcpcRow {
  const byProblem = new Map<string, Attempt[]>();
  for (const attempt of attempts) {
    const list = byProblem.get(attempt.problemId) ?? [];
    list.push(attempt);
    byProblem.set(attempt.problemId, list);
  }

  let solved = 0;
  let penalty = 0;
  let lastAcAt: Date | null = null;

  for (const list of byProblem.values()) {
    const ordered = [...list].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
    const firstAc = ordered.find(
      (a) => a.verdict === 'AC' && a.submittedAt.getTime() <= contestEnd.getTime(),
    );
    if (!firstAc) continue;
    const wrongBefore = ordered.filter(
      (a) =>
        a.submittedAt.getTime() < firstAc.submittedAt.getTime() &&
        a.verdict !== 'AC' &&
        a.verdict !== 'CE',
    ).length;
    const minutes = Math.floor((firstAc.submittedAt.getTime() - contestStart.getTime()) / 60000);
    solved += 1;
    penalty += minutes + 20 * wrongBefore;
    if (!lastAcAt || firstAc.submittedAt.getTime() > lastAcAt.getTime()) {
      lastAcAt = firstAc.submittedAt;
    }
  }

  return { solved, penalty, lastAcAt };
}

export interface ProblemCell {
  solved: boolean;
  /** Rejected attempts before the first AC (all of them when unsolved); CE is free. */
  tries: number;
  minute: number | null;
}

/** One standings cell per attempted problem, in the same terms as icpcRow. */
export function problemCells(attempts: Attempt[], contestStart: Date, contestEnd: Date): Record<string, ProblemCell> {
  const cells: Record<string, ProblemCell> = {};
  const ordered = [...attempts].sort((a, b) => a.submittedAt.getTime() - b.submittedAt.getTime());
  for (const attempt of ordered) {
    const cell = cells[attempt.problemId] ?? { solved: false, tries: 0, minute: null };
    cells[attempt.problemId] = cell;
    if (cell.solved || attempt.verdict === 'CE') continue;
    if (attempt.verdict === 'AC' && attempt.submittedAt.getTime() <= contestEnd.getTime()) {
      cell.solved = true;
      cell.minute = Math.floor((attempt.submittedAt.getTime() - contestStart.getTime()) / 60000);
    } else if (attempt.verdict !== 'AC') {
      cell.tries += 1;
    }
  }
  return cells;
}

export function compareIcpc(a: IcpcRow & { userId: string }, b: IcpcRow & { userId: string }): number {
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.penalty !== b.penalty) return a.penalty - b.penalty;
  const at = a.lastAcAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  const bt = b.lastAcAt?.getTime() ?? Number.MAX_SAFE_INTEGER;
  if (at !== bt) return at - bt;
  return a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0;
}

export interface StandingRow extends IcpcRow {
  userId: string;
  quizPoints: number;
  /** Set for IOI contests: best partial score summed across problems. */
  points?: number;
}

/** IOI points rank first when either row has them. Otherwise solved, then quiz, then penalty. */
export function compareStanding(a: StandingRow, b: StandingRow): number {
  if (a.points !== undefined || b.points !== undefined) {
    const delta = (b.points ?? 0) - (a.points ?? 0);
    if (delta !== 0) return delta;
  }
  if (a.solved !== b.solved) return b.solved - a.solved;
  if (a.quizPoints !== b.quizPoints) return b.quizPoints - a.quizPoints;
  return compareIcpc(a, b);
}

/** Quiz speed. Returns null when the answer is late (rejected). Wrong answers score 0. */
export function quizScore(base: number, tSeconds: number, windowSeconds: number, correct: boolean): number | null {
  if (tSeconds < 0 || tSeconds > windowSeconds) return null;
  if (!correct) return 0;
  return Math.round(base * (1 - 0.5 * (tSeconds / windowSeconds)));
}

/** Extra points for a correct quiz answer after `priorCorrect` correct answers in a row. Capped at five steps. */
export function streakBonus(base: number, priorCorrect: number): number {
  const steps = Math.min(Math.max(0, priorCorrect), 5);
  return Math.round(base * 0.1 * steps);
}

/** Consecutive UTC days with a solve, ending today, or yesterday when today is still empty. */
export function practiceStreak(dayKeys: string[], today = new Date()): number {
  const days = new Set(dayKeys);
  const cursor = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const key = (date: Date) => date.toISOString().slice(0, 10);
  if (!days.has(key(cursor))) cursor.setUTCDate(cursor.getUTCDate() - 1);
  let streak = 0;
  while (days.has(key(cursor))) {
    streak += 1;
    cursor.setUTCDate(cursor.getUTCDate() - 1);
  }
  return streak;
}

export interface SubtaskDef {
  name: string;
  points: number;
}

/** A subtask scores only when every test in its group is accepted. Groups are independent. */
export function partialScore(
  tests: { group?: string | null }[],
  verdicts: (string | null)[],
  subtasks: SubtaskDef[],
): { points: number; max: number; groups: { name: string; points: number; earned: number }[] } {
  if (subtasks.length === 0) {
    const ok = verdicts.length > 0 && verdicts.every((verdict) => verdict === 'AC');
    return { points: ok ? 100 : 0, max: 100, groups: [] };
  }
  const groups = subtasks.map((subtask) => {
    const indexes = tests.flatMap((test, index) => ((test.group ?? 'main') === subtask.name ? [index] : []));
    const solved = indexes.length > 0 && indexes.every((index) => verdicts[index] === 'AC');
    return { name: subtask.name, points: subtask.points, earned: solved ? subtask.points : 0 };
  });
  return {
    points: groups.reduce((sum, group) => sum + group.earned, 0),
    max: groups.reduce((sum, group) => sum + group.points, 0),
    groups,
  };
}

export interface RatedPlayer {
  userId: string;
  rating: number;
  place: number;
}

/** Elo over the final ranking. Each player plays every other player once; K is spread across those games. */
export function rateContest(players: RatedPlayer[], k = 24): { userId: string; before: number; after: number; delta: number }[] {
  return players.map((player) => {
    let actual = 0;
    let expected = 0;
    let games = 0;
    for (const other of players) {
      if (other.userId === player.userId) continue;
      games += 1;
      actual += player.place < other.place ? 1 : player.place === other.place ? 0.5 : 0;
      expected += 1 / (1 + 10 ** ((other.rating - player.rating) / 400));
    }
    const delta = games === 0 ? 0 : Math.round((k * (actual - expected)) / games);
    const after = Math.max(100, player.rating + delta);
    return { userId: player.userId, before: player.rating, after, delta: after - player.rating };
  });
}

export function firstSolveBonusPoints(maxPoints: number, mode: 'icpc' | 'quiz' | 'ioi'): number {
  if (mode === 'icpc') return 0;
  return Math.round(maxPoints * 0.1);
}

/** Practice may use at most 20% of slots while a contest is running. */
export function practiceSlotCap(totalSlots: number, contestRunning: boolean): number {
  if (!contestRunning) return totalSlots;
  return Math.floor(totalSlots * 0.2);
}

export const AGENT_TOOLS = {
  read_problem: 'allow',
  run_in_sandbox: 'allow',
  propose_test: 'hold',
  propose_wrong_solution: 'hold',
  publish: 'deny',
  edit_tests: 'deny',
  delete_tests: 'deny',
  change_limits: 'deny',
  change_score: 'deny',
  disqualify: 'deny',
} as const;

export type AgentTool = keyof typeof AGENT_TOOLS;
export type GateDecision = 'allow' | 'hold' | 'deny';

export function gateTool(name: string): GateDecision {
  if (name in AGENT_TOOLS) return AGENT_TOOLS[name as AgentTool];
  return 'deny';
}
