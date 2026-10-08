
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
