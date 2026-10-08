import { createHash } from 'node:crypto';
import { gateTool, SOURCE_LANGUAGES, type GateDecision } from '@codeclash/shared';
import { z } from 'zod';
import { ProviderError, type Provider } from '../providers.js';
import type { AIStatus, Attack, MutationRecord, PlanContext, Planner } from './pipeline.js';

export interface AuditRow {
  tool: string;
  decision: GateDecision;
  args: unknown;
  model: string;
  tokens: number;
  reason?: string;
}

/** Code and long text go into the audit log as their first 2 KB plus a sha256 of the whole. */
export function auditArgs(value: unknown): unknown {
  if (typeof value === 'string') {
    if (value.length <= 2048) return value;
    return { text: value.slice(0, 2048), length: value.length, sha256: createHash('sha256').update(value).digest('hex') };
  }
  if (Array.isArray(value)) return value.map(auditArgs);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, auditArgs(v)]));
  return value;
}

export const attackSchema = z.object({
  type: z.enum(['wrong_solution', 'edge_case', 'performance']),
  description: z.string().min(1).max(500),
  language: z.enum(SOURCE_LANGUAGES).optional(),
  code: z.string().min(1).max(20_000).optional(),
  input: z.string().min(1).max(200_000).optional(),
  generator: z.string().min(1).max(20_000).optional(),
}).strict();

/** The first JSON object in the text, or null. Models often wrap JSON in prose or fences. */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Checks a model reply. A `tool` the gate denies, or any field outside the schema, drops that
 * part of the reply and is audited as denied.
 */
export function readAttacks(reply: unknown): { attacks: Attack[]; denied: { what: string; reason: string }[] } {
  const denied: { what: string; reason: string }[] = [];
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return { attacks: [], denied: [{ what: 'reply', reason: 'not a JSON object' }] };
  const record = reply as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key === 'attacks') continue;
    if (key === 'tool') denied.push({ what: String(record.tool), reason: `tool ${gateTool(String(record.tool)) === 'deny' ? 'is prohibited' : 'is not used here'}` });
    else denied.push({ what: key, reason: 'field is not allowed' });
  }
  const list = Array.isArray(record.attacks) ? record.attacks.slice(0, 12) : [];
  const attacks: Attack[] = [];
  for (const raw of list) {
    let candidate = raw;
    if (raw && typeof raw === 'object' && 'tool' in raw) {
      const { tool, ...rest } = raw as Record<string, unknown>;
      if (gateTool(String(tool)) === 'deny') {
        denied.push({ what: String(tool), reason: 'tool is prohibited' });
        continue;
      }
      candidate = rest;
    }
    const parsed = attackSchema.safeParse(candidate);
    if (!parsed.success) {
      denied.push({ what: 'attack', reason: parsed.error.issues.map((i) => `${i.path.join('.') || 'attack'}: ${i.message}`).join('; ') });
      continue;
    }
    if (!parsed.data.code && !parsed.data.input && !parsed.data.generator) {
      denied.push({ what: 'attack', reason: 'needs code, input, or generator' });
      continue;
    }
    attacks.push(parsed.data);
  }
  return { attacks, denied };
}

function clip(text: string, max: number) {
  return text.length > max ? `${text.slice(0, max)}\n…` : text;
}

const REPLY_SHAPE = [
  'Reply with one JSON object and nothing else: {"attacks":[...]}.',
  'Each attack: {"type":"wrong_solution"|"edge_case"|"performance","description":"...", and one of',
  '"code" (a full plausible wrong or slow solution, with "language"), "input" (a complete stdin), or',
  '"generator" (Python 3 that prints one stdin)}. At most 8 attacks. Inputs must respect the constraints.',
  'You cannot publish, edit tests, or change limits; asking to will be denied and logged.',
].join('\n');

function survivorLines(mutations: MutationRecord[]) {
  return mutations
    .filter((m) => m.diff)
    .slice(0, 12)
    .map((m) => `${m.id} (${m.operator}): - ${m.diff!.original}\n   + ${m.diff!.mutated}`)
    .join('\n');
}

export function planPrompt(context: PlanContext) {
  const survived = context.mutations.filter((m) => m.status === 'survived');
  return [
    'You are helping a problem setter find weak spots in a test suite for a programming problem.',
    `Statement:\n${clip(context.statement, 6000)}`,
    `Input spec:\n${context.spec ?? '(none)'}`,
    `Reference solution (${context.reference.language}):\n${clip(context.reference.code, 8000)}`,
    `Current tests (${context.tests.length}), first few inputs:\n${context.tests.slice(0, 4).map((t) => clip(t.input, 300)).join('\n---\n')}`,
    `Mutants of the reference that the current tests do not catch:\n${survivorLines(survived) || '(none)'}`,
    'Propose wrong solutions a contestant might plausibly write, edge-case inputs, and slow solutions that a max-size test should catch.',
    REPLY_SHAPE,
  ].join('\n\n');
}

export function feedbackPrompt(context: PlanContext, survivors: MutationRecord[]) {
  return [
    'These mutants of the reference survived every test and attack so far. Give inputs that make each one print a different answer from the reference.',
    `Input spec:\n${context.spec ?? '(none)'}`,
    `Reference (${context.reference.language}):\n${clip(context.reference.code, 8000)}`,
    `Survivors:\n${survivorLines(survivors)}`,
    REPLY_SHAPE,
  ].join('\n\n');
}

export interface PlannerOptions {
  provider: Provider;
  audit: (row: AuditRow) => Promise<void>;
  runTokenCap: number;
  monthlyUsed: number;
  monthlyCap: number;
}

/** At most two calls per run: the plan, and feedback only when mutants survive. */
export function createPlanner(options: PlannerOptions): Planner {
  let status: AIStatus = 'AVAILABLE';
  let note: string | null = null;
  let calls = 0;
  let tokens = 0;

  const ask = async (tool: 'model.plan' | 'model.feedback', prompt: string): Promise<Attack[]> => {
    if (status !== 'AVAILABLE') return [];
    if (tokens >= options.runTokenCap || options.monthlyUsed + tokens >= options.monthlyCap) {
      status = 'BUDGET_EXCEEDED';
      note = tokens >= options.runTokenCap ? 'The per-run token limit is spent.' : 'The monthly token budget is spent.';
      await options.audit({ tool, decision: 'deny', args: { promptLength: prompt.length }, model: options.provider.model, tokens: 0, reason: note });
      return [];
    }
    let reply;
    try {
      reply = await options.provider.complete(prompt);
    } catch (error) {
      status = error instanceof ProviderError ? error.status : 'ERROR';
      note = error instanceof Error ? error.message : 'The model call failed';
      await options.audit({ tool, decision: 'allow', args: { promptLength: prompt.length }, model: options.provider.model, tokens: 0, reason: note });
      return [];
    }
    calls += 1;
    tokens += reply.tokens;
    const { attacks, denied } = readAttacks(extractJson(reply.text));
    await options.audit({
      tool,
      decision: 'allow',
      args: auditArgs({ promptLength: prompt.length, attacks }),
      model: options.provider.model,
      tokens: reply.tokens,
    });
    for (const item of denied) {
      await options.audit({ tool: item.what, decision: 'deny', args: {}, model: options.provider.model, tokens: 0, reason: item.reason });
    }
    return attacks;
  };

  return {
    plan: (context) => ask('model.plan', planPrompt(context)),
    feedback: (context, survivors) => ask('model.feedback', feedbackPrompt(context, survivors)),
    summary: () => ({ status, calls, tokens, note }),
  };
}
