import { parseSpec, validateInput } from '@codeclash/shared';
import { describe, expect, it } from 'vitest';
import { CATALOG } from './catalog.js';
import { MORE } from './catalog-more.js';

const ALL = [...CATALOG, ...MORE];

describe('built-in catalog', () => {
  it('has unique titles and formal statements', () => {
    expect(new Set(ALL.map((p) => p.title)).size).toBe(ALL.length);
    for (const p of ALL) {
      expect(p.statement, p.title).toMatch(/\n\nInput\n/);
      expect(p.statement, p.title).toMatch(/\n\nOutput\n/);
      expect(p.statement, p.title).toContain('≤');
    }
  });

  it('validates every test input against the problem spec', () => {
    for (const p of ALL) {
      const spec = parseSpec(p.inputSpec);
      p.tests.forEach((test, index) => {
        const result = validateInput(spec, test.input);
        expect(result, `${p.title} test ${index + 1}`).toEqual({ ok: true });
      });
    }
  });

  it('shows samples and hides the rest, with boundary coverage', () => {
    for (const p of ALL) {
      expect(p.tests.some((t) => !t.hidden), p.title).toBe(true);
      expect(p.tests.filter((t) => t.hidden).length, p.title).toBeGreaterThanOrEqual(4);
      expect(p.samples, p.title).toContain(p.tests[0]!.input.trimEnd());
      expect(p.wrong, p.title).not.toBe(p.reference);
    }
  });

  it('puts every test of a subtask problem into a declared group', () => {
    for (const p of ALL.filter((item) => item.subtasks?.length)) {
      const names = new Set(p.subtasks!.map((s) => s.name));
      for (const test of p.tests) expect(names.has(test.group ?? ''), p.title).toBe(true);
    }
  });

  it('keeps large outputs under the 64 KB judge cap', () => {
    for (const p of ALL) for (const test of p.tests) expect(test.output.length, p.title).toBeLessThan(64_000);
  });
});
