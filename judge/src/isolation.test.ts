import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runInDocker } from './runner.js';

const expected = JSON.parse(
  readFileSync(new URL('../../tests/escape/expected.json', import.meta.url), 'utf8'),
) as { file: string; verdict: string }[];

const docker = spawnSync('docker', ['version'], { encoding: 'utf8' });

describe('isolation suite', () => {
  it('assigns a verdict to every escape program', () => {
    expect(['RE', 'TLE']).toContain(expected.find((row) => row.file === 'forkbomb.py')?.verdict);
    expect(expected.find((row) => row.file === 'spin.py')?.verdict).toBe('TLE');
    expect(expected.length).toBeGreaterThanOrEqual(3);
  });

  it.skipIf(docker.status !== 0)('runs the escape programs inside the sandbox', async () => {
    for (const { file, verdict } of expected) {
      const code = readFileSync(new URL(`../../tests/escape/${file}`, import.meta.url), 'utf8');
      const outcome = await runInDocker({
        language: 'python',
        code,
        stdin: '',
        expected: '',
        timeMs: 1500,
        memoryMb: 64,
        outputLimit: 4096,
      });
      if (file === 'forkbomb.py') expect(['RE', 'TLE'], file).toContain(outcome.verdict);
      else expect(outcome.verdict, file).toBe(verdict);
    }
  }, 120000);

  it.skipIf(docker.status !== 0)('stops the container after a time limit', async () => {
    const outcome = await runInDocker({
      language: 'python', code: 'while True:\n    pass\n', stdin: '', expected: '', timeMs: 1500, memoryMb: 64,
    });
    expect(outcome.verdict).toBe('TLE');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const ps = spawnSync('docker', ['ps', '--filter', 'name=cc-run-', '--format', '{{.Names}}'], { encoding: 'utf8' });
    expect(ps.stdout.trim()).toBe('');
  }, 60000);

  it.skipIf(docker.status !== 0)('reports memory over the limit as MLE', async () => {
    const outcome = await runInDocker({
      language: 'python', code: 'x = bytearray(512 * 1024 * 1024)\nprint(len(x))\n', stdin: '', expected: '', timeMs: 5000, memoryMb: 64,
    });
    expect(outcome.verdict).toBe('MLE');
  }, 60000);

  it.skipIf(docker.status !== 0)('cuts off a program that floods stdout', async () => {
    const started = Date.now();
    const outcome = await runInDocker({
      language: 'python', code: 'while True:\n    print("x" * 1000)\n', stdin: '', expected: '', timeMs: 5000, memoryMb: 64, outputLimit: 4096,
    });
    expect(outcome).toMatchObject({ verdict: 'RE', reason: 'output limit' });
    expect(outcome.stdout.length).toBeLessThan(100_000);
    expect(Date.now() - started).toBeLessThan(5000);
  }, 60000);
});
