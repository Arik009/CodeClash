import { draftSpec } from '@codeclash/shared';
import { describe, expect, it } from 'vitest';
import {
  convertDescription, difficultyOf, limitsOf, pickTests, rejectReason, samplesText, solutionsIn, sourceOf, tagsOf, tidyStatement, titleOf,
  type ContestRow,
} from './codecontests.js';

const DESCRIPTION = [
  'You are given an array of $$$n$$$ integers. Print their sum.',
  '',
  'Input',
  '',
  'The first line contains an integer n (1 ≤ n ≤ 100).',
  '',
  'The second line contains n integers a_1, a_2, …, a_n (-1000 ≤ a_i ≤ 1000).',
  '',
  'Output',
  '',
  'Print one integer.',
  '',
  'Examples',
  '',
  'Input',
  '',
  '',
  '3',
  '1 2 3',
  '',
  '',
  'Output',
  '',
  '',
  '6',
  '',
  'Note',
  '',
  'The sum is $$$1+2+3=6$$$.',
].join('\n');

function row(overrides: Partial<ContestRow> = {}): ContestRow {
  return {
    name: '1234_B. Array Sum',
    description: DESCRIPTION,
    public_tests: { input: ['3\n1 2 3\n'], output: ['6\n'] },
    private_tests: { input: ['1\n5\n', '2\n-1 1\n'], output: ['5\n', '0\n'] },
    generated_tests: { input: ['2\n7 7\n', '3\n1 2 3\n', `1\n${'9'.repeat(40_000)}\n`], output: ['14\n', '6\n', 'x\n'] },
    source: 2n,
    solutions: { language: [2, 3, 1, 3], solution: ['cpp one', 'py one', 'py2', 'py two'] },
    incorrect_solutions: { language: [3], solution: ['print(0)'] },
    cf_contest_id: 1234n,
    cf_index: 'B',
    cf_rating: 800n,
    cf_tags: ['implementation', 'brute force', '*special'],
    is_description_translated: false,
    time_limit: { seconds: 1n, nanos: 500_000_000n },
    memory_limit_bytes: 256_000_000n,
    input_file: '',
    output_file: '',
    ...overrides,
  };
}

describe('CodeContests import helpers', () => {
  it('keeps a plain stdin/stdout Codeforces problem', () => {
    expect(rejectReason(row())).toBeNull();
  });

  it.each([
    [{ source: 1n }, 'not Codeforces'],
    [{ input_file: 'input.txt' }, 'reads a file'],
    [{ cf_rating: 3000n }, 'rated above the cut'],
    [{ cf_rating: 0n }, 'no rating'],
    [{ description: `${DESCRIPTION}\n\n<image>` }, 'has an image'],
    [{ description: `${DESCRIPTION}\nThis is an interactive problem.` }, 'interactive'],
    [{ description: `${DESCRIPTION}\nIf there are multiple answers, print any of them.` }, 'accepts several answers'],
    [{ description: `${DESCRIPTION}\nYour answer is accepted if its absolute or relative error does not exceed 10^{-6}.` }, 'needs a float or special checker'],
    [{ description: 'Just a story.' }, 'no Input/Output sections'],
    [{ public_tests: { input: [], output: [] } }, 'no sample'],
  ] as const)('rejects %o', (overrides, reason) => {
    expect(rejectReason(row(overrides as Partial<ContestRow>))).toBe(reason);
  });

  it('drops the examples, keeps the note, and turns $$$ math into inline code', () => {
    const text = convertDescription(DESCRIPTION);
    expect(text).not.toMatch(/Examples/);
    expect(text).not.toContain('$$$');
    expect(text).toContain('array of `n` integers');
    expect(text).toContain('Note\n\nThe sum is `1+2+3=6`.');
    expect(text).toContain('Input\n\nThe first line');
    expect(text).not.toMatch(/\n{3,}/);
  });

  it('keeps link text and unifies list markers', () => {
    const text = tidyStatement('read about [bitwise XOR](https://en.wikipedia.org/wiki/XOR).\n* first\n  * second\n- third');
    expect(text).toBe('read about bitwise XOR.\n• first\n• second\n• third');
    expect(tidyStatement('a * b = c')).toBe('a * b = c');
  });

  it('builds samples from the public tests', () => {
    expect(samplesText(row().public_tests)).toBe('Input\n3\n1 2 3\nOutput\n6');
  });

  it('picks samples first, then private and generated tests, without duplicates or oversized ones', () => {
    const tests = pickTests(row());
    expect(tests.map((t) => [t.input, t.hidden])).toEqual([
      ['3\n1 2 3\n', false], ['1\n5\n', true], ['2\n-1 1\n', true], ['2\n7 7\n', true],
    ]);
    expect(pickTests(row(), { maxTests: 2 })).toHaveLength(2);
  });

  it('reads titles, difficulty, tags, limits and the source line', () => {
    expect(titleOf('1548_D1. Gregor and the Odd Cows (Easy)')).toBe('Gregor and the Odd Cows (Easy)');
    expect([difficultyOf(800), difficultyOf(1500), difficultyOf(2100)]).toEqual(['easy', 'medium', 'hard']);
    expect(tagsOf(['brute force', 'dp', '*special', 'dp'])).toEqual(['brute-force', 'dp']);
    expect(limitsOf(row())).toEqual({ timeMs: 1500, memoryMb: 256 });
    expect(sourceOf(row())).toMatchObject({ contestId: 1234, index: 'B', url: 'https://codeforces.com/problemset/problem/1234/B', license: 'CC BY 4.0' });
  });

  it('tries Python 3 solutions before C++ and skips Python 2', () => {
    expect(solutionsIn(row().solutions, 2).map((s) => s.code)).toEqual(['py one', 'py two', 'cpp one']);
  });

  it('drafts a spec from the statement that every picked test passes', () => {
    const tests = pickTests(row());
    expect(draftSpec(DESCRIPTION, tests.map((t) => t.input))).toBe('n int 1..100\na int[n] -1000..1000');
  });
});
