import vm from 'node:vm';
import type { Batch, CaseRun } from '../engine/pipeline.js';

/**
 * Runs JavaScript in-process so mutants really execute. Python is only understood as
 * `print("literal")`, enough for generators. `cpp` containing BROKEN fails to compile.
 */
export function fakeBatch(calls: { language: string; inputs: number }[] = []): Batch {
  return async (program, inputs) => {
    calls.push({ language: program.language, inputs: inputs.length });
    if (program.code.includes('BROKEN')) return { compileError: 'error: expected ;', cases: [] };
    return {
      compileError: null,
      cases: inputs.map((input): CaseRun => {
        if (program.language === 'python') {
          const match = /^print\((.*)\)\s*$/s.exec(program.code.trim());
          if (!match) return { exitCode: 1, timedOut: false, ms: 1, stdout: '', stderr: 'unsupported' };
          return { exitCode: 0, timedOut: false, ms: 1, stdout: `${JSON.parse(match[1]!)}\n`, stderr: '' };
        }
        const out: string[] = [];
        const started = Date.now();
        try {
          vm.runInNewContext(program.code, {
            require: () => ({ readFileSync: () => input }),
            console: { log: (...parts: unknown[]) => out.push(parts.map(String).join(' ')) },
            Math,
            Number,
          }, { timeout: 200 });
          return { exitCode: 0, timedOut: false, ms: Date.now() - started, stdout: out.length ? `${out.join('\n')}\n` : '', stderr: '' };
        } catch (error) {
          const timedOut = /timed out/i.test(String(error));
          return { exitCode: timedOut ? 137 : 1, timedOut, ms: Date.now() - started, stdout: out.join('\n'), stderr: String(error) };
        }
      }),
    };
  };
}

/** Maximum of an array. The current tests never put the maximum last. */
export const MAX_REFERENCE = [
  "const d = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);",
  'const n = d[0];',
  'let best = d[1];',
  'for (let i = 2; i <= n; i++) if (d[i] > best) best = d[i];',
  'console.log(best);',
].join('\n');

export const MAX_SPEC = 'n int 1..1000\na int[n] -100..100';

export const MAX_TESTS = [
  { input: '3\n1 5 2\n', output: '5\n', hidden: false },
  { input: '1\n7\n', output: '7\n', hidden: true },
];
