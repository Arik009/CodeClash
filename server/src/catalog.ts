import { seededRng } from '@codeclash/shared';

export interface CatalogTest { input: string; output: string; hidden: boolean; group?: string }

export interface CatalogProblem {
  title: string;
  statement: string;
  samples: string;
  editorial: string;
  tags: string[];
  /** Warmup contest when omitted and `contest` is true. Otherwise practice, which is visible immediately. */
  contest: boolean;
  pool?: 'warmup' | 'archive' | 'practice';
  difficulty?: 'easy' | 'medium' | 'hard';
  inputSpec: string;
  tests: CatalogTest[];
  reference: string;
  wrong: string;
}

export const py = (body: string) => `import sys\n${body}\n`;

const line = (text: string) => (text.endsWith('\n') ? text : `${text}\n`);

/** A visible test. Samples on the problem page are built from these. */
export const shown = (input: string, output: string | number | bigint, group?: string): CatalogTest =>
  ({ input: line(input), output: line(String(output)), hidden: false, ...(group ? { group } : {}) });

export const secret = (input: string, output: string | number | bigint, group?: string): CatalogTest =>
  ({ input: line(input), output: line(String(output)), hidden: true, ...(group ? { group } : {}) });

/** Large tests come from a fixed seed, so every reseed writes identical data. */
export function picker(seed: number) {
  const rng = seededRng(seed);
  return (lo: number, hi: number) => lo + Math.floor(rng.next() * (hi - lo + 1));
}

export function ints(count: number, lo: number, hi: number, seed: number) {
  const pick = picker(seed);
  return Array.from({ length: count }, () => pick(lo, hi));
}

export function letters(count: number, alphabet: string, seed: number) {
  const pick = picker(seed);
  return Array.from({ length: count }, () => alphabet[pick(0, alphabet.length - 1)]).join('');
}

export const array = (values: number[]) => `${values.length}\n${values.join(' ')}`;

export function problem(item: Omit<CatalogProblem, 'samples'>): CatalogProblem {
  const samples = item.tests.filter((test) => !test.hidden)
    .map((test) => `Input\n${test.input.trimEnd()}\nOutput\n${test.output.trimEnd()}`)
    .join('\n');
  return { ...item, samples };
}

const bigList = ints(40_000, -1_000_000_000, 1_000_000_000, 11);
const bigWord = letters(50_000, 'abcdefghijklmnopqrstuvwxyz', 12);
const mixedWord = letters(50_000, 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 13);

export const CATALOG: CatalogProblem[] = [
  problem({
    title: 'Sum of two integers',
    statement: [
      'You are given two integers a and b. Print their sum.',
      'Input\nThe only line contains two integers `a` and `b` (`-10^9 ≤ a, b ≤ 10^9`).',
      'Output\nPrint one integer: `a + b`.',
      'Note\nThe sum can reach `2·10^9` in absolute value, which does not fit in a signed 32-bit integer. Use a 64-bit type in C, C++, Java and Go.',
    ].join('\n\n'),
    editorial: 'Read both values and print their sum. The only trap is overflow: `10^9 + 10^9` is outside the 32-bit range, so accumulate in `long long`, `long` or `int64`.',
    tags: ['math', 'implementation'],
    contest: true,
    inputSpec: 'a int -10^9..10^9, b int -10^9..10^9',
    reference: py('a,b=map(int,sys.stdin.read().split())\nprint(a+b)'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(a-b)'),
    tests: [
      shown('1 2', 3),
      secret('10 20', 30),
      secret('-5 5', 0),
      secret('0 0', 0),
      secret('-1000000000 -1000000000', -2_000_000_000),
      secret('1000000000 1000000000', 2_000_000_000),
    ],
  }),
  problem({
    title: 'Larger of two',
    statement: [
      'You are given two integers a and b. Print the larger of them. If they are equal, print that common value.',
      'Input\nThe only line contains two integers `a` and `b` (`-10^9 ≤ a, b ≤ 10^9`).',
      'Output\nPrint `max(a, b)`.',
    ].join('\n\n'),
    editorial: 'One comparison is enough. Equal values need no special case, because printing either one is correct.',
    tags: ['math', 'implementation'],
    contest: true,
    inputSpec: 'a int -10^9..10^9, b int -10^9..10^9',
    reference: py('a,b=map(int,sys.stdin.read().split())\nprint(a if a>=b else b)'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(a if a<=b else b)'),
    tests: [
      shown('3 1', 3),
      secret('1 3', 3),
      secret('2 2', 2),
      secret('-1 -4', -1),
      secret('-1000000000 1000000000', 1_000_000_000),
    ],
  }),
  problem({
    title: 'Even or odd',
    statement: [
      'Determine whether the integer n is even or odd.',
      'Input\nThe only line contains an integer `n` (`-10^9 ≤ n ≤ 10^9`).',
      'Output\nPrint `even` if n is divisible by 2, and `odd` otherwise.',
      'Note\nZero is even. In C, C++, Java and Go the remainder of a negative odd number divided by 2 is `-1`, not `1`, so compare the remainder with zero.',
    ].join('\n\n'),
    editorial: 'Check `n mod 2 = 0`. Testing `n mod 2 = 1` instead fails for negative odd numbers in languages whose remainder takes the sign of the dividend.',
    tags: ['math'],
    contest: true,
    inputSpec: 'n int -10^9..10^9',
    reference: py('n=int(sys.stdin.read())\nprint("even" if n%2==0 else "odd")'),
    wrong: py('n=int(sys.stdin.read())\nprint("even")'),
    tests: [
      shown('4', 'even'),
      secret('7', 'odd'),
      secret('0', 'even'),
      secret('-3', 'odd'),
      secret('-1000000000', 'even'),
      secret('999999999', 'odd'),
    ],
  }),
  problem({
    title: 'Sum of a list',
    statement: [
      'You are given an array of n integers. Print the sum of its elements.',
      'Input\nThe first line contains an integer `n` (`1 ≤ n ≤ 2·10^5`), the length of the array.\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint one integer: `a_1 + a_2 + … + a_n`.',
      'Note\nThe sum can reach `2·10^14` in absolute value. Use a 64-bit accumulator.',
    ].join('\n\n'),
    editorial: 'Read n, then add the next n values. The length itself is not part of the sum. A 32-bit accumulator overflows on large tests.',
    tags: ['arrays', 'implementation'],
    contest: true,
    inputSpec: 'n int 1..2*10^5\na int[n] -10^9..10^9',
    reference: py('data=list(map(int,sys.stdin.read().split()))\nprint(sum(data[1:1+data[0]]))'),
    wrong: py('data=list(map(int,sys.stdin.read().split()))\nprint(sum(data))'),
    tests: [
      shown('3\n1 2 3', 6),
      secret('1\n5', 5),
      secret('4\n-1 0 1 2', 2),
      secret('3\n-1000000000 -1000000000 -1000000000', -3_000_000_000),
      secret(array(bigList), bigList.reduce((sum, x) => sum + x, 0)),
    ],
  }),
  problem({
    title: 'Reverse the word',
    statement: [
      'You are given a word s consisting of lowercase Latin letters. Print s written backwards.',
      'Input\nThe only line contains the string `s` (`1 ≤ |s| ≤ 5·10^4`).',
      'Output\nPrint the characters of s in reverse order.',
    ].join('\n\n'),
    editorial: 'Walk the string from the last character to the first, or use the language’s reverse routine. A one-letter word and a palindrome are unchanged.',
    tags: ['strings'],
    contest: true,
    inputSpec: 's str[1..5*10^4] a-z',
    reference: py('print(sys.stdin.read().strip()[::-1])'),
    wrong: py('print(sys.stdin.read().strip())'),
    tests: [
      shown('abc', 'cba'),
      secret('a', 'a'),
      secret('ab', 'ba'),
      secret('racecar', 'racecar'),
      secret(bigWord, [...bigWord].reverse().join('')),
    ],
  }),
  problem({
    title: 'Count the vowels',
    statement: [
      'You are given a word s of Latin letters in upper or lower case. Count its vowels. The vowels are `a`, `e`, `i`, `o` and `u` in either case; `y` is not a vowel.',
      'Input\nThe only line contains the string `s` (`1 ≤ |s| ≤ 10^5`), consisting of uppercase and lowercase Latin letters.',
      'Output\nPrint one integer: the number of vowels in s.',
    ].join('\n\n'),
    editorial: 'Lower-case each character and test membership in `aeiou`. Forgetting the upper-case vowels is the usual mistake.',
    tags: ['strings', 'implementation'],
    contest: true,
    inputSpec: 's str[1..10^5] a-zA-Z',
    reference: py('s=sys.stdin.read().strip().lower()\nprint(sum(ch in "aeiou" for ch in s))'),
    wrong: py('s=sys.stdin.read().strip()\nprint(sum(ch in "aeiou" for ch in s))'),
    tests: [
      shown('code', 2),
      secret('xyz', 0),
      secret('AEIOU', 5),
      secret('Yesterday', 3),
      secret(mixedWord, [...mixedWord.toLowerCase()].filter((c) => 'aeiou'.includes(c)).length),
    ],
  }),
  problem({
    title: 'Celsius to Fahrenheit',
    statement: [
      'Convert a temperature from degrees Celsius to degrees Fahrenheit using integer arithmetic.',
      'Input\nThe only line contains an integer `C` (`-273 ≤ C ≤ 10^4`).',
      'Output\nPrint `⌊9·C / 5⌋ + 32`, where `⌊x⌋` is the largest integer not greater than x.',
      'Note\nThe division rounds down, toward negative infinity: for `C = -1` the answer is `⌊-9/5⌋ + 32 = -2 + 32 = 30`. In C, C++, Java and Go integer division rounds toward zero, so negative temperatures need care.',
    ].join('\n\n'),
    editorial: 'Compute `9·C` and divide by 5, rounding down. Python’s `//` already floors. Elsewhere, subtract one from the truncated quotient when `9·C` is negative and not a multiple of 5.',
    tags: ['math'],
    contest: false,
    inputSpec: 'C int -273..10^4',
    reference: py('c=int(sys.stdin.read())\nprint(c*9//5+32)'),
    wrong: py('c=int(sys.stdin.read())\nprint(int(c*9/5)+32)'),
    tests: [
      shown('0', 32),
      secret('100', 212),
      secret('-40', -40),
      secret('-1', 30),
      secret('37', 98),
      secret('-273', -460),
      secret('10000', 18032),
    ],
  }),
  problem({
    title: 'One number of FizzBuzz',
    statement: [
      'For a positive integer n, print `FizzBuzz` if n is divisible by both 3 and 5, `Fizz` if it is divisible by 3 only, `Buzz` if it is divisible by 5 only, and the number n itself otherwise.',
      'Input\nThe only line contains an integer `n` (`1 ≤ n ≤ 10^9`).',
      'Output\nPrint the word described above, or the number n.',
    ].join('\n\n'),
    editorial: 'Test divisibility by 15 first. Checking 3 before 15 reports every multiple of 15 as `Fizz`.',
    tags: ['math', 'implementation'],
    contest: false,
    inputSpec: 'n int 1..10^9',
    reference: py('n=int(sys.stdin.read())\nprint("FizzBuzz" if n%15==0 else "Fizz" if n%3==0 else "Buzz" if n%5==0 else n)'),
    wrong: py('n=int(sys.stdin.read())\nprint("Fizz" if n%3==0 else "Buzz" if n%5==0 else "FizzBuzz" if n%15==0 else n)'),
    tests: [
      shown('3', 'Fizz'),
      secret('5', 'Buzz'),
      secret('15', 'FizzBuzz'),
      secret('1', 1),
      secret('2', 2),
      secret('999999990', 'FizzBuzz'),
      secret('999999999', 'Fizz'),
      secret('1000000000', 'Buzz'),
    ],
  }),
];
