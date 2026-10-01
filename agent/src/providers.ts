import { z } from 'zod';

export const turnSchema = z.object({
  tool: z.string(),
  args: z.record(z.unknown()).default({}),
  claim: z.string().optional(),
});

export type ModelTurn = z.infer<typeof turnSchema>;

export interface Provider {
  name: string;
  complete(prompt: string): Promise<{ turn: ModelTurn | null; tokens: number; timedOut?: boolean }>;
}

export class FakeProvider implements Provider {
  name = 'fake';
  constructor(private readonly turns: Array<ModelTurn | 'timeout' | 'invalid'>) {}
  async complete(): Promise<{ turn: ModelTurn | null; tokens: number; timedOut?: boolean }> {
    const next = this.turns.shift();
    if (next === 'timeout' || next === undefined) return { turn: null, tokens: 0, timedOut: next === 'timeout' };
    if (next === 'invalid') return { turn: { tool: '', args: { code: 1 } }, tokens: 1 };
    return { turn: next, tokens: 12 };
  }
}

export function parseModelText(text: string): ModelTurn | null {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    const parsed = turnSchema.safeParse(JSON.parse(text.slice(start, end + 1)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function geminiProvider(apiKey: string, model: string): Provider {
  return {
    name: `gemini:${model}`,
    async complete(prompt: string) {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        },
      );
      if (!response.ok) throw new Error(`Gemini ${response.status}`);
      const body = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { totalTokenCount?: number } };
      const text = body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('\n') ?? '';
      return { turn: parseModelText(text), tokens: body.usageMetadata?.totalTokenCount ?? 0 };
    },
  };
}

export function haikuProvider(apiKey: string, model: string): Provider {
  return {
    name: `anthropic:${model}`,
    async complete(prompt: string) {
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({ model, max_tokens: 800, messages: [{ role: 'user', content: prompt }] }),
      });
      if (!response.ok) throw new Error(`Anthropic ${response.status}`);
      const body = await response.json() as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      const text = body.content?.map((c) => c.text ?? '').join('\n') ?? '';
      const tokens = (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0);
      return { turn: parseModelText(text), tokens };
    },
  };
}

/** The input half of a "Input ... Output ..." sample block, or the whole text. */
export function sampleInput(samples: string) {
  const text = samples.replace(/\r\n/g, '\n');
  const match = /^\s*input\s*\n([\s\S]*?)\n\s*output\s*\n/i.exec(text);
  return (match ? match[1]! : text).trim();
}

/** The sample with its last integer negated (0 becomes 1), or null when it has no integer. */
export function negateLastNumber(input: string) {
  const matches = [...input.matchAll(/-?\d+/g)];
  const last = matches.at(-1);
  if (!last || last.index === undefined) return null;
  const value = Number(last[0]);
  const replaced = value === 0 ? '1' : String(-value);
  return `${input.slice(0, last.index)}${replaced}${input.slice(last.index + last[0].length)}`;
}

/**
 * Offline stand-in for a model. It works from the problem's own sample: a generator that
 * re-spaces the sample input, a sign-flip edge case, and a solution that echoes the first
 * token, which the publish check should reject.
 */
export function scriptedProvider(samples: string): Provider {
  const input = sampleInput(samples) || '1';
  const respaced = `${input.split('\n').map((line) => line.trim().split(/\s+/).join('   ')).join('\n')}\n\n`;
  const negated = negateLastNumber(input);
  return new FakeProvider([
    { tool: 'read_problem', args: {} },
    { tool: 'propose_test', args: { language: 'python', code: `print(${JSON.stringify(respaced)}, end="")\n`, stdin: '' } },
    ...(negated ? [{ tool: 'propose_test', args: { language: 'python', code: 'edge case: sign flip', stdin: `${negated}\n` } }] : []),
    {
      tool: 'propose_wrong_solution',
      args: { language: 'python', code: 'import sys\nprint(sys.stdin.read().split()[0])\n', stdin: `${input}\n` },
    },
  ]);
}

export function providerFromEnv(context: { samples?: string } = {}): Provider {
  const choice = process.env.AGENT_PROVIDER ?? 'fake';
  if (choice === 'gemini' && process.env.GEMINI_API_KEY) {
    return geminiProvider(process.env.GEMINI_API_KEY, process.env.GEMINI_MODEL ?? 'gemini-2.0-flash');
  }
  if (choice === 'haiku' && process.env.ANTHROPIC_API_KEY) {
    return haikuProvider(process.env.ANTHROPIC_API_KEY, process.env.ANTHROPIC_MODEL ?? 'claude-3-5-haiku-latest');
  }
  return scriptedProvider(context.samples ?? '');
}
