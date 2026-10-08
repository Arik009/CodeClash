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
