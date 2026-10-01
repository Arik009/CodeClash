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
  subtasks?: { name: string; points: number }[];
  tests: { input: string; output: string; hidden: boolean; group?: string }[];
  reference: string;
  wrong: string;
}

const py = (body: string) => `import sys\n${body}\n`;

export const CATALOG: CatalogProblem[] = [
  {
    title: 'Sum of two integers',
    statement: 'Read two integers from a single line and print their sum.',
    samples: 'Input\n1 2\nOutput\n3',
    editorial: 'Split the line into two integers and add them. Watch the sign: a negative addend is still ordinary addition.',
    tags: ['math'],
    contest: true,
    reference: py('a,b=map(int,sys.stdin.read().split())\nprint(a+b)'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(a-b)'),
    tests: [
      { input: '1 2\n', output: '3\n', hidden: false },
      { input: '10 20\n', output: '30\n', hidden: true },
      { input: '-5 5\n', output: '0\n', hidden: true },
    ],
  },
  {
    title: 'Larger of two',
    statement: 'Read two integers and print the larger one. If they are equal, print that value.',
    samples: 'Input\n3 1\nOutput\n3',
    editorial: 'Compare the two values once. Equality is not a special case: printing either value is correct.',
    tags: ['math'],
    contest: true,
    reference: py('a,b=map(int,sys.stdin.read().split())\nprint(a if a>=b else b)'),
    wrong: py('a,b=map(int,sys.stdin.read().split())\nprint(a if a<=b else b)'),
    tests: [
      { input: '3 1\n', output: '3\n', hidden: false },
      { input: '2 2\n', output: '2\n', hidden: true },
      { input: '-1 -4\n', output: '-1\n', hidden: true },
    ],
  },
  {
    title: 'Even or odd',
    statement: 'Read one integer and print even if it is divisible by 2, otherwise odd.',
    samples: 'Input\n4\nOutput\neven',
    editorial: 'The remainder modulo 2 is enough. Zero is even.',
    tags: ['math'],
    contest: true,
    reference: py('n=int(sys.stdin.read())\nprint("even" if n%2==0 else "odd")'),
    wrong: py('n=int(sys.stdin.read())\nprint("even")'),
    tests: [
      { input: '4\n', output: 'even\n', hidden: false },
      { input: '7\n', output: 'odd\n', hidden: true },
      { input: '0\n', output: 'even\n', hidden: true },
    ],
  },
  {
    title: 'Sum of a list',
    statement: 'The first integer n is the length. The next n integers follow. Print their sum.',
    samples: 'Input\n3\n1 2 3\nOutput\n6',
    editorial: 'Read every integer, drop the length, and sum the rest. The length is not part of the sum.',
    tags: ['arrays'],
    contest: true,
    reference: py('data=list(map(int,sys.stdin.read().split()))\nprint(sum(data[1:1+data[0]]))'),
    wrong: py('data=list(map(int,sys.stdin.read().split()))\nprint(data[0])'),
    tests: [
      { input: '3\n1 2 3\n', output: '6\n', hidden: false },
      { input: '1\n5\n', output: '5\n', hidden: true },
      { input: '4\n-1 0 1 2\n', output: '2\n', hidden: true },
    ],
  },
  {
    title: 'Reverse the word',
    statement: 'Read one word and print it reversed. The word contains only letters.',
    samples: 'Input\nabc\nOutput\ncba',
    editorial: 'Reverse the character sequence. A one-letter word and a palindrome stay the same.',
    tags: ['strings'],
    contest: true,
    reference: py('print(sys.stdin.read().strip()[::-1])'),
    wrong: py('print(sys.stdin.read().strip())'),
    tests: [
      { input: 'abc\n', output: 'cba\n', hidden: false },
      { input: 'a\n', output: 'a\n', hidden: true },
      { input: 'racecar\n', output: 'racecar\n', hidden: true },
    ],
  },
  {
    title: 'Count the vowels',
    statement: 'Read one word and print how many vowels it contains. Count a, e, i, o and u, in either case. Y is not a vowel.',
    samples: 'Input\ncode\nOutput\n2',
    editorial: 'Lowercase the word and count membership in aeiou. Consonants and y add nothing.',
    tags: ['strings'],
    contest: true,
    reference: py('s=sys.stdin.read().strip().lower()\nprint(sum(ch in "aeiou" for ch in s))'),
    wrong: py('s=sys.stdin.read().strip()\nprint(len(s))'),
    tests: [
      { input: 'code\n', output: '2\n', hidden: false },
      { input: 'xyz\n', output: '0\n', hidden: true },
      { input: 'AEIOU\n', output: '5\n', hidden: true },
    ],
  },
  {
    title: 'Celsius to Fahrenheit',
    statement: 'Read an integer Celsius temperature and print the Fahrenheit temperature as an integer, using F = C × 9 / 5 + 32 with integer division.',
    samples: 'Input\n0\nOutput\n32',
    editorial: 'Apply the formula with integer arithmetic. -40 is the fixed point, and 100 C is 212 F.',
    tags: ['math'],
    contest: false,
    reference: py('c=int(sys.stdin.read())\nprint(c*9//5+32)'),
    wrong: py('c=int(sys.stdin.read())\nprint(c)'),
    tests: [
      { input: '0\n', output: '32\n', hidden: false },
      { input: '100\n', output: '212\n', hidden: true },
      { input: '-40\n', output: '-40\n', hidden: true },
    ],
  },
  {
    title: 'One number of FizzBuzz',
    statement: 'Read one positive integer n. Print FizzBuzz if it is divisible by 15, Fizz if only by 3, Buzz if only by 5, otherwise print n.',
    samples: 'Input\n3\nOutput\nFizz',
    editorial: 'Test 15 before 3 and 5, otherwise a multiple of 15 is reported as Fizz.',
    tags: ['math'],
    contest: false,
    reference: py('n=int(sys.stdin.read())\nprint("FizzBuzz" if n%15==0 else "Fizz" if n%3==0 else "Buzz" if n%5==0 else n)'),
    wrong: py('n=int(sys.stdin.read())\nprint(n)'),
    tests: [
      { input: '3\n', output: 'Fizz\n', hidden: false },
      { input: '5\n', output: 'Buzz\n', hidden: true },
      { input: '15\n', output: 'FizzBuzz\n', hidden: true },
      { input: '2\n', output: '2\n', hidden: true },
    ],
  },
];

export const QUIZ_BANK: { prompt: string; options: string[]; correctIndex: number }[] = [
  { prompt: 'Average lookup in a hash table is usually', options: ['O(1)', 'O(n)', 'O(n log n)'], correctIndex: 0 },
  { prompt: 'Merge sort worst case is', options: ['O(n^2)', 'O(n log n)', 'O(log n)'], correctIndex: 1 },
  { prompt: 'typeof NaN in JavaScript is', options: ['"undefined"', '"number"', '"NaN"'], correctIndex: 1 },
  { prompt: 'TCP handshake flags are', options: ['SYN, SYN-ACK, ACK', 'ACK, SYN, FIN', 'SYN, ACK, SYN'], correctIndex: 0 },
  { prompt: 'CAP during a partition trades', options: ['consistency and availability', 'speed and memory', 'latency and durability'], correctIndex: 0 },
  { prompt: 'A stack removes from', options: ['the front only', 'the most recent end', 'a random index'], correctIndex: 1 },
  { prompt: 'Binary search requires', options: ['a sorted range', 'a hash of the keys', 'a linked list'], correctIndex: 0 },
  { prompt: 'HTTP 404 means', options: ['not found', 'unauthorized', 'rate limited'], correctIndex: 0 },
  { prompt: 'HTTP 403 means', options: ['the server crashed', 'authenticated but forbidden', 'the body was empty'], correctIndex: 1 },
  { prompt: 'A primary key must be', options: ['unique for each row', 'a foreign key', 'stored in Redis'], correctIndex: 0 },
  { prompt: 'Git commit records', options: ['a snapshot of the tree', 'only the newest file', 'the remote URL'], correctIndex: 0 },
  { prompt: 'BFS visits a graph', options: ['level by level', 'as deep as possible first', 'in alphabetical order'], correctIndex: 0 },
  { prompt: 'An index speeds up', options: ['reads that match its key', 'every write, for free', 'network transfer'], correctIndex: 0 },
  { prompt: 'SQL NULL compared with = is', options: ['unknown, not true', 'always true', 'always false and an error'], correctIndex: 0 },
  { prompt: 'A race condition is', options: ['a result that depends on timing', 'a slow algorithm', 'a failed compile'], correctIndex: 0 },
  { prompt: 'Idempotent means', options: ['repeating the call does not change the outcome again', 'the call is the fastest', 'the call has no input'], correctIndex: 0 },
  { prompt: 'TLS protects', options: ['the channel from eavesdropping', 'the database schema', 'the CPU cache'], correctIndex: 0 },
  { prompt: 'Big-O ignores', options: ['constant factors', 'how the input grows', 'the worst case'], correctIndex: 0 },
  { prompt: 'A queue removes from', options: ['the end that was inserted earliest', 'the newest end', 'the middle'], correctIndex: 0 },
  { prompt: 'Recursion needs', options: ['a base case', 'a global variable', 'a sorted array'], correctIndex: 0 },
];
