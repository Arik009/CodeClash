import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { judgeBatch, parseBatch, runBatch, runInDocker } from './runner.js';
import { programs } from './testdata/sum.js';

const docker = spawnSync('docker', ['version'], { encoding: 'utf8' });

describe('batch framing', () => {
  it('splits framed cases and marks missing ones as not run', () => {
    const raw = '@@ab 0 0 10.00 10.05\n3\n\n@@ab-err\n\n@@ab-end\n@@ab 1 1 10.10 12.10\n\n@@ab-err\nboom\n@@ab-end\n';
    const cases = parseBatch(raw, 'ab', 3, 1000);
    expect(cases[0]).toMatchObject({ exitCode: 0, ms: 50, timedOut: false, stdout: '3\n' });
    expect(cases[1]).toMatchObject({ exitCode: 1, ms: 2000, timedOut: true, stderr: 'boom' });
    expect(cases[2]).toMatchObject({ exitCode: null, timedOut: true, stderr: 'not run' });
  });

  it('ignores a forged marker without the run nonce', () => {
    const raw = '@@ab 0 0 1.00 1.01\n@@zz 1 0 1 1\nreal\n@@ab-err\n\n@@ab-end\n';
    expect(parseBatch(raw, 'ab', 1, 1000)[0]!.stdout).toBe('@@zz 1 0 1 1\nreal');
  });
});

describe.skipIf(docker.status !== 0)('batch runner', () => {
  it('judges several inputs in one container for every language', async () => {
    for (const program of programs) {
      const tests = [{ input: '1 2\n', output: '3\n' }, { input: '-5 5\n', output: '0\n' }, { input: '7 8\n', output: '16\n' }];
      const outcomes = await judgeBatch({ language: program.language, code: program.code, timeMs: program.language === 'java' ? 8000 : 5000, memoryMb: program.language === 'java' ? 512 : 256 }, tests);
      expect(outcomes.map((o) => o.verdict), program.language).toEqual(['AC', 'AC', 'WA']);
    }
  }, 300000);

  it('times out one input without losing the others, and caps output', async () => {
    const code = 'import sys\nn = int(sys.stdin.read())\nif n == 1:\n    while True: pass\nif n == 2:\n    while True: print("x" * 1000)\nprint(n)\n';
    const batch = await runBatch({ language: 'python', code, inputs: ['0\n', '1\n', '2\n', '3\n'], timeMs: 1000, memoryMb: 64, outputLimit: 4096 });
    expect(batch.cases[0]).toMatchObject({ stdout: '0\n', timedOut: false });
    expect(batch.cases[1]!.timedOut).toBe(true);
    expect(batch.cases[2]!.stdout.length).toBe(4097);
    expect(batch.cases[3]).toMatchObject({ stdout: '3\n', timedOut: false });
    const judged = await judgeBatch({ language: 'python', code, timeMs: 1000, memoryMb: 64, outputLimit: 4096 }, [
      { input: '0\n', output: '0\n' }, { input: '1\n', output: '1\n' }, { input: '2\n', output: '2\n' },
    ]);
    expect(judged.map((o) => o.verdict)).toEqual(['AC', 'TLE', 'RE']);
  }, 120000);

  it('reports a compile error for every case', async () => {
    const outcomes = await judgeBatch({ language: 'cpp', code: 'int main( {', timeMs: 1000, memoryMb: 128 }, [{ input: '', output: '' }, { input: '', output: '' }]);
    expect(outcomes.map((o) => o.verdict)).toEqual(['CE', 'CE']);
  }, 120000);

  it('agrees with one container per test', async () => {
    const code = 'a, b = map(int, input().split())\nprint(a * b if a > 2 else a + b)\n';
    const tests = [{ input: '1 2\n', output: '3\n' }, { input: '3 4\n', output: '7\n' }, { input: '0 0\n', output: '0\n' }];
    const batched = await judgeBatch({ language: 'python', code, timeMs: 2000, memoryMb: 128 }, tests);
    const single = [];
    for (const test of tests) single.push(await runInDocker({ language: 'python', code, stdin: test.input, expected: test.output, timeMs: 2000, memoryMb: 128 }));
    expect(batched.map((o) => o.verdict)).toEqual(single.map((o) => o.verdict));
  }, 120000);
});
