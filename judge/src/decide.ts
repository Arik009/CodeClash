import { partialScore, type SubtaskDef } from '@codeclash/shared';

export type JudgeVerdict = 'AC' | 'WA' | 'TLE' | 'MLE' | 'RE' | 'CE';

export interface CaseResult {
  verdict: JudgeVerdict;
  reason: string | null;
}

/** Stop at the first failure. Output over the cap is RE, not a separate verdict. */
export function decide(cases: CaseResult[]): { verdict: JudgeVerdict; reason: string | null } {
  if (cases.length === 0) return { verdict: 'RE', reason: 'no tests' };
  const failed = cases.find((c) => c.verdict !== 'AC');
  return failed ?? { verdict: 'AC', reason: null };
}

/** Run cases until the first non-AC. Later cases are not started. */
export async function judgeCases<T>(
  tests: T[],
  run: (test: T) => Promise<CaseResult>,
): Promise<{ verdict: JudgeVerdict; reason: string | null; ran: number }> {
  const cases: CaseResult[] = [];
  for (const test of tests) {
    cases.push(await run(test));
    if (cases.at(-1)?.verdict !== 'AC') break;
  }
  return { ...decide(cases), ran: cases.length };
}

/**
 * Each subtask stops at its first failure. Later subtasks still run,
 * so a sample solve can score even when the full tests fail.
 */
export async function judgeSubtasks<T extends { group?: string | null }>(
  tests: T[],
  subtasks: SubtaskDef[],
  run: (test: T) => Promise<CaseResult>,
): Promise<{ verdict: JudgeVerdict; reason: string | null; ran: number; points: number; max: number }> {
  if (subtasks.length === 0) {
    const result = await judgeCases(tests, run);
    return { ...result, points: result.verdict === 'AC' ? 100 : 0, max: 100 };
  }
  const verdicts: (JudgeVerdict | null)[] = tests.map(() => null);
  let ran = 0;
  let firstFail: CaseResult | null = null;
  for (const subtask of subtasks) {
    for (let index = 0; index < tests.length; index += 1) {
      if ((tests[index]!.group ?? 'main') !== subtask.name) continue;
      const outcome = await run(tests[index]!);
      verdicts[index] = outcome.verdict;
      ran += 1;
      if (outcome.verdict !== 'AC') {
        firstFail ??= outcome;
        break;
      }
    }
  }
  const score = partialScore(tests, verdicts, subtasks);
  const failed = verdicts.find((verdict) => verdict && verdict !== 'AC');
  return {
    verdict: failed ?? (ran === 0 ? 'RE' : 'AC'),
    reason: failed ? firstFail?.reason ?? null : ran === 0 ? 'no tests' : null,
    ran,
    points: score.points,
    max: score.max,
  };
}

export function classifyRun(input: {
  timedOut: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  expected: string;
  outputLimit: number;
  signal: string | null;
}): CaseResult {
  if (input.stdout.length > input.outputLimit) return { verdict: 'RE', reason: 'output limit' };
  if (input.timedOut) return { verdict: 'TLE', reason: 'time limit' };
  if (
    input.signal === 'SIGKILL'
    || input.exitCode === 137
    || /out of memory|ENOMEM|MemoryError|heap limit/i.test(input.stderr)
  ) {
    return { verdict: 'MLE', reason: 'memory limit' };
  }
  if (input.exitCode !== 0) {
    if (/SyntaxError|IndentationError/i.test(input.stderr) && input.stdout.length === 0) {
      return { verdict: 'CE', reason: input.stderr.slice(0, 500) };
    }
    return { verdict: 'RE', reason: input.stderr.slice(0, 500) || `exit ${input.exitCode}` };
  }
  if (normalize(input.stdout) !== normalize(input.expected)) return { verdict: 'WA', reason: null };
  return { verdict: 'AC', reason: null };
}

function normalize(text: string) {
  return text.replace(/\r\n/g, '\n').trimEnd();
}

export function sameOutput(a: string, b: string) {
  return normalize(a) === normalize(b);
}
