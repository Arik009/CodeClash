/**
 * Pure helpers for importing DeepMind CodeContests (CC BY 4.0) rows. The script in
 * scripts/import-codecontests.mjs does the reading, sandbox verification and packing.
 */

export interface TestSet { input: string[]; output: string[] }
export interface Solutions { language: number[]; solution: string[] }

export interface ContestRow {
  name: string;
  description: string;
  public_tests: TestSet;
  private_tests: TestSet;
  generated_tests: TestSet;
  source: number | bigint;
  solutions: Solutions;
  incorrect_solutions: Solutions;
  cf_contest_id: number | bigint;
  cf_index: string;
  cf_rating: number | bigint;
  cf_tags: string[];
  is_description_translated: boolean;
  time_limit: { seconds: number | bigint; nanos: number | bigint } | null;
  memory_limit_bytes: number | bigint;
  input_file: string;
  output_file: string;
}

export interface PickedTest { input: string; output: string; hidden: boolean }

const CODEFORCES = 2;
/** CodeContests language ids that our sandbox runs, in the order we try them. */
export const LANGUAGE_IDS: Record<number, 'python' | 'cpp'> = { 3: 'python', 2: 'cpp' };

const REJECT: [RegExp, string][] = [
  [/<image>/i, 'has an image'],
  [/\binteract(ive|ion)\b|\bflush\b/i, 'interactive'],
  [/\bany of them\b|\bprint any\b|\boutput any\b|\bany (valid |correct |possible )?(answer|solution|one)\b|\b(multiple|several) (possible |correct |valid )?(answers|solutions)\b/i, 'accepts several answers'],
  [/\b(absolute|relative) (or (absolute|relative) )?error\b|\bprecision\b|\bchecker\b/i, 'needs a float or special checker'],
];

export function rejectReason(row: ContestRow, maxRating = 2400): string | null {
  if (Number(row.source) !== CODEFORCES) return 'not Codeforces';
  if (row.input_file || row.output_file) return 'reads a file';
  if (row.is_description_translated) return 'translated statement';
  const rating = Number(row.cf_rating);
  if (!rating) return 'no rating';
  if (rating > maxRating) return 'rated above the cut';
  if (row.description.length > 6000) return 'statement too long';
  if (!/\n\s*Input\s*\n/.test(row.description) || !/\n\s*Output\s*\n/.test(row.description)) return 'no Input/Output sections';
  for (const [pattern, reason] of REJECT) if (pattern.test(row.description)) return reason;
  if (row.public_tests.input.length === 0) return 'no sample';
  return null;
}

/** `1548_C. The Three Little Pigs` → `The Three Little Pigs`. */
export function titleOf(name: string) {
  return name.replace(/^\d+_[A-Z]\d?\.\s*/, '').trim();
}

export function difficultyOf(rating: number): 'easy' | 'medium' | 'hard' {
  if (rating <= 1200) return 'easy';
  if (rating <= 1800) return 'medium';
  return 'hard';
}

export function tagsOf(tags: string[]) {
  return [...new Set(tags.filter((t) => t && !t.startsWith('*')).map((t) => t.trim().toLowerCase().replace(/\s+/g, '-')))];
}

/**
 * Drops the Examples section (samples are shown separately), turns `$$$x$$$` into inline code,
 * and normalises blank lines so headings sit on their own paragraph.
 */
export function convertDescription(text: string) {
  let out = text.replace(/\r\n/g, '\n');
  out = out.replace(/\n\s*Examples?\s*\n[\s\S]*?(?=\n\s*Note\s*\n|$)/, '\n');
  out = out.replace(/\$\$\$\$\$\$([\s\S]+?)\$\$\$\$\$\$/g, (_, math: string) => `\`${math.trim()}\``);
  out = out.replace(/\$\$\$([\s\S]+?)\$\$\$/g, (_, math: string) => `\`${math.trim()}\``);
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return tidyStatement(out.trim());
}

/** Markdown links keep only their text, and list markers become one bullet style. */
export function tidyStatement(text: string) {
  return text
    .replace(/\[([^\]\n]+)\]\((?:https?:)?\/\/[^)\s]+\)/g, '$1')
    .replace(/^[ \t]*[*-][ \t]+/gm, '• ');
}

export function samplesText(tests: TestSet) {
  return tests.input.map((input, i) => `Input\n${input.trimEnd()}\nOutput\n${(tests.output[i] ?? '').trimEnd()}`).join('\n');
}

/**
 * Samples stay visible. Hidden tests come from the private set first, then the generated set,
 * skipping anything over the per-test size and stopping at the count or byte budget.
 */
export function pickTests(row: ContestRow, { maxTests = 15, maxBytes = 32_000, budget = 96_000 } = {}): PickedTest[] {
  const picked: PickedTest[] = [];
  let used = 0;
  const take = (set: TestSet, hidden: boolean) => {
    set.input.forEach((input, i) => {
      const output = set.output[i] ?? '';
      const size = input.length + output.length;
      if (picked.length >= maxTests || input.length > maxBytes || output.length > maxBytes || used + size > budget) return;
      if (picked.some((t) => t.input === input)) return;
      picked.push({ input, output, hidden });
      used += size;
    });
  };
  take(row.public_tests, false);
  take(row.private_tests, true);
  take(row.generated_tests, true);
  return picked;
}

export function solutionsIn(solutions: Solutions, max: number) {
  const out: { language: 'python' | 'cpp'; code: string }[] = [];
  for (const id of [3, 2]) {
    solutions.language.forEach((language, i) => {
      if (Number(language) === id && out.filter((s) => s.language === LANGUAGE_IDS[id]).length < max) {
        out.push({ language: LANGUAGE_IDS[id]!, code: solutions.solution[i]! });
      }
    });
  }
  return out;
}

export function limitsOf(row: ContestRow) {
  const seconds = row.time_limit ? Number(row.time_limit.seconds) + Number(row.time_limit.nanos) / 1e9 : 2;
  const timeMs = Math.min(4000, Math.max(1000, Math.round(seconds * 1000)));
  const memoryMb = Math.min(512, Math.max(64, Math.round(Number(row.memory_limit_bytes || 256_000_000) / 1_000_000)));
  return { timeMs, memoryMb };
}

export function sourceOf(row: ContestRow) {
  const contestId = Number(row.cf_contest_id);
  return {
    platform: 'Codeforces',
    contestId,
    index: row.cf_index,
    url: `https://codeforces.com/problemset/problem/${contestId}/${row.cf_index}`,
    dataset: 'DeepMind CodeContests',
    license: 'CC BY 4.0',
  };
}
