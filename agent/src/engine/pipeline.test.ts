import { parseSpec, validateInput } from '@codeclash/shared';
import { describe, expect, it } from 'vitest';
import { fakeBatch, MAX_REFERENCE, MAX_SPEC, MAX_TESTS } from '../testdata/fake-batch.js';
import { HardeningError, runHardening, type Attack, type HardeningInput, type Planner } from './pipeline.js';

const reference = { language: 'javascript' as const, code: MAX_REFERENCE };
const spec = { text: MAX_SPEC, parsed: parseSpec(MAX_SPEC), origin: 'given' as const };

function job(extra: Partial<HardeningInput> = {}): HardeningInput {
  return { statement: 'Print the maximum.', reference, tests: MAX_TESTS, spec, batch: fakeBatch(), seed: 3, ...extra };
}

function planner(plan: Attack[], feedback: Attack[] = []): Planner & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    plan: async () => { asked.push('plan'); return plan; },
    feedback: async () => { asked.push('feedback'); return feedback; },
    summary: () => ({ status: 'AVAILABLE', calls: asked.length, tokens: 80 * asked.length, note: null }),
  };
}

describe('deterministic hardening', () => {
  it('scores the suite, finds the missing case, and proposes a killing test', async () => {
    const result = await runHardening(job());
    const { metrics, mutations, proposals } = result;
    expect(metrics.baseline).toEqual({ passed: 2, total: 2 });
    expect(metrics.mutants.generated).toBeGreaterThan(4);
    expect(metrics.mutants.trivial).toBeGreaterThan(0);
    expect(metrics.mutants.equivalent).toBeGreaterThan(0);

    const loopBound = mutations.find((m) => m.diff?.mutated.includes('i < n'))!;
    expect(loopBound.status).toBe('survived');
    expect(loopBound.killedByProposal).toBeTruthy();
    expect(mutations.find((m) => m.diff?.mutated.includes('d[i] >= best'))!.status).toBe('equivalent');

    const eligible = metrics.mutants.killed + metrics.mutants.survived;
    expect(metrics.score).toBeCloseTo(metrics.mutants.killed / eligible);
    expect(metrics.projectedScore).toBe(1);

    const test = proposals.find((p) => p.targetMutationIds.includes(loopBound.id))!;
    expect(validateInput(spec.parsed, test.input!)).toEqual({ ok: true });
    const values = test.input!.trim().split(/\s+/).map(Number).slice(1);
    expect(test.expected).toBe(`${Math.max(...values)}\n`);
    expect(test.evidence.validator).toBe('valid under the input spec');
    expect(test.evidence.mutant?.id).toBe(loopBound.id);
    expect(test.reason).toMatch(/^Kills m\d+/);
    expect(result.ai.status).toBe('DISABLED');
    expect(result.notes[0]).toBe('AI-assisted analysis unavailable. Running deterministic hardening suite.');
  });

  it('measures boundary coverage and asks for a max-size test', async () => {
    const { metrics, proposals } = await runHardening(job());
    expect(metrics.boundary.find((b) => b.kind === 'single')).toEqual({ kind: 'single', generated: true, covered: true });
    expect(metrics.boundary.find((b) => b.kind === 'negatives')).toMatchObject({ generated: true, covered: false });
    expect(metrics.performance).toMatchObject({ checked: true, proposed: true, largestTestSize: 4 });
    const perf = proposals.find((p) => p.type === 'performance_test')!;
    expect(perf.input!.split('\n')[0]).toBe('1000');
    expect(perf.reason).toMatch(/half the maximum input size/);
    expect(metrics.attacks.boundary).toBeGreaterThan(3);
    expect(metrics.attacks.random).toBeGreaterThan(10);
  });

  it('is repeatable for the same seed', async () => {
    const a = await runHardening(job());
    const b = await runHardening(job());
    expect(b.proposals.map((p) => p.input)).toEqual(a.proposals.map((p) => p.input));
  });

  it('without a spec it still replays mutants and says what it skipped', async () => {
    const result = await runHardening(job({ spec: null }));
    expect(result.metrics.spec).toBe('none');
    expect(result.metrics.attacks).toEqual({ boundary: 0, random: 0, max: 0, model: 0 });
    expect(result.proposals).toHaveLength(0);
    expect(result.metrics.mutants.equivalent).toBe(0);
    expect(result.notes.join(' ')).toMatch(/No input spec/);
  });

  it('stops on a reference that does not compile and warns when it fails tests', async () => {
    await expect(runHardening(job({ reference: { language: 'cpp', code: 'BROKEN' } }))).rejects.toThrow(HardeningError);
    const wrongTests = [...MAX_TESTS, { input: '2\n1 2\n', output: '1\n' }];
    const result = await runHardening(job({ tests: wrongTests }));
    expect(result.metrics.baseline).toEqual({ passed: 2, total: 3 });
    expect(result.notes.join(' ')).toMatch(/fails 1 of 3/);
  });

  it('can be stopped between stages', async () => {
    let calls = 0;
    const stop = async () => { calls += 1; if (calls > 3) throw new Error('cancelled'); };
    await expect(runHardening(job({ progress: stop }))).rejects.toThrow('cancelled');
  });

  it('runs a slow setter solution against the max-size input', async () => {
    const slow = MAX_REFERENCE.replace('console.log(best);', 'if (n > 500) while (true) {}\nconsole.log(best);');
    const result = await runHardening(job({ wrongSolutions: [{ label: 'slow brute force', language: 'javascript', code: slow }] }));
    expect(result.metrics.performance.slowSolutionsCaught).toEqual(['slow brute force']);
  });
});

describe('model attacks', () => {
  it('validates model inputs, runs model solutions, and asks for feedback only when needed', async () => {
    const firstOnly = "const d = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/).map(Number);\nconsole.log(d[1]);";
    const ai = planner([
      { type: 'wrong_solution', description: 'prints the first element', language: 'javascript', code: firstOnly },
      { type: 'edge_case', description: 'out of range', input: '2\n500 1\n' },
      { type: 'edge_case', description: 'max at the end', input: '4\n1 2 3 99\n' },
      { type: 'edge_case', description: 'generated', generator: 'print("2\\n-5 -3")' },
      { type: 'edge_case', description: 'bad generator', generator: 'import os' },
    ]);
    const result = await runHardening(job({ planner: ai, randomInputs: 0 }));
    expect(result.metrics.attacks.model).toBe(2);
    expect(result.notes.join(' ')).toMatch(/Dropped a model:edge_case input: line 2: a = 500/);
    expect(result.notes.join(' ')).toMatch(/generator did not produce an input/);
    const model = result.mutations.find((m) => m.source === 'model')!;
    expect(model.status).toBe('killed');
    expect(result.proposals.some((p) => p.type === 'wrong_solution' && p.source === 'model')).toBe(true);
    expect(result.metrics.mutants.generated).toBe(result.mutations.filter((m) => m.source === 'deterministic').length);
    expect(result.ai).toMatchObject({ status: 'AVAILABLE' });
    expect(ai.asked[0]).toBe('plan');
  });

  it('drops model inputs when there is no spec to check them', async () => {
    const ai = planner([{ type: 'edge_case', description: 'x', input: '1\n3\n' }]);
    const result = await runHardening(job({ planner: ai, spec: null }));
    expect(result.metrics.attacks.model).toBe(0);
    expect(result.notes.join(' ')).toMatch(/cannot be validated/);
  });

  it('sends survivors back to the model and uses its targeted inputs', async () => {
    const ai = planner([], [{ type: 'edge_case', description: 'max last', input: '3\n1 2 9\n' }]);
    const result = await runHardening(job({ planner: ai, randomInputs: 0, spec: { ...spec, parsed: parseSpec('n int 1..3\na int[n] 1..2') } }));
    expect(ai.asked).toEqual(['plan', 'feedback']);
    expect(result.notes.join(' ')).toMatch(/a = 9 is outside 1..2/);
  });
});
