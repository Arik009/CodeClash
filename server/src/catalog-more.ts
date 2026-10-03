import { array, ints, letters, picker, problem, py, secret, shown, type CatalogProblem } from './catalog.js';

function fibonacci(n: number) {
  let a = 0n;
  let b = 1n;
  for (let i = 0; i < n; i += 1) [a, b] = [b, a + b];
  return a;
}

function longestRun(s: string) {
  let best = 1;
  let run = 1;
  for (let i = 1; i < s.length; i += 1) {
    run = s[i] === s[i - 1] ? run + 1 : 1;
    if (run > best) best = run;
  }
  return best;
}

function maxSubarray(values: number[]) {
  let best = values[0]!;
  let current = values[0]!;
  for (const x of values.slice(1)) {
    current = Math.max(x, current + x);
    best = Math.max(best, current);
  }
  return best;
}

function hasPair(values: number[], target: number) {
  const seen = new Set<number>();
  for (const x of values) {
    if (seen.has(target - x)) return true;
    seen.add(x);
  }
  return false;
}

function knapsack(capacity: number, items: [number, number][]) {
  const best = new Array<number>(capacity + 1).fill(0);
  for (const [w, v] of items) for (let c = capacity; c >= w; c -= 1) best[c] = Math.max(best[c]!, best[c - w]! + v);
  return best[capacity]!;
}

function distance(n: number, edges: [number, number][]) {
  const graph = Array.from({ length: n + 1 }, () => [] as number[]);
  for (const [u, v] of edges) { graph[u]!.push(v); graph[v]!.push(u); }
  const dist = new Array<number>(n + 1).fill(-1);
  dist[1] = 0;
  const queue = [1];
  for (let head = 0; head < queue.length; head += 1) {
    const u = queue[head]!;
    for (const v of graph[u]!) if (dist[v]! < 0) { dist[v] = dist[u]! + 1; queue.push(v); }
  }
  return dist[n]!;
}

const minList = ints(40_000, -1_000_000_000, 1_000_000_000, 21);
const fewValues = ints(40_000, 1, 1000, 22);
const subarrayList = ints(40_000, -1_000_000_000, 1_000_000_000, 23);
const palindromeHalf = letters(25_000, 'abc', 24);
const palindrome = palindromeHalf + [...palindromeHalf].reverse().join('');
const nearPalindrome = `${palindrome.slice(0, 30_000)}${palindrome[30_000] === 'a' ? 'b' : 'a'}${palindrome.slice(30_001)}`;
const runs = letters(100_000, 'ab', 25);
const evens = ints(40_000, -500_000_000, 500_000_000, 26).map((x) => x * 2);
const pairList = ints(1000, -1_000_000_000, 1_000_000_000, 27);
const pairTarget = pairList[137]! + pairList[862]!;

const rangeValues = ints(40_000, -1_000_000_000, 1_000_000_000, 28);
const rangeQueries = (() => {
  const pick = picker(29);
  return Array.from({ length: 3000 }, () => {
    const l = pick(1, rangeValues.length);
    return [l, pick(l, rangeValues.length)] as const;
  });
})();
const rangePrefix = rangeValues.reduce((p, x) => { p.push(p.at(-1)! + x); return p; }, [0]);

const rotateValues = ints(5000, -1_000_000_000, 1_000_000_000, 30);
const rotate = (values: number[], k: number) => { const s = k % values.length; return [...values.slice(s), ...values.slice(0, s)]; };

const knapsackItems = (() => {
  const pick = picker(31);
  return Array.from({ length: 100 }, () => [pick(1, 3000), pick(1, 1_000_000_000)] as [number, number]);
})();

const chainEdges = (() => {
  const n = 20_000;
  const pick = picker(32);
  const edges: [number, number][] = [];
  for (let v = 1; v < n; v += 1) edges.push(pick(0, 1) ? [v, v + 1] : [v + 1, v]);
  for (let i = 0; i < 20_001; i += 1) {
    const u = pick(2, n - 1);
    edges.push([u, Math.min(n - 1, u + pick(1, 3))]);
  }
  edges.push([1, 5000], [15_000, n]);
  for (let i = edges.length - 1; i > 0; i -= 1) {
    const j = pick(0, i);
    [edges[i], edges[j]] = [edges[j]!, edges[i]!];
  }
  return edges;
})();

/** Original problems. Statements are written for this project; they are not copied from another site. */
export const MORE: CatalogProblem[] = [
  problem({
    title: 'Digit sum',
    statement: [
      'Print the sum of the decimal digits of a non-negative integer n.',
      'Input\nThe only line contains an integer `n` (`0 ≤ n ≤ 10^18`).',
      'Output\nPrint one integer: the sum of the digits of n.',
      'Note\nn can exceed the 32-bit range. Read it as a 64-bit integer or as a string.',
    ].join('\n\n'),
    editorial: 'Take the last digit with `n mod 10` and drop it with integer division by 10 until n is zero, or sum the characters of the string. Zero has digit sum zero.',
    tags: ['math', 'implementation'],
    contest: false,
    pool: 'practice',
    difficulty: 'easy',
    inputSpec: 'n int 0..10^18',
    reference: py('n=int(sys.stdin.read())\nprint(sum(int(ch) for ch in str(n)))'),
    wrong: py('n=int(sys.stdin.read())\nprint(n%9)'),
    tests: [
      shown('205', 7),
      secret('0', 0),
      secret('9', 9),
      secret('999', 27),
      secret('1000000000000000000', 1),
      secret('999999999999999999', 162),
    ],
  }),
  problem({
    title: 'Absolute difference',
    statement: [
      'You are given two integers a and b. Print the distance between them on the number line, `|a − b|`.',
      'Input\nThe only line contains two integers `a` and `b` (`-10^9 ≤ a, b ≤ 10^9`).',
      'Output\nPrint one integer: `|a − b|`.',
      'Note\nThe answer can reach `2·10^9`, which does not fit in a signed 32-bit integer.',
    ].join('\n\n'),
    editorial: 'Subtract and drop the sign. Equal numbers give zero. Compute in 64 bits, because `10^9 − (−10^9)` overflows a 32-bit integer.',
    tags: ['math'],
    contest: false,
    pool: 'practice',
    difficulty: 'easy',
    inputSpec: 'a int -10^9..10^9, b int -10^9..10^9',
    reference: py('a,b=map(int,sys.stdin.read().split())\nprint(abs(a-b))'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(a-b)'),
    tests: [
      shown('3 8', 5),
      secret('8 3', 5),
      secret('5 5', 0),
      secret('-2 2', 4),
      secret('-1000000000 1000000000', 2_000_000_000),
    ],
  }),
  problem({
    title: 'Palindrome word',
    statement: [
      'A palindrome reads the same from left to right and from right to left. Determine whether the word s is a palindrome.',
      'Input\nThe only line contains the string `s` (`1 ≤ |s| ≤ 10^5`) of lowercase Latin letters.',
      'Output\nPrint `yes` if s is a palindrome, and `no` otherwise.',
    ].join('\n\n'),
    editorial: 'Compare `s[i]` with `s[|s| − 1 − i]` for every i in the first half, or compare the string with its reverse. Checking only the end characters is not enough.',
    tags: ['strings'],
    contest: false,
    pool: 'archive',
    difficulty: 'easy',
    inputSpec: 's str[1..10^5] a-z',
    reference: py('s=sys.stdin.read().strip()\nprint("yes" if s==s[::-1] else "no")'),
    wrong: py('s=sys.stdin.read().strip()\nprint("yes" if s[0]==s[-1] else "no")'),
    tests: [
      shown('level', 'yes'),
      secret('ab', 'no'),
      secret('a', 'yes'),
      secret('abba', 'yes'),
      secret('abca', 'no'),
      secret(palindrome, 'yes'),
      secret(nearPalindrome, 'no'),
    ],
  }),
  problem({
    title: 'Minimum of a list',
    statement: [
      'You are given an array of n integers. Print its smallest element.',
      'Input\nThe first line contains an integer `n` (`1 ≤ n ≤ 2·10^5`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint `min(a_1, …, a_n)`.',
    ].join('\n\n'),
    editorial: 'Keep the smallest value seen while scanning. Start from the first element, not from zero or from n, which is not part of the array.',
    tags: ['arrays', 'implementation'],
    contest: false,
    pool: 'archive',
    difficulty: 'easy',
    inputSpec: 'n int 1..2*10^5\na int[n] -10^9..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\nprint(min(d[1:1+d[0]]))'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\nprint(min(d))'),
    tests: [
      shown('3\n4 1 9', 1),
      secret('1\n-7', -7),
      secret('4\n5 5 5 5', 5),
      secret('4\n9 8 7 -1000000000', -1_000_000_000),
      secret(array(minList), Math.min(...minList)),
    ],
  }),
  problem({
    title: 'Greatest common divisor',
    statement: [
      'Find the greatest common divisor of two positive integers a and b: the largest integer that divides both of them.',
      'Input\nThe only line contains two integers `a` and `b` (`1 ≤ a, b ≤ 10^18`).',
      'Output\nPrint `gcd(a, b)`.',
    ].join('\n\n'),
    editorial: 'Euclid’s algorithm: `gcd(a, b) = gcd(b, a mod b)` and `gcd(a, 0) = a`. It needs `O(log min(a, b))` steps, so 64-bit inputs are no problem. Trying every divisor is far too slow at `10^18`.',
    tags: ['math', 'number-theory'],
    contest: false,
    pool: 'practice',
    difficulty: 'easy',
    inputSpec: 'a int 1..10^18, b int 1..10^18',
    reference: py('import math\na,b=map(int,sys.stdin.read().split())\nprint(math.gcd(a,b))'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(min(a,b))'),
    tests: [
      shown('12 18', 6),
      secret('7 1', 1),
      secret('13 13', 13),
      secret('600851475143 6857', 6857),
      secret('576460752303423488 1099511627776', 1_099_511_627_776),
      secret('1000000000000000000 999999999999999999', 1),
    ],
  }),
  problem({
    title: 'Prime check',
    statement: [
      'Determine whether the integer n is prime. A prime has exactly two positive divisors: 1 and itself.',
      'Input\nThe only line contains an integer `n` (`2 ≤ n ≤ 10^9`).',
      'Output\nPrint `yes` if n is prime, and `no` otherwise.',
    ].join('\n\n'),
    editorial: 'A composite n has a divisor d with `2 ≤ d ≤ √n`, so trial division up to `⌊√n⌋` (inclusive) decides it in about 31623 steps. Stopping one short misses perfect squares of primes such as 9.',
    tags: ['math', 'number-theory'],
    contest: false,
    pool: 'practice',
    difficulty: 'easy',
    inputSpec: 'n int 2..10^9',
    reference: py('import math\nn=int(sys.stdin.read())\nok=all(n%d for d in range(2,math.isqrt(n)+1))\nprint("yes" if ok else "no")'),
    wrong: py('import math\nn=int(sys.stdin.read())\nok=all(n%d for d in range(2,math.isqrt(n)))\nprint("yes" if ok else "no")'),
    tests: [
      shown('7', 'yes'),
      secret('2', 'yes'),
      secret('4', 'no'),
      secret('9', 'no'),
      secret('961', 'no'),
      secret('998244353', 'yes'),
      secret('999999937', 'yes'),
      secret('1000000000', 'no'),
    ],
  }),
  problem({
    title: 'Fibonacci number',
    statement: [
      'The Fibonacci numbers are defined by `F(0) = 0`, `F(1) = 1` and `F(k) = F(k − 1) + F(k − 2)` for `k ≥ 2`. Given n, print `F(n)`.',
      'Input\nThe only line contains an integer `n` (`0 ≤ n ≤ 90`).',
      'Output\nPrint `F(n)`.',
      'Note\n`F(90) = 2880067194370816120`, which fits in a signed 64-bit integer.',
    ].join('\n\n'),
    editorial: 'Keep the last two values and step forward n times. Plain recursion takes exponential time, and the values need 64 bits.',
    tags: ['dp', 'math'],
    contest: false,
    pool: 'archive',
    difficulty: 'easy',
    inputSpec: 'n int 0..90',
    reference: py('n=int(sys.stdin.read())\na,b=0,1\nfor _ in range(n):\n a,b=b,a+b\nprint(a)'),
    wrong: py('n=int(sys.stdin.read())\na,b=1,1\nfor _ in range(n):\n a,b=b,a+b\nprint(a)'),
    tests: [
      shown('6', 8),
      secret('0', 0),
      secret('1', 1),
      secret('2', 1),
      secret('10', 55),
      secret('50', fibonacci(50)),
      secret('90', fibonacci(90)),
    ],
  }),
  problem({
    title: 'Count distinct',
    statement: [
      'You are given an array of n integers. Print how many different values it contains.',
      'Input\nThe first line contains an integer `n` (`1 ≤ n ≤ 2·10^5`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint the number of distinct values among `a_1, …, a_n`.',
    ].join('\n\n'),
    editorial: 'Insert every value into a hash set and print its size, or sort and count the positions where the value changes. Counting changes without sorting is wrong when equal values are not adjacent.',
    tags: ['arrays', 'hashing', 'sorting'],
    contest: false,
    pool: 'practice',
    difficulty: 'easy',
    inputSpec: 'n int 1..2*10^5\na int[n] -10^9..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\nprint(len(set(d[1:1+d[0]])))'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\na=d[1:1+d[0]]\nprint(1+sum(a[i]!=a[i-1] for i in range(1,len(a))))'),
    tests: [
      shown('5\n1 2 1 2 3', 3),
      secret('1\n4', 1),
      secret('3\n8 8 8', 1),
      secret('5\n-1 1 -1 1 0', 3),
      secret(array(fewValues), new Set(fewValues).size),
    ],
  }),
  problem({
    title: 'Longest run',
    statement: [
      'A run is a maximal block of equal consecutive characters. Given a string s of lowercase Latin letters, print the length of its longest run.',
      'Input\nThe only line contains the string `s` (`1 ≤ |s| ≤ 2·10^5`).',
      'Output\nPrint one integer: the length of the longest run in s.',
    ].join('\n\n'),
    editorial: 'Scan once, extending the current run while the character repeats and resetting it to 1 otherwise; remember the maximum. The most frequent character is not the answer, because its occurrences need not be consecutive.',
    tags: ['strings', 'implementation'],
    contest: false,
    pool: 'archive',
    difficulty: 'easy',
    inputSpec: 's str[1..2*10^5] a-z',
    reference: py('s=sys.stdin.read().strip()\nbest=run=1\nfor i in range(1,len(s)):\n run=run+1 if s[i]==s[i-1] else 1\n best=max(best,run)\nprint(best)'),
    wrong: py('s=sys.stdin.read().strip()\nprint(max(s.count(c) for c in set(s)))'),
    tests: [
      shown('aabccc', 3),
      secret('a', 1),
      secret('abc', 1),
      secret('zzzz', 4),
      secret('abbbbcbb', 4),
      secret(runs, longestRun(runs)),
    ],
  }),
  problem({
    title: 'Balanced brackets',
    statement: [
      'A bracket sequence is balanced if its brackets can be paired so that every `(` is matched with a later `)` and the pairs are properly nested. For example, `(())()` is balanced, while `)(` and `(()` are not. Decide whether the sequence s is balanced.',
      'Input\nThe only line contains the string `s` (`1 ≤ |s| ≤ 10^5`), consisting of the characters `(` and `)`.',
      'Output\nPrint `yes` if s is balanced, and `no` otherwise.',
    ].join('\n\n'),
    editorial: 'Keep a depth counter: add one for `(` and subtract one for `)`. The sequence is balanced exactly when the depth never drops below zero and ends at zero. Equal counts alone are not enough, as `)(` shows.',
    tags: ['strings', 'stacks'],
    contest: false,
    pool: 'practice',
    difficulty: 'medium',
    inputSpec: 's str[1..10^5] ()',
    reference: py('s=sys.stdin.read().strip()\nd=0\nok=True\nfor ch in s:\n d+=1 if ch=="(" else -1\n if d<0: ok=False\nprint("yes" if ok and d==0 else "no")'),
    wrong: py('s=sys.stdin.read().strip()\nprint("yes" if s.count("(")==s.count(")") else "no")'),
    tests: [
      shown('(())', 'yes'),
      secret('()', 'yes'),
      secret('(', 'no'),
      secret(')(', 'no'),
      secret('())(', 'no'),
      secret('(()', 'no'),
      secret(`${'('.repeat(25_000)}${')'.repeat(25_000)}`, 'yes'),
      secret(`)${'()'.repeat(24_999)}(`, 'no'),
    ],
  }),
  problem({
    title: 'Pair with a given sum',
    statement: [
      'You are given an array of n integers and an integer t. Determine whether there are two different positions `i ≠ j` such that `a_i + a_j = t`.',
      'Input\nThe first line contains two integers `n` and `t` (`2 ≤ n ≤ 2·10^5`, `-2·10^9 ≤ t ≤ 2·10^9`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint `yes` if such a pair exists, and `no` otherwise.',
      'Note\nThe positions must differ, but the values may be equal: for `a = [3, 3]` and `t = 6` the answer is `yes`, while for `a = [3, 5]` and `t = 6` it is `no`.',
    ].join('\n\n'),
    editorial: 'Scan once with a hash set of the values seen so far. Before inserting `a_i`, check whether `t − a_i` is already in the set; checking after inserting would pair an element with itself. Sorting and two pointers also works in `O(n log n)`.',
    tags: ['hashing', 'two-pointers'],
    contest: false,
    pool: 'archive',
    difficulty: 'medium',
    inputSpec: 'n int 2..2*10^5, t int -2*10^9..2*10^9\na int[n] -10^9..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\nn,t=d[0],d[1]\nseen=set()\nok=False\nfor x in d[2:2+n]:\n if t-x in seen:\n  ok=True\n  break\n seen.add(x)\nprint("yes" if ok else "no")'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\nn,t=d[0],d[1]\ns=set(d[2:2+n])\nprint("yes" if any(t-x in s for x in s) else "no")'),
    tests: [
      shown('4 9\n1 3 6 8', 'yes'),
      secret('3 100\n1 2 3', 'no'),
      secret('2 5\n2 3', 'yes'),
      secret('2 6\n3 5', 'no'),
      secret('2 6\n3 3', 'yes'),
      secret('3 -2000000000\n-1000000000 5 -1000000000', 'yes'),
      secret(`${pairList.length} ${pairTarget}\n${pairList.join(' ')}`, hasPair(pairList, pairTarget) ? 'yes' : 'no'),
      secret(`${evens.length} 1\n${evens.join(' ')}`, 'no'),
    ],
  }),
  problem({
    title: 'Range sum',
    statement: [
      'You are given an array of n integers and q queries. Each query gives two indices l and r; answer it with the sum `a_l + a_{l+1} + … + a_r`.',
      'Input\nThe first line contains two integers `n` and `q` (`1 ≤ n ≤ 2·10^5`, `1 ≤ q ≤ 3000`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).\nEach of the next q lines contains two integers `l` and `r` (`1 ≤ l ≤ r ≤ n`).',
      'Output\nFor each query, print the sum on its own line.',
    ].join('\n\n'),
    editorial: 'Build prefix sums `p_0 = 0`, `p_i = p_{i−1} + a_i` once. A query is then `p_r − p_{l−1}` in constant time. Summing each range directly costs up to `n·q = 6·10^8` operations. Sums reach `2·10^14`, so use 64-bit integers.',
    tags: ['prefix-sums', 'arrays'],
    contest: false,
    pool: 'practice',
    difficulty: 'medium',
    inputSpec: 'n int 1..2*10^5, q int 1..3000\na int[n] -10^9..10^9\nlines q: l int 1..n, r int l..n',
    reference: py('d=sys.stdin.read().split()\nit=iter(d)\nn,q=int(next(it)),int(next(it))\na=[int(next(it)) for _ in range(n)]\np=[0]\nfor x in a: p.append(p[-1]+x)\nout=[]\nfor _ in range(q):\n l,r=int(next(it)),int(next(it))\n out.append(str(p[r]-p[l-1]))\nprint("\\n".join(out))'),
    wrong: py('d=sys.stdin.read().split()\nit=iter(d)\nn,q=int(next(it)),int(next(it))\na=[int(next(it)) for _ in range(n)]\np=[0]\nfor x in a: p.append(p[-1]+x)\nout=[]\nfor _ in range(q):\n l,r=int(next(it)),int(next(it))\n out.append(str(p[r]-p[l]))\nprint("\\n".join(out))'),
    tests: [
      shown('4 2\n1 2 3 4\n1 3\n2 4', '6\n9'),
      secret('1 1\n5\n1 1', 5),
      secret('3 1\n-1 0 4\n1 3', 3),
      secret('3 3\n7 -8 9\n1 1\n2 2\n3 3', '7\n-8\n9'),
      secret(
        `${rangeValues.length} ${rangeQueries.length}\n${rangeValues.join(' ')}\n${rangeQueries.map(([l, r]) => `${l} ${r}`).join('\n')}`,
        rangeQueries.map(([l, r]) => rangePrefix[r]! - rangePrefix[l - 1]!).join('\n'),
      ),
    ],
  }),
  problem({
    title: 'Climbing stairs',
    statement: [
      'A staircase has n steps. With each move you climb either one step or two. Count the different sequences of moves that take you from the bottom exactly to the top.',
      'Input\nThe only line contains an integer `n` (`1 ≤ n ≤ 90`).',
      'Output\nPrint the number of ways. It fits in a signed 64-bit integer.',
    ].join('\n\n'),
    editorial: 'The last move is one step or two, so `ways(n) = ways(n − 1) + ways(n − 2)` with `ways(0) = ways(1) = 1`. That is the Fibonacci sequence shifted by one: `ways(n) = F(n + 1)`.',
    tags: ['dp'],
    contest: false,
    pool: 'archive',
    difficulty: 'medium',
    inputSpec: 'n int 1..90',
    reference: py('n=int(sys.stdin.read())\na,b=1,1\nfor _ in range(n):\n a,b=b,a+b\nprint(a)'),
    wrong: py('n=int(sys.stdin.read())\na,b=0,1\nfor _ in range(n):\n a,b=b,a+b\nprint(a)'),
    tests: [
      shown('3', 3),
      secret('1', 1),
      secret('2', 2),
      secret('4', 5),
      secret('45', fibonacci(46)),
      secret('90', fibonacci(91)),
    ],
  }),
  problem({
    title: 'Rotate left',
    statement: [
      'You are given an array of n integers and an integer k. Rotate the array left by k positions, that is, move the first element to the end k times, and print the result.',
      'Input\nThe first line contains two integers `n` and `k` (`1 ≤ n ≤ 5000`, `0 ≤ k ≤ 10^9`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint the n elements of the rotated array, separated by spaces.',
      'Note\nk may be much larger than n. Rotating by a multiple of n leaves the array unchanged.',
    ].join('\n\n'),
    editorial: 'Only `k mod n` matters. Print `a_{s+1}, …, a_n` followed by `a_1, …, a_s` with `s = k mod n`. Simulating k single moves is far too slow at `k = 10^9`.',
    tags: ['arrays', 'math'],
    contest: false,
    pool: 'practice',
    difficulty: 'medium',
    inputSpec: 'n int 1..5000, k int 0..10^9\na int[n] -10^9..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\nn,k=d[0],d[1]%d[0]\na=d[2:2+n]\na=a[k:]+a[:k]\nprint(*a)'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\nn,k=d[0],d[1]\na=d[2:2+n]\na=a[k:]+a[:k]\nprint(*a)'),
    tests: [
      shown('5 2\n1 2 3 4 5', '3 4 5 1 2'),
      secret('4 0\n1 2 3 4', '1 2 3 4'),
      secret('3 3\n1 2 3', '1 2 3'),
      secret('3 4\n9 8 7', '8 7 9'),
      secret('1 1000000000\n42', 42),
      secret('7 1000000000\n1 2 3 4 5 6 7', rotate([1, 2, 3, 4, 5, 6, 7], 1_000_000_000).join(' ')),
      secret(`${rotateValues.length} 123456789\n${rotateValues.join(' ')}`, rotate(rotateValues, 123_456_789).join(' ')),
    ],
  }),
  problem({
    title: 'Maximum subarray',
    statement: [
      'You are given an array of n integers. Find the largest possible sum of a non-empty contiguous subarray `a_l, a_{l+1}, …, a_r`.',
      'Input\nThe first line contains an integer `n` (`1 ≤ n ≤ 2·10^5`).\nThe second line contains n integers `a_1, a_2, …, a_n` (`-10^9 ≤ a_i ≤ 10^9`).',
      'Output\nPrint the maximum subarray sum.',
      'Note\nThe subarray must contain at least one element, so when every number is negative the answer is the largest of them.',
    ].join('\n\n'),
    editorial: 'Kadane’s algorithm: the best sum ending at position i is either `a_i` alone or `a_i` plus the best sum ending at `i − 1`. Track the maximum over all i. Initialising the answer to 0 is wrong when every element is negative.',
    tags: ['dp', 'arrays'],
    contest: false,
    pool: 'archive',
    difficulty: 'medium',
    inputSpec: 'n int 1..2*10^5\na int[n] -10^9..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\na=d[1:1+d[0]]\nbest=cur=a[0]\nfor x in a[1:]:\n cur=max(x,cur+x)\n best=max(best,cur)\nprint(best)'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\na=d[1:1+d[0]]\nbest=cur=0\nfor x in a:\n cur=max(0,cur+x)\n best=max(best,cur)\nprint(best)'),
    tests: [
      shown('5\n-2 1 -3 4 -1', 4),
      secret('1\n5', 5),
      secret('4\n1 -2 3 1', 4),
      secret('3\n-5 -2 -9', -2),
      secret('5\n1000000000 1000000000 1000000000 1000000000 1000000000', 5_000_000_000),
      secret(array(subarrayList), maxSubarray(subarrayList)),
    ],
  }),
  problem({
    title: 'Bounded knapsack',
    statement: [
      'There are n items. Item i has weight `w_i` and value `v_i`. Choose a set of items, each taken at most once, whose total weight does not exceed W and whose total value is as large as possible.',
      'Input\nThe first line contains two integers `n` and `W` (`1 ≤ n ≤ 100`, `1 ≤ W ≤ 10^4`).\nEach of the next n lines contains two integers `w_i` and `v_i` (`1 ≤ w_i ≤ 10^4`, `1 ≤ v_i ≤ 10^9`).',
      'Output\nPrint the largest total value of a set of items with total weight at most W.',
    ].join('\n\n'),
    editorial: 'Let `best[c]` be the largest value with weight at most c. Process items one by one and update c from W down to `w_i`: `best[c] = max(best[c], best[c − w_i] + v_i)`. Going downwards uses each item at most once. This is `O(n·W)`. Taking items greedily by value per unit weight is not optimal.',
    tags: ['dp', 'knapsack'],
    contest: false,
    pool: 'archive',
    difficulty: 'hard',
    inputSpec: 'n int 1..100, W int 1..10^4\nlines n: w int 1..10^4, v int 1..10^9',
    reference: py('d=list(map(int,sys.stdin.read().split()))\nn,W=d[0],d[1]\nbest=[0]*(W+1)\nfor i in range(n):\n w,v=d[2+2*i],d[3+2*i]\n if w<=W:\n  best=best[:w]+[max(x,y+v) for x,y in zip(best[w:],best)]\nprint(best[W])'),
    wrong: py('d=list(map(int,sys.stdin.read().split()))\nn,W=d[0],d[1]\nitems=sorted(((d[2+2*i],d[3+2*i]) for i in range(n)),key=lambda p:-p[1]/p[0])\ntotal=used=0\nfor w,v in items:\n if used+w<=W:\n  used+=w\n  total+=v\nprint(total)'),
    tests: [
      shown('3 5\n2 3\n3 4\n4 5', 7),
      secret('1 1\n2 9', 0),
      secret('2 10\n4 5\n6 7', 12),
      secret('3 10\n6 7\n5 5\n5 5', 10),
      secret(`100 10000\n${knapsackItems.map(([w, v]) => `${w} ${v}`).join('\n')}`, knapsack(10_000, knapsackItems)),
    ],
  }),
  problem({
    title: 'Shortest path in a line',
    statement: [
      'You are given an undirected graph with n vertices numbered from 1 to n and m edges. Find the minimum number of edges on a path from vertex 1 to vertex n.',
      'Input\nThe first line contains two integers `n` and `m` (`2 ≤ n ≤ 10^5`, `0 ≤ m ≤ 2·10^5`).\nEach of the next m lines contains two integers `u` and `v` (`1 ≤ u, v ≤ n`), an edge between u and v. The graph may contain loops and multiple edges.',
      'Output\nPrint the length of the shortest path, or `-1` if vertex n cannot be reached from vertex 1.',
    ].join('\n\n'),
    editorial: 'Breadth-first search from vertex 1 visits vertices in order of distance, so the first time it reaches n the distance is minimal. Store each edge in both directions; treating the graph as directed fails when an edge is listed as `v u`. The search is `O(n + m)`.',
    tags: ['graphs', 'bfs'],
    contest: false,
    pool: 'practice',
    difficulty: 'hard',
    inputSpec: 'n int 2..10^5, m int 0..2*10^5\nlines m: u int 1..n, v int 1..n',
    reference: py('from collections import deque\nd=sys.stdin.read().split()\nit=iter(d)\nn,m=int(next(it)),int(next(it))\ng=[[] for _ in range(n+1)]\nfor _ in range(m):\n u,v=int(next(it)),int(next(it))\n g[u].append(v)\n g[v].append(u)\ndist=[-1]*(n+1)\ndist[1]=0\nq=deque([1])\nwhile q:\n u=q.popleft()\n for v in g[u]:\n  if dist[v]<0:\n   dist[v]=dist[u]+1\n   q.append(v)\nprint(dist[n])'),
    wrong: py('from collections import deque\nd=sys.stdin.read().split()\nit=iter(d)\nn,m=int(next(it)),int(next(it))\ng=[[] for _ in range(n+1)]\nfor _ in range(m):\n u,v=int(next(it)),int(next(it))\n g[u].append(v)\ndist=[-1]*(n+1)\ndist[1]=0\nq=deque([1])\nwhile q:\n u=q.popleft()\n for v in g[u]:\n  if dist[v]<0:\n   dist[v]=dist[u]+1\n   q.append(v)\nprint(dist[n])'),
    tests: [
      shown('4 3\n1 2\n2 3\n3 4', 3),
      secret('2 0', -1),
      secret('2 1\n2 1', 1),
      secret('3 2\n1 2\n1 3', 1),
      secret('3 3\n1 1\n1 2\n1 2', -1),
      secret(`20000 ${chainEdges.length}\n${chainEdges.map(([u, v]) => `${u} ${v}`).join('\n')}`, distance(20_000, chainEdges)),
    ],
  }),
  problem({
    title: 'Partial double',
    statement: [
      'Print twice the given integer n.',
      'Input\nThe only line contains an integer `n` (`-10^9 ≤ n ≤ 10^9`).',
      'Output\nPrint `2·n`.',
      'Scoring\nThe tests form two groups. Group `sample` (30 points) contains only non-negative n. Group `full` (70 points) contains any n. Each group is scored on its own, so a solution that handles only non-negative n still earns 30 points.',
    ].join('\n\n'),
    editorial: 'Multiply by two in 64-bit arithmetic: `2·10^9` does not fit in a signed 32-bit integer. A solution that mishandles negative input passes the `sample` group only.',
    tags: ['math', 'subtasks'],
    contest: false,
    pool: 'practice',
    difficulty: 'medium',
    subtasks: [{ name: 'sample', points: 30 }, { name: 'full', points: 70 }],
    inputSpec: 'n int -10^9..10^9',
    reference: py('n=int(sys.stdin.read())\nprint(n*2)'),
    wrong: py('n=int(sys.stdin.read())\nprint(n*2 if n>=0 else n)'),
    tests: [
      shown('4', 8, 'sample'),
      secret('0', 0, 'sample'),
      secret('1000000000', 2_000_000_000, 'sample'),
      secret('-3', -6, 'full'),
      secret('100', 200, 'full'),
      secret('-1000000000', -2_000_000_000, 'full'),
    ],
  }),
];
