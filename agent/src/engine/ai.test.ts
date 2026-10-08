import { describe, expect, it } from 'vitest';
import { FakeProvider, ProviderError } from '../providers.js';
import { auditArgs, createPlanner, extractJson, feedbackPrompt, planPrompt, readAttacks, type AuditRow } from './ai.js';
import type { MutationRecord, PlanContext } from './pipeline.js';

const survivor: MutationRecord = {
  id: 'm1', operator: 'relational', source: 'deterministic', description: 'line 4: <= to <',
  diff: { line: 4, original: 'i <= n', mutated: 'i < n' }, language: 'python', code: '', status: 'survived',
  survivedRandom: 0, killedByProposal: null, slow: false,
};
const context: PlanContext = {
  statement: 'Print the maximum.', spec: 'n int 1..5', reference: { language: 'python', code: 'print(max(a))' },
  tests: [{ input: '1\n3\n', output: '3\n' }], mutations: [survivor],
};

describe('model replies', () => {
  it('keeps valid attacks and denies prohibited tools and unknown fields', () => {
    const { attacks, denied } = readAttacks({
      tool: 'publish',
      notes: 'hi',
      attacks: [
        { type: 'edge_case', description: 'one element', input: '1\n5\n' },
        { tool: 'edit_tests', type: 'edge_case', description: 'x', input: '1\n1\n' },
        { tool: 'propose_test', type: 'edge_case', description: 'allowed tool', input: '1\n2\n' },
        { type: 'edge_case', description: 'extra', input: '1\n1\n', limits: { timeMs: 99999 } },
        { type: 'wrong_solution', description: 'empty' },
        { type: 'nonsense', description: 'bad type', input: '1' },
      ],
    });
    expect(attacks.map((a) => a.description)).toEqual(['one element', 'allowed tool']);
    expect(denied.map((d) => d.what)).toEqual(['publish', 'notes', 'edit_tests', 'attack', 'attack', 'attack']);
    expect(denied[0]!.reason).toBe('tool is prohibited');
    expect(denied[3]!.reason).toMatch(/Unrecognized key/);
    expect(readAttacks(null).denied[0]!.reason).toBe('not a JSON object');
    expect(readAttacks({ attacks: 'no' }).attacks).toEqual([]);
  });

  it('pulls JSON out of prose and fences', () => {
    expect(extractJson('Sure!\n```json\n{"attacks":[]}\n```')).toEqual({ attacks: [] });
    expect(extractJson('no json')).toBeNull();
    expect(extractJson('{broken')).toBeNull();
  });

  it('truncates long code in audit arguments and adds a hash', () => {
    const long = 'x'.repeat(5000);
    const row = auditArgs({ code: long, inputs: 3, nested: [long.slice(0, 10)] }) as { code: { text: string; length: number; sha256: string } };
    expect(row.code.text).toHaveLength(2048);
    expect(row.code).toMatchObject({ length: 5000, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(auditArgs({ inputs: 3 })).toEqual({ inputs: 3 });
  });

  it('puts the statement, spec, and surviving diffs in the prompts', () => {
    expect(planPrompt(context)).toContain('i < n');
    expect(planPrompt(context)).toContain('n int 1..5');
    expect(feedbackPrompt(context, [survivor])).toContain('m1 (relational)');
  });
});

describe('planner', () => {
  const setup = (provider: FakeProvider, caps: { run?: number; used?: number; cap?: number } = {}) => {
    const rows: AuditRow[] = [];
    const planner = createPlanner({
      provider,
      audit: async (row) => { rows.push(row); },
      runTokenCap: caps.run ?? 1000,
      monthlyUsed: caps.used ?? 0,
      monthlyCap: caps.cap ?? 10_000,
    });
    return { planner, rows };
  };

  it('makes the plan call, audits it, and audits denied parts', async () => {
    const { planner, rows } = setup(new FakeProvider(['{"tool":"publish","attacks":[{"type":"edge_case","description":"d","input":"1\\n2\\n"}]}']));
    const attacks = await planner.plan(context);
    expect(attacks).toHaveLength(1);
    expect(rows.map((r) => [r.tool, r.decision])).toEqual([['model.plan', 'allow'], ['publish', 'deny']]);
    expect(rows[0]!.tokens).toBe(40);
    expect(planner.summary()).toEqual({ status: 'AVAILABLE', calls: 1, tokens: 40, note: null });
  });

  it('stops at the per-run and monthly budgets', async () => {
    const run = setup(new FakeProvider(['{"attacks":[]}', '{"attacks":[]}']), { run: 40 });
    await run.planner.plan(context);
    expect(await run.planner.feedback(context, [survivor])).toEqual([]);
    expect(run.planner.summary()).toMatchObject({ status: 'BUDGET_EXCEEDED', calls: 1, note: 'The per-run token limit is spent.' });
    expect(run.rows.at(-1)).toMatchObject({ decision: 'deny', tool: 'model.feedback' });
    const monthly = setup(new FakeProvider([]), { used: 10_000 });
    await monthly.planner.plan(context);
    expect(monthly.planner.summary()).toMatchObject({ status: 'BUDGET_EXCEEDED', calls: 0, note: 'The monthly token budget is spent.' });
  });

  it('maps provider failures to a status and makes no further calls', async () => {
    const limited = setup(new FakeProvider([new ProviderError('RATE_LIMITED', 'slow down'), '{"attacks":[]}']));
    await limited.planner.plan(context);
    await limited.planner.feedback(context, [survivor]);
    expect(limited.planner.summary()).toEqual({ status: 'RATE_LIMITED', calls: 0, tokens: 0, note: 'slow down' });
    const broken = setup(new FakeProvider([new Error('socket hang up')]));
    await broken.planner.plan(context);
    expect(broken.planner.summary()).toMatchObject({ status: 'ERROR', note: 'socket hang up' });
  });
});
