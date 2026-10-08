import { describe, expect, it } from 'vitest';
import { codeMask, generateMutants } from './mutate.js';

const ops = (language: Parameters<typeof generateMutants>[0], code: string) =>
  generateMutants(language, code, 200).map((m) => `${m.operator}: ${m.mutated}`);

describe('mutation operators', () => {
  it('flips relational operators without touching shifts, arrows, or generics', () => {
    const cpp = ops('cpp', 'vector<int> v; cin >> n; if (a < b && c >= d) p->x = 1;');
    expect(cpp).toContain('relational: vector<int> v; cin >> n; if (a <= b && c >= d) p->x = 1;');
    expect(cpp).toContain('relational: vector<int> v; cin >> n; if (a < b && c > d) p->x = 1;');
    expect(cpp.filter((m) => m.startsWith('relational'))).toHaveLength(2);
    expect(ops('javascript', 'if (a === b) f();')).toContain('relational: if (a !== b) f();');
    expect(ops('python', 'if a == b: pass')).toContain('relational: if a != b: pass');
  });

  it('swaps arithmetic but leaves unary minus, increments, and Python ** alone', () => {
    const js = ops('javascript', 'x = -1; i++; y = a + b * c;');
    expect(js).toContain('arithmetic: x = -1; i++; y = a - b * c;');
    expect(js).toContain('arithmetic: x = -1; i++; y = a + b / c;');
    expect(js.filter((m) => m.startsWith('arithmetic'))).toHaveLength(2);
    const py = ops('python', 'y = a ** 2 + b // 2');
    expect(py).toContain('arithmetic: y = a ** 2 - b // 2');
    expect(py).toContain('arithmetic: y = a ** 2 + b * 2');
    expect(py.some((m) => m.includes('a * 2') || m.includes('a // 2'))).toBe(false);
    expect(ops('python', 'total += x')).toContain('arithmetic: total -= x');
  });

  it('moves integer literals by one, and Python ranges', () => {
    const py = ops('python', 'for i in range(n):\n    s += a[i] * 10');
    expect(py).toEqual(expect.arrayContaining([
      'literal: s += a[i] * 11',
      'literal: s += a[i] * 9',
      'range: for i in range(n - 1):',
      'range: for i in range(1, n):',
    ]));
    expect(ops('cpp', 'x = 1e9; y = v2; z = 10LL;')).toEqual(expect.arrayContaining(['literal: x = 1e9; y = v2; z = 11LL;']));
    expect(ops('cpp', 'x = 1e9; y = v2;').filter((m) => m.startsWith('literal'))).toHaveLength(0);
  });

  it('covers min/max, logic, break, and long long', () => {
    expect(ops('python', 'x = min(a, b) if p and q else 0')).toEqual(expect.arrayContaining([
      'min-max: x = max(a, b) if p and q else 0',
      'logical: x = min(a, b) if p or q else 0',
    ]));
    expect(ops('cpp', 'long long s = std::max(a, b); if (x || y) break;')).toEqual(expect.arrayContaining([
      'overflow: int s = std::max(a, b); if (x || y) break;',
      'min-max: long long s = std::min(a, b); if (x || y) break;',
      'logical: long long s = std::max(a, b); if (x && y) break;',
      'break: long long s = std::max(a, b); if (x || y) ;',
    ]));
    expect(ops('python', 'while True:\n    break')).toContain('break: pass');
    expect(ops('java', 'long long x;').some((m) => m.startsWith('overflow'))).toBe(false);
  });

  it('skips strings, comments, and preprocessor lines', () => {
    const mask = codeMask('python', 'x = "a<b" # c+d\ny = 1');
    expect(mask.slice(4, 9).every((v) => !v)).toBe(true);
    expect(mask[4 + 6]).toBe(false);
    expect(ops('python', 'print("1 < 2")  # 3 + 4')).toEqual([]);
    expect(ops('cpp', '#include <bits/stdc++.h>\n/* a < b */ // c + d\nint main(){}')).toEqual([]);
    expect(ops('python', "s = '''a < b\nc + 1'''")).toEqual([]);
    expect(ops('javascript', 'const s = `a < ${b}`;')).toEqual([]);
  });

  it('dedupes identical mutants, caps the count, and rotates operators', () => {
    const many = generateMutants('python', 'a = 1 + 2 + 3 + 4 + 5 + 6 + 7 + 8 + 9\nif a < b: pass', 6);
    expect(many).toHaveLength(6);
    expect(new Set(many.map((m) => m.operator)).size).toBeGreaterThan(2);
    expect(new Set(many.map((m) => m.code)).size).toBe(6);
    expect(many[0]).toMatchObject({ id: 'm1', line: expect.any(Number), original: expect.any(String) });
    expect(generateMutants('python', 'pass')).toEqual([]);
  });
});
