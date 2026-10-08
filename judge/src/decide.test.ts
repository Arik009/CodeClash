import { describe, expect, it } from 'vitest';
import { classifyRun, decide, judgeCases } from './decide.js';
import { canTakePractice, nextStream } from './slots.js';
import { dockerArgs } from './runner.js';

describe('verdicts', () => {
  it('stops at the first failure', () => {
    expect(decide([
      { verdict: 'AC', reason: null },
      { verdict: 'WA', reason: null },
      { verdict: 'AC', reason: null },
    ]).verdict).toBe('WA');
  });

  it('accepts matching output and treats overflow as RE', () => {
    expect(classifyRun({
      timedOut: false, exitCode: 0, stdout: '3\n', stderr: '', expected: '3', outputLimit: 100, signal: null,
    }).verdict).toBe('AC');
    expect(classifyRun({
      timedOut: false, exitCode: 0, stdout: 'x'.repeat(20), stderr: '', expected: 'x', outputLimit: 10, signal: null,
    })).toMatchObject({ verdict: 'RE', reason: 'output limit' });
    expect(classifyRun({
      timedOut: true, exitCode: null, stdout: '', stderr: '', expected: '1', outputLimit: 10, signal: 'SIGKILL',
    }).verdict).toBe('TLE');
    expect(classifyRun({
      timedOut: true, exitCode: null, stdout: 'x'.repeat(20), stderr: '', expected: '', outputLimit: 10, signal: 'SIGKILL',
    })).toMatchObject({ verdict: 'RE', reason: 'output limit' });
    expect(classifyRun({
      timedOut: false, exitCode: 1, stdout: '', stderr: 'FileNotFoundError: missing', expected: '', outputLimit: 10, signal: null,
    }).verdict).toBe('RE');
    expect(classifyRun({
      timedOut: false, exitCode: 1, stdout: '', stderr: 'SyntaxError: bad', expected: '', outputLimit: 10, signal: null,
    }).verdict).toBe('CE');
  });

  it('treats an OOM kill as MLE', () => {
    expect(classifyRun({
      timedOut: false, exitCode: 137, stdout: '', stderr: '', expected: '', outputLimit: 10, signal: null,
    }).verdict).toBe('MLE');
    expect(classifyRun({
      timedOut: false, exitCode: 1, stdout: '', stderr: 'MemoryError', expected: '', outputLimit: 10, signal: null,
    }).verdict).toBe('MLE');
  });
});

describe('early exit', () => {
  it('does not start cases after the first failure', async () => {
    let calls = 0;
    const result = await judgeCases([0, 1, 2, 3], async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 15));
      return { verdict: 'WA', reason: null };
    });
    expect(calls).toBe(1);
    expect(result.ran).toBe(1);
    expect(result.verdict).toBe('WA');
  });

  it('is faster to stop than to run every case', async () => {
    const tests = [0, 1, 2, 3, 4, 5, 6, 7];
    const run = async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { verdict: 'WA' as const, reason: null };
    };
    const earlyStarted = performance.now();
    const early = await judgeCases(tests, run);
    const earlyMs = performance.now() - earlyStarted;
    const fullStarted = performance.now();
    for (const test of tests) await run(test);
    const fullMs = performance.now() - fullStarted;
    expect(early.ran).toBe(1);
    expect(earlyMs).toBeLessThan(fullMs);
  });
});

describe('slots', () => {
  it('keeps at least 80% of slots for a live contest', () => {
    expect(canTakePractice(24, true, 4)).toBe(false);
    expect(canTakePractice(24, true, 3)).toBe(true);
    expect(canTakePractice(4, true, 0)).toBe(false);
    expect(nextStream(true, true)).toBe('judge:contest');
    expect(nextStream(false, false)).toBeNull();
  });

  it('lets practice borrow one idle slot when no contest work is queued', () => {
    expect(canTakePractice(4, true, 0, 0)).toBe(true);
    expect(canTakePractice(4, true, 1, 0)).toBe(false);
    expect(canTakePractice(4, true, 0, 3)).toBe(false);
    expect(canTakePractice(24, true, 4, 0)).toBe(false);
  });
});

describe('docker args', () => {
  it('drops network, capabilities and a shared user', () => {
    const args = dockerArgs({
      language: 'python', code: 'print(1)', stdin: '', expected: '1', timeMs: 1000, memoryMb: 256,
    }, 'C:\\work\\run');
    expect(args).toContain('--network');
    expect(args).toContain('none');
    expect(args).toContain('--read-only');
    expect(args).toContain('--cap-drop');
    expect(args).toContain('ALL');
    expect(args).toContain('65534:65534');
    expect(args[args.indexOf('--name') + 1]).toMatch(/^cc-run-/);
    expect(args.slice(args.indexOf('python:3.12-alpine') + 1, -2)).toEqual(['timeout', '-s', 'KILL', '3']);
  });
});
