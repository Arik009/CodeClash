
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

export const SOURCE_LANGUAGES = ['python', 'javascript'] as const;
export type SourceLanguage = (typeof SOURCE_LANGUAGES)[number];

export const LANGUAGE_NAMES: Record<SourceLanguage, string> = {
  python: 'Python 3',
  javascript: 'JavaScript (Node)',
};

/** Used when a problem has no limit stored for that language. */
export function defaultLimit(_language: SourceLanguage): { timeMs: number; memoryMb: number } {
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
