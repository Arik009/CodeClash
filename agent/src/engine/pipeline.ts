import { sameOutput } from '@codeclash/judge/decide';
import {
  BOUNDARY_CLASSES, boundaryInputs, defaultLimit, inputClasses, inputSize, maxScaleInput, randomInput, seededRng,
  validateInput, type BoundaryClass, type InputSpec, type SourceLanguage,
} from '@codeclash/shared';
import { generateMutants } from './mutate.js';

export interface CaseRun { exitCode: number | null; timedOut: boolean; ms: number; stdout: string; stderr: string }
export interface BatchRun { compileError: string | null; cases: CaseRun[] }
export interface Program { language: SourceLanguage; code: string }
/** Runs one program on many inputs: one compile, one container. */
export type Batch = (program: Program, inputs: string[]) => Promise<BatchRun>;

export type AIStatus = 'DISABLED' | 'AVAILABLE' | 'RATE_LIMITED' | 'BUDGET_EXCEEDED' | 'ERROR';

export interface Attack {
  type: 'wrong_solution' | 'edge_case' | 'performance';
  description: string;
  language?: SourceLanguage;
  code?: string;
  input?: string;
  generator?: string;
}

export interface PlanContext {
  statement: string;
  spec: string | null;
  reference: Program;
  tests: { input: string; output: string }[];
  mutations: MutationRecord[];
}

/** The optional model. Its attacks go through the same validation and sandbox as everything else. */
export interface Planner {
  plan(context: PlanContext): Promise<Attack[]>;
  feedback(context: PlanContext, survivors: MutationRecord[]): Promise<Attack[]>;
  summary(): { status: AIStatus; calls: number; tokens: number; note: string | null };
}

export interface Evidence { exitCode: number | null; timedOut: boolean; ms: number; stdout: string; stderr: string }

export type MutationStatus = 'compile_error' | 'trivial' | 'killed' | 'survived' | 'equivalent';

export interface MutationRecord {
  id: string;
  operator: string;
  source: 'deterministic' | 'model';
  description: string;
  diff: { line: number; original: string; mutated: string } | null;
  language: SourceLanguage;
  code: string;
  status: MutationStatus;
  /** Random inputs this mutant survived; more means a harder-to-catch bug. */
  survivedRandom: number;
  killedByProposal: string | null;
  slow: boolean;
}

export interface ProposalRecord {
  key: string;
  type: 'test' | 'wrong_solution' | 'performance_test';
  input?: string;
  expected?: string;
  language?: SourceLanguage;
  code?: string;
  reason: string;
  source: 'deterministic' | 'model';
  attack: string;
  targetMutationIds: string[];
  evidence: { validator: string; reference?: Evidence; mutant?: Evidence & { id: string } };
}

export interface HardeningMetrics {
  tests: number;
  baseline: { passed: number; total: number };
  mutants: { generated: number; compileErrors: number; trivial: number; killed: number; survived: number; equivalent: number };
  score: number | null;
  projectedScore: number | null;
  boundary: { kind: BoundaryClass; generated: boolean; covered: boolean }[];
  performance: {
    checked: boolean;
    maxInputSize: number;
    largestTestSize: number;
    referenceMs: number | null;
    limitMs: number;
    proposed: boolean;
    slowSolutionsCaught: string[];
  };
  spec: 'given' | 'drafted' | 'none';
  attacks: { boundary: number; random: number; max: number; model: number };
}

export interface HardeningInput {
  statement: string;
  reference: Program;
  tests: { input: string; output: string; hidden?: boolean }[];
  spec: { text: string; parsed: InputSpec; origin: 'given' | 'drafted' } | null;
  limits?: Partial<Record<SourceLanguage, { timeMs: number; memoryMb: number }>>;
  wrongSolutions?: { label: string; language: SourceLanguage; code: string; performance?: boolean }[];
  batch: Batch;
  planner?: Planner;
  seed?: number;
  maxMutants?: number;
  randomInputs?: number;
  /** Called between stages. Throwing stops the run (used for cancel and timeouts). */
  progress?: (stage: string) => Promise<void>;
  /** Every sandbox call, for the audit log. */
  onBatch?: (program: Program, inputs: number, source: 'reference' | 'deterministic' | 'model' | 'generator') => Promise<void>;
}

export interface HardeningResult {
  metrics: HardeningMetrics;
  mutations: MutationRecord[];
  proposals: ProposalRecord[];
  notes: string[];
  ai: { status: AIStatus; calls: number; tokens: number };
}

export class HardeningError extends Error {}

const MAX_OUTPUT = 64_000;
const MAX_PROPOSALS = 10;
const EQUIVALENT_AFTER = 10;
const DETERMINISTIC_ONLY = 'AI-assisted analysis unavailable. Running deterministic hardening suite.';

function normalizeInput(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function evidence(run: CaseRun): Evidence {
  return { exitCode: run.exitCode, timedOut: run.timedOut, ms: run.ms, stdout: clip(run.stdout, 2000), stderr: clip(run.stderr, 1000) };
}

function ranCleanly(run: CaseRun | undefined) {
  return !!run && run.exitCode === 0 && !run.timedOut;
}

/** A mutant is caught on an input when it crashes, times out, or prints something else. */
function differs(reference: CaseRun, mutant: CaseRun | undefined) {
  return !ranCleanly(mutant) || !sameOutput(mutant!.stdout, reference.stdout);
}

interface AttackInput { input: string; kind: string; source: 'deterministic' | 'model'; validator: string }

export async function runHardening(job: HardeningInput): Promise<HardeningResult> {
  const notes: string[] = [];
  const step = job.progress ?? (async () => {});
  const limitOf = (language: SourceLanguage) => job.limits?.[language] ?? defaultLimit(language);
  const rng = seededRng(job.seed ?? 1);
  const run = async (program: Program, inputs: string[], source: 'reference' | 'deterministic' | 'model' | 'generator') => {
    await job.onBatch?.(program, inputs.length, source);
    return job.batch(program, inputs);
  };

  // 1. Baseline: the reference on the current tests.
  await step('baseline');
  const tests = job.tests;
  const testInputs = tests.map((t) => t.input);
  const baseline = await run(job.reference, testInputs, 'reference');
  if (baseline.compileError !== null) throw new HardeningError(`The reference does not compile: ${clip(baseline.compileError, 300)}`);
  const passed = tests.filter((test, i) => ranCleanly(baseline.cases[i]) && sameOutput(baseline.cases[i]!.stdout, test.output)).length;
  if (passed < tests.length) notes.push(`The reference fails ${tests.length - passed} of ${tests.length} current tests. Fix those before trusting the score.`);
  const sampleIndexes = tests.map((t, i) => (t.hidden === false ? i : -1)).filter((i) => i >= 0);
  const samples = sampleIndexes.length ? sampleIndexes : tests.length ? [0] : [];

  // 2. Mutants of the reference, plus model attacks once the planner has seen the results.
  await step('mutants');
  const mutations: MutationRecord[] = generateMutants(job.reference.language, job.reference.code, job.maxMutants ?? 40).map((m) => ({
    id: m.id,
    operator: m.operator,
    source: 'deterministic',
    description: m.description,
    diff: { line: m.line, original: m.original, mutated: m.mutated },
    language: job.reference.language,
    code: m.code,
    status: 'survived',
    survivedRandom: 0,
    killedByProposal: null,
    slow: false,
  }));
  if (mutations.length === 0) notes.push('No mutation operator applies to this reference, so the score is not available.');

  const replayExisting = async (mutation: MutationRecord) => {
    const result = await run({ language: mutation.language, code: mutation.code }, testInputs, mutation.source);
    if (result.compileError !== null) {
      mutation.status = 'compile_error';
      return;
    }
    const failsAt = tests.map((_, i) => i).filter((i) => differs(baseline.cases[i]!, result.cases[i]));
    if (failsAt.some((i) => samples.includes(i)) && mutation.source === 'deterministic') mutation.status = 'trivial';
    else if (failsAt.length > 0) mutation.status = 'killed';
    else mutation.status = 'survived';
  };
  for (const [index, mutation] of mutations.entries()) {
    await step(`mutants ${index + 1}/${mutations.length}`);
    await replayExisting(mutation);
  }

  // 3. Attack inputs: boundary, random, and max-scale from the spec, then the model's.
  const existing = new Set(testInputs.map(normalizeInput));
  const attacks: AttackInput[] = [];
  const addAttack = (input: string, kind: string, source: AttackInput['source']) => {
    if (input.length === 0 || existing.has(normalizeInput(input))) return false;
    let validator = 'not checked: no input spec';
    if (job.spec) {
      const check = validateInput(job.spec.parsed, input);
      if (!check.ok) {
        notes.push(`Dropped a ${kind} input: ${check.error}`);
        return false;
      }
      validator = 'valid under the input spec';
    } else if (source === 'model') {
      notes.push('Dropped a model input: without an input spec it cannot be validated.');
      return false;
    }
    existing.add(normalizeInput(input));
    attacks.push({ input, kind, source, validator });
    return true;
  };
  const counts = { boundary: 0, random: 0, max: 0, model: 0 };
  let maxInput: string | null = null;
  if (job.spec) {
    for (const { kind, input } of boundaryInputs(job.spec.parsed, rng)) if (addAttack(input, `boundary:${kind}`, 'deterministic')) counts.boundary += 1;
    for (let i = 0; i < (job.randomInputs ?? 30); i += 1) {
      const input = randomInput(job.spec.parsed, rng);
      if (input && addAttack(input, 'random', 'deterministic')) counts.random += 1;
    }
    maxInput = maxScaleInput(job.spec.parsed, rng);
    if (maxInput && addAttack(maxInput, 'max-scale', 'deterministic')) counts.max += 1;
  } else {
    notes.push('No input spec: boundary, random, and max-size attacks were skipped. Add a spec in the Spec section.');
  }

  const context = (): PlanContext => ({
    statement: job.statement,
    spec: job.spec?.text ?? null,
    reference: job.reference,
    tests: tests.map((t) => ({ input: clip(t.input, 400), output: clip(t.output, 200) })),
    mutations,
  });
  const absorb = async (list: Attack[]) => {
    for (const attack of list) {
      if (attack.code && (attack.type === 'wrong_solution' || attack.type === 'performance')) {
        const mutation: MutationRecord = {
          id: `ai${mutations.filter((m) => m.source === 'model').length + 1}`,
          operator: attack.type === 'performance' ? 'model-slow' : 'model',
          source: 'model',
          description: clip(attack.description, 300),
          diff: null,
          language: attack.language ?? job.reference.language,
          code: attack.code,
          status: 'survived',
          survivedRandom: 0,
          killedByProposal: null,
          slow: attack.type === 'performance',
        };
        mutations.push(mutation);
        await replayExisting(mutation);
        continue;
      }
      let input = attack.input;
      if (!input && attack.generator) {
        const generated = await run({ language: 'python', code: attack.generator }, [''], 'generator');
        const output = generated.cases[0];
        input = ranCleanly(output) && output!.stdout.length <= 1_000_000 ? output!.stdout : undefined;
        if (!input) notes.push(`A model generator did not produce an input (${clip(attack.description, 80)}).`);
      }
      if (input && addAttack(input, `model:${attack.type}`, 'model')) counts.model += 1;
    }
  };

  if (job.planner) {
    await step('ai plan');
    await absorb(await job.planner.plan(context()));
  }

  // 4. The reference fixes each attack's expected output; inputs it cannot handle are dropped.
  const expectedFor = new Map<AttackInput, CaseRun>();
  const settle = async (pending: AttackInput[]) => {
    if (pending.length === 0) return;
    const result = await run(job.reference, pending.map((a) => a.input), 'reference');
    pending.forEach((attack, i) => {
      const out = result.cases[i];
      if (!ranCleanly(out)) notes.push(`Dropped a ${attack.kind} input: the reference ${out?.timedOut ? 'timed out' : 'crashed'} on it.`);
      else if (out!.stdout.trim() === '' || out!.stdout.length > MAX_OUTPUT) notes.push(`Dropped a ${attack.kind} input: the reference output is empty or over 64 KB.`);
      else expectedFor.set(attack, out!);
    });
  };

  // 5. Survivors face every accepted attack.
  const kills = new Map<AttackInput, Map<string, CaseRun>>();
  const strike = async (targets: MutationRecord[], pending: AttackInput[]) => {
    const live = pending.filter((a) => expectedFor.has(a));
    if (live.length === 0) return;
    for (const [index, mutation] of targets.entries()) {
      await step(`attacks ${index + 1}/${targets.length}`);
      const result = await run({ language: mutation.language, code: mutation.code }, live.map((a) => a.input), mutation.source);
      if (result.compileError !== null) continue;
      live.forEach((attack, i) => {
        const reference = expectedFor.get(attack)!;
        if (differs(reference, result.cases[i])) {
          const hit = kills.get(attack) ?? new Map<string, CaseRun>();
          hit.set(mutation.id, result.cases[i] ?? { exitCode: null, timedOut: true, ms: 0, stdout: '', stderr: 'not run' });
          kills.set(attack, hit);
        } else if (attack.kind === 'random') {
          mutation.survivedRandom += 1;
        }
      });
    }
  };
  const survivors = () => mutations.filter((m) => m.status === 'survived');
  const firstWave = [...attacks];
  await step('reference on attacks');
  await settle(firstWave);
  await strike(survivors(), firstWave);
  const unkilled = () => survivors().filter((m) => ![...kills.values()].some((hit) => hit.has(m.id)));

  if (job.planner && unkilled().length > 0) {
    await step('ai feedback');
    const before = attacks.length;
    await absorb(await job.planner.feedback(context(), unkilled()));
    const secondWave = attacks.slice(before);
    await settle(secondWave);
    await strike(survivors(), secondWave);
  }

  // 6. Likely equivalent: survived the suite and every attack, with enough random inputs tried.
  for (const mutation of unkilled()) {
    if (mutation.source === 'deterministic' && mutation.survivedRandom >= EQUIVALENT_AFTER) mutation.status = 'equivalent';
  }

  // 7. Proposals: the fewest inputs that kill every killable survivor, smallest first on ties.
  await step('proposals');
  const proposals: ProposalRecord[] = [];
  const open = new Set(survivors().filter((m) => [...kills.values()].some((hit) => hit.has(m.id))).map((m) => m.id));
  while (open.size > 0 && proposals.length < MAX_PROPOSALS) {
    let best: AttackInput | null = null;
    let bestHits: string[] = [];
    for (const [attack, hit] of kills) {
      const hits = [...hit.keys()].filter((id) => open.has(id));
      if (hits.length === 0) continue;
      if (!best || hits.length > bestHits.length || (hits.length === bestHits.length && attack.input.length < best.input.length)) {
        best = attack;
        bestHits = hits;
      }
    }
    if (!best) break;
    const key = `p${proposals.length + 1}`;
    const target = mutations.find((m) => m.id === bestHits[0])!;
    for (const id of bestHits) {
      open.delete(id);
      mutations.find((m) => m.id === id)!.killedByProposal = key;
    }
    const others = bestHits.length > 1 ? ` and ${bestHits.length - 1} more` : '';
    proposals.push({
      key,
      type: 'test',
      input: best.input,
      expected: expectedFor.get(best)!.stdout,
      reason: `Kills ${target.id} (${target.description})${others}. Found by the ${best.kind} attack.`,
      source: best.source,
      attack: best.kind,
      targetMutationIds: bestHits,
      evidence: {
        validator: best.validator,
        reference: evidence(expectedFor.get(best)!),
        mutant: { id: target.id, ...evidence(kills.get(best)!.get(target.id)!) },
      },
    });
  }
  if (open.size > 0) notes.push(`${open.size} more mutant(s) can be killed; run hardening again after approving these tests.`);

  for (const mutation of mutations.filter((m) => m.source === 'model' && !m.slow)) {
    if (mutation.status === 'killed' || mutation.killedByProposal) {
      proposals.push({
        key: `p${proposals.length + 1}`,
        type: 'wrong_solution',
        language: mutation.language,
        code: mutation.code,
        reason: `A model wrong solution (${clip(mutation.description, 120)}) that ${mutation.killedByProposal ? `test ${mutation.killedByProposal} catches` : 'the current tests catch'}. Keeping it guards future edits.`,
        source: 'model',
        attack: 'model:wrong_solution',
        targetMutationIds: [mutation.id],
        evidence: { validator: 'not an input' },
      });
    } else if (mutation.status === 'survived') {
      notes.push(`Model solution ${mutation.id} matched the reference on every input; it may be correct.`);
    }
  }

  // 8. Performance: the suite needs a test near the maximum size.
  const limitMs = limitOf(job.reference.language).timeMs;
  const largestTestSize = tests.reduce((max, t) => Math.max(max, inputSize(t.input)), 0);
  const performance: HardeningMetrics['performance'] = {
    checked: false, maxInputSize: 0, largestTestSize, referenceMs: null, limitMs, proposed: false, slowSolutionsCaught: [],
  };
  const maxAttack = attacks.find((a) => a.kind === 'max-scale');
  if (maxInput && maxAttack && expectedFor.has(maxAttack)) {
    await step('performance');
    const reference = expectedFor.get(maxAttack)!;
    performance.checked = true;
    performance.maxInputSize = inputSize(maxInput);
    performance.referenceMs = reference.ms;
    const slow = [
      ...(job.wrongSolutions ?? []).filter((w) => w.performance || /slow|tle|brute|naive/i.test(w.label)).map((w) => ({ label: w.label, program: { language: w.language, code: w.code } })),
      ...mutations.filter((m) => m.slow).map((m) => ({ label: m.id, program: { language: m.language, code: m.code } })),
    ];
    for (const candidate of slow) {
      const result = await run(candidate.program, [maxInput], candidate.label.startsWith('ai') ? 'model' : 'deterministic');
      if (result.compileError === null && differs(reference, result.cases[0])) performance.slowSolutionsCaught.push(candidate.label);
    }
    for (const mutation of mutations.filter((m) => m.slow && performance.slowSolutionsCaught.includes(m.id))) mutation.status = 'killed';
    if (largestTestSize < performance.maxInputSize / 2 && !proposals.some((p) => p.input === maxInput)) {
      performance.proposed = true;
      const caught = performance.slowSolutionsCaught.length ? ` It catches ${performance.slowSolutionsCaught.join(', ')}.` : '';
      proposals.push({
        key: `p${proposals.length + 1}`,
        type: 'performance_test',
        input: maxInput,
        expected: reference.stdout,
        reason: `No current test reaches half the maximum input size (largest is ${largestTestSize} of ${performance.maxInputSize} values). The reference took ${reference.ms} ms of ${limitMs} ms.${caught}`,
        source: 'deterministic',
        attack: 'max-scale',
        targetMutationIds: [],
        evidence: { validator: maxAttack.validator, reference: evidence(reference) },
      });
    }
  }

  // 9. Score and the measured facts next to it.
  const counted = mutations.filter((m) => m.source === 'deterministic');
  const tally = (status: MutationStatus) => counted.filter((m) => m.status === status).length;
  const eligible = counted.filter((m) => m.status === 'killed' || m.status === 'survived');
  const killedNow = eligible.filter((m) => m.status === 'killed').length;
  const killedAfter = killedNow + eligible.filter((m) => m.status === 'survived' && m.killedByProposal).length;
  const boundary = BOUNDARY_CLASSES.map((kind) => ({
    kind,
    generated: attacks.some((a) => a.kind === `boundary:${kind}`),
    covered: job.spec ? tests.some((t) => inputClasses(job.spec!.parsed, t.input).has(kind)) : false,
  }));
  const ai = job.planner?.summary() ?? { status: 'DISABLED' as const, calls: 0, tokens: 0, note: null };
  if (ai.status !== 'AVAILABLE') notes.unshift(ai.note ? `${DETERMINISTIC_ONLY} ${ai.note}` : DETERMINISTIC_ONLY);

  return {
    metrics: {
      tests: tests.length,
      baseline: { passed, total: tests.length },
      mutants: {
        generated: counted.length,
        compileErrors: tally('compile_error'),
        trivial: tally('trivial'),
        killed: killedNow,
        survived: eligible.length - killedNow,
        equivalent: tally('equivalent'),
      },
      score: eligible.length ? killedNow / eligible.length : null,
      projectedScore: eligible.length ? killedAfter / eligible.length : null,
      boundary,
      performance,
      spec: job.spec?.origin ?? 'none',
      attacks: counts,
    },
    mutations,
    proposals,
    notes,
    ai: { status: ai.status, calls: ai.calls, tokens: ai.tokens },
  };
}
