import { gateTool, SOURCE_LANGUAGES, type GateDecision, type SourceLanguage } from '@codeclash/shared';
import { z } from 'zod';
import { type Provider } from './providers.js';

const MAX_CALLS = 8;
const MAX_INPUT = 64_000;

/** Sandbox runs here compare against an empty expected output, so WA only means "printed something". */
function ranCleanly(verdict: string) {
  return verdict === 'AC' || verdict === 'WA';
}

function normalizeInput(text: string) {
  return text.replace(/\r\n/g, '\n').trim();
}
const codeArgs = z.object({
  language: z.enum(SOURCE_LANGUAGES),
  code: z.string().min(1),
  stdin: z.string().default(''),
});

export interface Proposal {
  kind: 'test' | 'wrong_solution';
  language: SourceLanguage;
  code: string;
  stdin?: string;
  expected?: string;
  status: 'held';
}

export interface AuditRow {
  tool: string;
  decision: GateDecision;
  args: unknown;
  model: string;
  tokens: number;
}

export interface HardenResult {
  status: 'proposals' | 'no_proposals';
  reason?: string;
  proposals: Proposal[];
  denied: string[];
  calls: number;
  tokens: number;
}

export async function harden(input: {
  provider: Provider;
  statement: string;
  samples: string;
  reference: { language: SourceLanguage; code: string };
  runSandbox: (code: string, language: SourceLanguage, stdin: string) => Promise<{ verdict: string; stdout: string }>;
  audit: (row: AuditRow) => Promise<void>;
  monthlyUsed?: number;
  monthlyCap?: number;
  existingInputs?: string[];
}): Promise<HardenResult> {
  const proposals: Proposal[] = [];
  const denied: string[] = [];
  const seen = new Set((input.existingInputs ?? []).map(normalizeInput));
  let calls = 0;
  let tokens = input.monthlyUsed ?? 0;
  const cap = input.monthlyCap ?? 200_000;
  const notes: string[] = [];

  while (calls < MAX_CALLS) {
    if (tokens >= cap) return { status: 'no_proposals', reason: 'budget', proposals, denied, calls, tokens };
    const prompt = [
      'Reply with one JSON object {"tool","args","claim"}.',
      'Tools: read_problem, run_in_sandbox, propose_test, propose_wrong_solution.',
      'propose_test args: {"language","code","stdin"}. Leave stdin empty to make code a generator whose output is the test input.',
      'Do not publish or edit tests.',
      `Statement: ${input.statement}`,
      `Samples: ${input.samples}`,
      notes.join('\n'),
    ].join('\n');
    let response;
    try {
      response = await input.provider.complete(prompt);
    } catch {
      return { status: 'no_proposals', reason: 'provider', proposals, denied, calls, tokens };
    }
    calls += 1;
    tokens += response.tokens;
    if (response.timedOut || !response.turn) {
      return {
        status: proposals.length ? 'proposals' : 'no_proposals',
        reason: response.timedOut ? 'timeout' : proposals.length ? undefined : 'no_proposals',
        proposals,
        denied,
        calls,
        tokens,
      };
    }
    const decision = gateTool(response.turn.tool);
    await input.audit({
      tool: response.turn.tool,
      decision,
      args: response.turn.args,
      model: input.provider.name,
      tokens: response.tokens,
    });
    if (decision === 'deny') {
      denied.push(response.turn.tool);
      notes.push(`denied ${response.turn.tool}`);
      continue;
    }
    if (response.turn.tool === 'read_problem') {
      notes.push('problem text already in the prompt; hidden tests are not available');
      continue;
    }
    const parsed = codeArgs.safeParse(response.turn.args);
    if (!parsed.success) {
      notes.push('invalid tool arguments');
      continue;
    }
    if (response.turn.tool === 'run_in_sandbox') {
      const ran = await input.runSandbox(parsed.data.code, parsed.data.language, parsed.data.stdin);
      notes.push(`sandbox ${ran.verdict} (model claim ignored: ${response.turn.claim ?? 'none'})`);
      continue;
    }
    if (response.turn.tool === 'propose_test') {
      let stdin = parsed.data.stdin;
      if (stdin === '') {
        const generated = await input.runSandbox(parsed.data.code, parsed.data.language, '');
        if (!ranCleanly(generated.verdict) || generated.stdout.trim() === '' || generated.stdout.length > MAX_INPUT) {
          notes.push('discarded test: the generator did not produce an input');
          continue;
        }
        stdin = generated.stdout;
      }
      if (seen.has(normalizeInput(stdin))) {
        notes.push('discarded test: that input already exists');
        continue;
      }
      const expected = await input.runSandbox(input.reference.code, input.reference.language, stdin);
      if (!ranCleanly(expected.verdict)) {
        notes.push('discarded test: reference failed');
        continue;
      }
      seen.add(normalizeInput(stdin));
      proposals.push({
        kind: 'test',
        language: parsed.data.language,
        code: parsed.data.code,
        stdin,
        expected: expected.stdout,
        status: 'held',
      });
      continue;
    }
    if (response.turn.tool === 'propose_wrong_solution') {
      const sample = await input.runSandbox(parsed.data.code, parsed.data.language, parsed.data.stdin || input.samples);
      if (sample.verdict === 'CE' || sample.verdict === 'RE') {
        notes.push('discarded wrong solution: it does not run');
        continue;
      }
      proposals.push({
        kind: 'wrong_solution',
        language: parsed.data.language,
        code: parsed.data.code,
        status: 'held',
      });
    }
  }
  return { status: proposals.length ? 'proposals' : 'no_proposals', proposals, denied, calls, tokens };
}
