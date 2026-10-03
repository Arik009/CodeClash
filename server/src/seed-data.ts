import type { Rng } from '@codeclash/shared';

/** One documented password for every demo account. */
export const DEMO_PASSWORD = 'codeclash';
export const STUDENT_DOMAIN = 'students.codeclash.dev';
export const STAFF_DOMAIN = 'codeclash.dev';

export const PARTICIPANTS = [
  'Aarav Sharma', 'Vivaan Gupta', 'Aditya Verma', 'Ishaan Reddy', 'Arjun Nair', 'Kabir Malhotra', 'Reyansh Joshi',
  'Krishna Iyer', 'Sai Teja Kumar', 'Rohit Kulkarni', 'Siddharth Rao', 'Pranav Deshpande', 'Harsh Agarwal', 'Yash Patil',
  'Nikhil Menon', 'Karthik Subramanian', 'Varun Bhat', 'Abhinav Mishra', 'Dhruv Chauhan', 'Aniket Pawar', 'Rahul Saxena',
  'Manav Kapoor', 'Tanmay Jain', 'Shreyas Hegde', 'Omkar Shinde', 'Aryan Thakur', 'Devansh Bansal', 'Parth Shah',
  'Ritvik Sinha', 'Kunal Das', 'Ananya Krishnan', 'Diya Banerjee', 'Ishita Chatterjee', 'Kavya Pillai', 'Meera Joshi',
  'Nandini Rao', 'Priya Sundaram', 'Riya Mukherjee', 'Sneha Kulkarni', 'Tanvi Desai', 'Aditi Bhatt', 'Pooja Narayanan',
  'Shruti Venkatesh', 'Neha Choudhary', 'Sanya Arora', 'Lucas Moreau', 'Emma Schneider', 'Mateo García', 'Sofia Rossi',
  "Liam O'Connor", 'Yuki Tanaka', 'Minh Anh Nguyen', 'Chen Wei', 'Ji-woo Park', 'Amara Okeke', 'Omar Haddad',
  'Elena Petrova', 'Noah Fischer', 'Hannah Kim', 'Tomás Silva',
];

export const STAFF: { name: string; role: 'setter' | 'organiser' }[] = [
  { name: 'Meghna Raghavan', role: 'setter' },
  { name: 'Arnav Bhattacharya', role: 'setter' },
  { name: 'Daniel Novak', role: 'setter' },
  { name: 'Vikram Sethi', role: 'organiser' },
  { name: 'Laura Bennett', role: 'organiser' },
];

/** `Liam O'Connor` → `liam.oconnor`, `Mateo García` → `mateo.garcia`. */
export function emailFor(name: string, domain: string) {
  const local = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
    .split(/\s+/).map((part) => part.replace(/[^a-z]/g, '')).filter(Boolean).join('.');
  return `${local}@${domain}`;
}

export function normal(rng: Rng) {
  const u = Math.max(rng.next(), 1e-12);
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Starting rating around 1400 with spread 300, clamped to 800..2600. */
export function initialRating(rng: Rng) {
  return Math.min(2600, Math.max(800, Math.round(1400 + 300 * normal(rng))));
}

/**
 * Days (0 = today, 1 = yesterday, ...) with practice in the last `span` days. Activity comes in
 * runs; about a quarter of users are on a streak that ends today or yesterday.
 */
export function practiceDays(rng: Rng, span = 112) {
  const level = 0.08 + 0.55 * rng.next();
  const active = new Set<number>();
  let on = rng.next() < level;
  for (let day = span - 1; day >= 0; day -= 1) {
    const stay = Math.min(0.92, level + 0.3);
    on = on ? rng.next() < stay : rng.next() < level * 0.6;
    if (on) active.add(day);
  }
  if (rng.next() < 0.28) {
    const end = rng.next() < 0.6 ? 0 : 1;
    const length = 2 + Math.floor(rng.next() * 40);
    if (end === 1) active.delete(0);
    for (let day = end; day < end + length && day < span; day += 1) active.add(day);
    active.delete(end + length);
  } else {
    active.delete(0);
    active.delete(1);
  }
  return [...active].sort((a, b) => a - b);
}

export interface SimProblem { id: string; rating: number; wrongVerdicts: string[] }
export interface SimPlayer { id: string; skill: number }
export interface SimAttempt { userId: string; problemId: string; verdict: string; minute: number; wrongIndex: number }

/** Chance that a player of `skill` solves a problem of `rating` within the contest. */
export function solveChance(skill: number, rating: number) {
  return 1 / (1 + Math.exp((rating - skill) / 170));
}

/**
 * Plausible contest history: players work through problems in order, stronger players solve
 * more and sooner, and some solves come after wrong attempts.
 */
export function simulateContest(rng: Rng, players: SimPlayer[], problems: SimProblem[], minutes: number): SimAttempt[] {
  const attempts: SimAttempt[] = [];
  for (const player of players) {
    let clock = 3 + Math.floor(rng.next() * 8);
    for (const problem of problems) {
      // Contest pressure: players perform somewhat below their rating against the clock.
      const chance = solveChance(player.skill - 150 + 80 * normal(rng), problem.rating);
      const tries = rng.next() < chance + 0.2;
      if (!tries) continue;
      const solves = rng.next() < chance;
      const gap = Math.max(4, Math.round((8 + 30 * rng.next()) * (1 + Math.max(-0.6, (problem.rating - player.skill) / 500))));
      const wrongs = solves ? (rng.next() < 0.55 ? 0 : rng.next() < 0.7 ? 1 : 2) : 1 + Math.floor(rng.next() * 3);
      for (let k = 0; k < wrongs; k += 1) {
        const minute = clock + Math.round(((k + 1) * gap) / (wrongs + 1));
        if (minute >= minutes) break;
        const wrongIndex = problem.wrongVerdicts.length ? Math.floor(rng.next() * problem.wrongVerdicts.length) : -1;
        attempts.push({ userId: player.id, problemId: problem.id, verdict: wrongIndex >= 0 ? problem.wrongVerdicts[wrongIndex]! : 'WA', minute, wrongIndex });
      }
      clock += gap;
      if (solves && clock < minutes) attempts.push({ userId: player.id, problemId: problem.id, verdict: 'AC', minute: clock, wrongIndex: -1 });
      if (clock >= minutes) break;
    }
  }
  return attempts.sort((a, b) => a.minute - b.minute);
}

export const MORE_QUIZ: { prompt: string; options: string[]; correctIndex: number }[] = [
  { prompt: 'A min-heap returns first', options: ['the largest key', 'the smallest key', 'the newest key'], correctIndex: 1 },
  { prompt: 'Dijkstra’s algorithm requires edge weights that are', options: ['non-negative', 'integers', 'distinct'], correctIndex: 0 },
  { prompt: 'Quicksort’s worst case on a sorted input with a first-element pivot is', options: ['O(n log n)', 'O(n)', 'O(n^2)'], correctIndex: 2 },
  { prompt: 'A tree with n vertices has', options: ['n edges', 'n − 1 edges', '2n edges'], correctIndex: 1 },
  { prompt: 'Union-find with path compression and union by rank runs in', options: ['almost constant amortized time', 'O(log n) worst case only', 'O(n) per operation'], correctIndex: 0 },
  { prompt: 'Topological order exists only for', options: ['undirected graphs', 'directed acyclic graphs', 'complete graphs'], correctIndex: 1 },
  { prompt: '2^10 equals', options: ['1000', '1024', '2048'], correctIndex: 1 },
  { prompt: 'A signed 32-bit integer holds values up to about', options: ['2.1 · 10^9', '4.3 · 10^9', '9.2 · 10^18'], correctIndex: 0 },
  { prompt: 'Binary search on n sorted items takes about', options: ['n / 2 steps', 'log2 n steps', 'sqrt n steps'], correctIndex: 1 },
  { prompt: 'Memoization stores', options: ['results of earlier calls', 'the call stack', 'compiled code'], correctIndex: 0 },
  { prompt: 'A stable sort keeps', options: ['equal keys in their original order', 'the array in place', 'O(1) extra memory'], correctIndex: 0 },
  { prompt: 'The Floyd–Warshall algorithm finds', options: ['a minimum spanning tree', 'all-pairs shortest paths', 'strongly connected components'], correctIndex: 1 },
  { prompt: 'Kruskal’s algorithm builds', options: ['a minimum spanning tree', 'a shortest-path tree', 'a topological order'], correctIndex: 0 },
  { prompt: 'A bipartite graph has no', options: ['even cycle', 'odd cycle', 'cycle at all'], correctIndex: 1 },
  { prompt: 'XOR of a number with itself is', options: ['the number', '0', '1'], correctIndex: 1 },
  { prompt: 'Two’s complement of −1 in 8 bits is', options: ['10000001', '11111111', '01111111'], correctIndex: 1 },
  { prompt: 'A prefix sum array answers a range sum in', options: ['O(1)', 'O(log n)', 'O(n)'], correctIndex: 0 },
  { prompt: 'A segment tree answers a range query in', options: ['O(1)', 'O(log n)', 'O(n)'], correctIndex: 1 },
  { prompt: 'Euclid’s algorithm computes', options: ['the least common multiple directly', 'the greatest common divisor', 'prime factors'], correctIndex: 1 },
  { prompt: 'a · b equals gcd(a, b) times', options: ['lcm(a, b)', 'a + b', 'a mod b'], correctIndex: 0 },
  { prompt: 'Fermat’s little theorem gives a^(p−1) mod p equal to', options: ['0', '1', 'p − 1'], correctIndex: 1 },
  { prompt: 'The sieve of Eratosthenes up to n runs in about', options: ['O(n log log n)', 'O(n^2)', 'O(2^n)'], correctIndex: 0 },
  { prompt: 'DFS on a graph is usually implemented with', options: ['a queue', 'a stack or recursion', 'a heap'], correctIndex: 1 },
  { prompt: 'A strongly connected component is defined for', options: ['directed graphs', 'undirected trees', 'weighted cliques only'], correctIndex: 0 },
  { prompt: 'The number of subsets of an n-element set is', options: ['n^2', '2^n', 'n!'], correctIndex: 1 },
  { prompt: 'C(n, k) counts', options: ['ordered selections', 'unordered selections of k items', 'permutations of n'], correctIndex: 1 },
  { prompt: 'Amortized O(1) push on a dynamic array relies on', options: ['doubling the capacity', 'linked nodes', 'hashing'], correctIndex: 0 },
  { prompt: 'A deque supports', options: ['insertion at both ends', 'only sorted insertion', 'random deletion in O(1)'], correctIndex: 0 },
  { prompt: 'Two pointers on a sorted array usually take', options: ['O(n)', 'O(n log n)', 'O(n^2)'], correctIndex: 0 },
  { prompt: 'In a max-flow network, the max flow equals', options: ['the min cut', 'the number of vertices', 'the longest path'], correctIndex: 0 },
  { prompt: 'A trie is best for', options: ['prefix lookups on strings', 'range minimum queries', 'shortest paths'], correctIndex: 0 },
  { prompt: 'KMP finds a pattern in a text in', options: ['O(n · m)', 'O(n + m)', 'O(m log n)'], correctIndex: 1 },
  { prompt: 'A hash collision means', options: ['two keys map to the same bucket', 'the table is full', 'a key was deleted'], correctIndex: 0 },
  { prompt: 'Integer overflow in C++ signed arithmetic is', options: ['wraps around by the standard', 'undefined behaviour', 'a compile error'], correctIndex: 1 },
  { prompt: 'An O(n log n) algorithm at n = 10^6 does roughly', options: ['2 · 10^7 operations', '10^12 operations', '10^3 operations'], correctIndex: 0 },
  { prompt: 'Greedy algorithms are correct when', options: ['a local choice is always part of an optimal answer', 'the input is small', 'the input is sorted'], correctIndex: 0 },
  { prompt: 'A bitmask over 20 items has', options: ['about 10^6 states', 'about 10^4 states', 'about 10^9 states'], correctIndex: 0 },
  { prompt: 'Bellman–Ford can detect', options: ['negative cycles', 'bridges', 'Euler tours'], correctIndex: 0 },
  { prompt: 'An Euler circuit exists in a connected undirected graph when every vertex has', options: ['even degree', 'odd degree', 'degree two'], correctIndex: 0 },
  { prompt: 'Mo’s algorithm answers offline range queries in about', options: ['O((n + q) sqrt n)', 'O(q log n)', 'O(n q)'], correctIndex: 0 },
];
