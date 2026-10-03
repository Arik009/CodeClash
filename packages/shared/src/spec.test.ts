import { describe, expect, it } from 'vitest';
import {
  boundaryInputs, draftSpec, evalExpr, inputClasses, inputSize, maxScaleInput, parseExpr, parseSpec, randomInput, readConstraints,
  seededRng, SpecError, validateInput,
} from './spec.js';

const ARRAY = 'n int 1..2*10^5\na int[n] -10^9..10^9';
const MULTI = 't int 1..10^4\nrepeat t:\n  n int 1..10, k int 0..n\n  s str[n] ab\nsum n <= 25';
const GRAPH = 'n int 2..50, m int 1..100\nlines m: u int 1..n, v int 1..n';

describe('spec expressions', () => {
  it('evaluates powers, products, signs, and names', () => {
    const env = new Map([['n', 7n]]);
    expect(evalExpr(parseExpr('2*10^5'), env)).toBe(200000n);
    expect(evalExpr(parseExpr('-10^18'), env)).toBe(-(10n ** 18n));
    expect(evalExpr(parseExpr('1e9'), env)).toBe(1_000_000_000n);
    expect(evalExpr(parseExpr('n-1'), env)).toBe(6n);
    expect(evalExpr(parseExpr('2*n+1'), env)).toBe(15n);
    expect(() => evalExpr(parseExpr('m'), env)).toThrow(SpecError);
    expect(() => parseExpr('2**')).toThrow(SpecError);
    expect(() => parseExpr('1..2')).toThrow(SpecError);
  });
});

describe('parseSpec', () => {
  it('reads lines, arrays, strings, repeat blocks, and sums', () => {
    const spec = parseSpec(MULTI);
    expect(spec.nodes[1]).toMatchObject({ type: 'repeat' });
    expect(spec.sums).toHaveLength(1);
    expect(parseSpec(GRAPH).nodes[1]).toMatchObject({ type: 'lines' });
  });

  it('names the line that is wrong', () => {
    expect(() => parseSpec('n int 1..5\nx float 1..2')).toThrow(/line 2/);
    expect(() => parseSpec('s str a-z')).toThrow(/needs a length/);
    expect(() => parseSpec('repeat t:\nn int 1..2')).toThrow(/indented block/);
    expect(() => parseSpec('# only a comment')).toThrow(/empty/);
  });
});

describe('validateInput', () => {
  const array = parseSpec(ARRAY);
  it('accepts a valid input and rejects each kind of mistake', () => {
    expect(validateInput(array, '3\n1 -2 3\n')).toEqual({ ok: true });
    expect(validateInput(array, '3\n1 2\n')).toMatchObject({ ok: false, error: expect.stringContaining('expected a') });
    expect(validateInput(array, '3\n1 2 3 4\n')).toMatchObject({ ok: false, error: expect.stringContaining('unexpected "4"') });
    expect(validateInput(array, '0\n\n')).toMatchObject({ ok: false, error: expect.stringContaining('outside 1..200000') });
    expect(validateInput(array, '1\n2000000000\n')).toMatchObject({ ok: false });
    expect(validateInput(array, '1\nx\n')).toMatchObject({ ok: false, error: expect.stringContaining('integer') });
    expect(validateInput(array, '1\n5\n9\n')).toMatchObject({ ok: false, error: expect.stringContaining('extra input') });
    expect(validateInput(array, '')).toMatchObject({ ok: false });
  });

  it('checks string alphabets, dependent bounds, and sums', () => {
    const multi = parseSpec(MULTI);
    expect(validateInput(multi, '2\n3 1\naba\n2 2\nbb\n')).toEqual({ ok: true });
    expect(validateInput(multi, '1\n3 1\nabc\n')).toMatchObject({ ok: false, error: expect.stringContaining('contains "c"') });
    expect(validateInput(multi, '1\n2 3\nab\n')).toMatchObject({ ok: false, error: expect.stringContaining('outside 0..2') });
    expect(validateInput(multi, '1\n3 0\nab\n')).toMatchObject({ ok: false, error: expect.stringContaining('length 2') });
    const many = `3\n${'10 0\naaaaaaaaaa\n'.repeat(3)}`;
    expect(validateInput(multi, many)).toMatchObject({ ok: false, error: expect.stringContaining('sum of n is 30') });
  });
});

describe('generators', () => {
  it('produces random inputs that always validate', () => {
    const rng = seededRng(7);
    for (const text of [ARRAY, MULTI, GRAPH]) {
      const spec = parseSpec(text);
      for (let i = 0; i < 20; i += 1) {
        const input = randomInput(spec, rng);
        expect(input).not.toBeNull();
        expect(validateInput(spec, input!)).toEqual({ ok: true });
      }
    }
  });

  it('is repeatable for the same seed', () => {
    const spec = parseSpec(ARRAY);
    expect(randomInput(spec, seededRng(3))).toBe(randomInput(spec, seededRng(3)));
  });

  it('builds the largest input that fits and stays valid', () => {
    const spec = parseSpec(ARRAY);
    const big = maxScaleInput(spec, seededRng(1))!;
    expect(validateInput(spec, big)).toEqual({ ok: true });
    expect(inputSize(big)).toBeGreaterThan(50_000);
    expect(big.length).toBeLessThanOrEqual(1_000_000);
    const multi = maxScaleInput(parseSpec(MULTI), seededRng(1))!;
    expect(validateInput(parseSpec(MULTI), multi)).toEqual({ ok: true });
  });

  it('only emits boundary classes the spec allows', () => {
    const kinds = (text: string) => boundaryInputs(parseSpec(text), seededRng(5)).map((b) => b.kind);
    expect(kinds(ARRAY)).toEqual(expect.arrayContaining(['min', 'all-equal', 'sorted', 'reverse', 'negatives']));
    const positive = kinds('n int 1..5\na int[n] 1..9');
    expect(positive).not.toContain('zeros');
    for (const { input } of boundaryInputs(parseSpec(GRAPH), seededRng(5))) {
      expect(validateInput(parseSpec(GRAPH), input)).toEqual({ ok: true });
    }
    const equal = boundaryInputs(parseSpec(ARRAY), seededRng(2)).find((b) => b.kind === 'all-equal')!;
    expect(new Set(equal.input.split('\n')[1]!.split(' ')).size).toBe(1);
  });
});

describe('inputClasses', () => {
  it('reads the boundary classes an existing test covers', () => {
    const spec = parseSpec(ARRAY);
    expect([...inputClasses(spec, '1\n-1000000000\n')].sort()).toEqual(['min', 'negatives', 'single']);
    expect([...inputClasses(spec, '3\n1 2 3\n')]).toEqual(['sorted']);
    expect([...inputClasses(spec, '3\n3 0 1000000000\n')].sort()).toEqual(['max-values', 'zeros']);
    expect([...inputClasses(spec, '4\n9 9 9 9\n')]).toEqual(['all-equal']);
    expect([...inputClasses(spec, '3\n5 3 1\n')]).toEqual(['reverse']);
    expect(inputClasses(spec, 'oops').size).toBe(0);
  });

  it('agrees with the boundary generator on what it produced', () => {
    const spec = parseSpec(ARRAY);
    for (const { kind, input } of boundaryInputs(spec, seededRng(9))) {
      expect(inputClasses(spec, input)).toContain(kind);
    }
  });
});

describe('draftSpec', () => {
  it('reads constraints written in plain text and in Codeforces math', () => {
    const plain = readConstraints('Constraints: 1 ≤ n ≤ 2·10^5, and -10^9 ≤ a_i ≤ 10^9.');
    expect(plain.get('n')).toEqual({ lo: '1', hi: '2*10^5', indexed: false });
    expect(plain.get('a')).toMatchObject({ indexed: true });
    const cf = readConstraints('The first line contains $$$n$$$ ($$$1 \\le n \\le 10^{5}$$$) and $$$1 \\le |s| \\le 100$$$.');
    expect(cf.get('n')).toMatchObject({ hi: '10^5' });
    expect(cf.get('|s|')).toMatchObject({ lo: '1', hi: '100' });
  });

  it('drafts an array problem and checks it against the tests', () => {
    const statement = 'Input: n (1 ≤ n ≤ 100000), then n integers a_i (1 ≤ a_i ≤ 10^9).';
    expect(draftSpec(statement, ['3\n1 2 3\n', '1\n7\n'])).toBe('n int 1..100000\na int[n] 1..10^9');
    expect(draftSpec(statement, ['3\n1 2 3\n', '2\n0 5\n'])).toBeNull();
  });

  it('drafts a multi-test problem with a sum limit', () => {
    const statement = 'The first line contains t (1 ≤ t ≤ 10^4), the number of test cases. Each test case has n (1 ≤ n ≤ 2·10^5) and then a_1..a_n (1 ≤ a_i ≤ n). The sum of n over all test cases does not exceed 2·10^5.';
    const draft = draftSpec(statement, ['2\n3\n1 2 3\n1\n1\n']);
    expect(draft).toBe('t int 1..10^4\nrepeat t:\n  n int 1..2*10^5\n  a int[n] 1..n\nsum n <= 2*10^5');
  });

  it('drafts edge lists and strings, and gives up when the shape is unknown', () => {
    const graph = 'n and m (2 ≤ n ≤ 1000, 1 ≤ m ≤ 5000), then m edges.';
    expect(draftSpec(graph, ['3 2\n1 2\n2 3\n'])).toBe('n int 2..1000, m int 1..5000\nlines m: u int 1..n, v int 1..n');
    expect(draftSpec('A string s with 1 ≤ |s| ≤ 50.', ['abc\n', 'zz\n'])).toBe('s str[1..50] a-z');
    expect(draftSpec('No constraints here.', ['1 2\n'])).toBeNull();
    expect(draftSpec('Anything', [])).toBeNull();
  });

  it('reads chained bounds and names query fields from the statement', () => {
    const statement = 'The first line contains q (1 ≤ q ≤ 500). Then q lines follow, each with l_i r_i d_i (1 ≤ l_i ≤ r_i ≤ 10^9, 1 ≤ d_i ≤ 10^9).';
    const bounds = readConstraints(statement);
    expect(bounds.get('l')).toEqual({ lo: '1', hi: '10^9', indexed: true });
    expect(bounds.get('r')).toEqual({ lo: 'l', hi: '10^9', indexed: true });
    expect(draftSpec(statement, ['2\n2 4 2\n5 10 4\n'])).toBe('q int 1..500\nlines q: l int 1..10^9, r int l..10^9, d int 1..10^9');
    expect(draftSpec(statement, ['1\n4 2 2\n'])).toBeNull();
  });

  it('reads a line of n digits as a string, not a number', () => {
    const statement = 'The first line contains n (1 ≤ n ≤ 100). The second line contains a string of n digits.';
    expect(draftSpec(statement, ['5\n00812\n', '3\n999\n'])).toBe('n int 1..100\ns str[n..n] 0-9');
  });
});
