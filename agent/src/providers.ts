import type { AIStatus } from './engine/pipeline.js';

export interface Completion { text: string; tokens: number }

export interface Provider {
  name: string;
  model: string;
  complete(prompt: string): Promise<Completion>;
}

/** A provider failure, already mapped to the status the dashboard shows. */
export class ProviderError extends Error {
  constructor(readonly status: Exclude<AIStatus, 'AVAILABLE' | 'DISABLED'>, message: string) {
    super(message);
  }
}

export interface CallOptions { timeoutMs?: number; retryDelayMs?: number }

const TIMEOUT_MS = 20_000;

/** One POST with a timeout and a single retry on 429 or 5xx. */
export async function postJson(url: string, init: { headers: Record<string, string>; body: unknown }, options: CallOptions = {}) {
  const attempt = async () => {
    try {
      return await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...init.headers },
        body: JSON.stringify(init.body),
        signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (error) {
      const name = error instanceof Error ? error.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') throw new ProviderError('ERROR', 'The model did not answer in time');
      throw new ProviderError('ERROR', 'The model endpoint is unreachable');
    }
  };
  let response = await attempt();
  if (response.status === 429 || response.status >= 500) {
    await new Promise((resolve) => setTimeout(resolve, options.retryDelayMs ?? 1500));
    response = await attempt();
  }
  if (response.status === 429) throw new ProviderError('RATE_LIMITED', 'The model provider is rate limiting requests');
  if (response.status === 401 || response.status === 403) throw new ProviderError('ERROR', 'The model provider rejected the API key');
  if (!response.ok) throw new ProviderError('ERROR', `The model provider returned ${response.status}`);
  try {
    return await response.json() as unknown;
  } catch {
    throw new ProviderError('ERROR', 'The model provider returned invalid JSON');
  }
}

export function anthropicProvider(apiKey: string, model: string, options: CallOptions = {}): Provider {
  return {
    name: 'anthropic',
    model,
    async complete(prompt) {
      const body = await postJson('https://api.anthropic.com/v1/messages', {
        headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
        body: { model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] },
      }, options) as { content?: { text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
      return {
        text: body.content?.map((c) => c.text ?? '').join('\n') ?? '',
        tokens: (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0),
      };
    },
  };
}

export function geminiProvider(apiKey: string, model: string, options: CallOptions = {}): Provider {
  return {
    name: 'gemini',
    model,
    async complete(prompt) {
      const body = await postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        headers: { 'x-goog-api-key': apiKey },
        body: { contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseMimeType: 'application/json' } },
      }, options) as { candidates?: { content?: { parts?: { text?: string }[] } }[]; usageMetadata?: { totalTokenCount?: number } };
      return {
        text: body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('\n') ?? '',
        tokens: body.usageMetadata?.totalTokenCount ?? 0,
      };
    },
  };
}

/** OpenAI's chat completions shape, which also covers local servers such as Ollama. */
export function openAiCompatibleProvider(baseUrl: string, apiKey: string | undefined, model: string, options: CallOptions = {}): Provider {
  return {
    name: 'openai-compatible',
    model,
    async complete(prompt) {
      const body = await postJson(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
        body: { model, messages: [{ role: 'user', content: prompt }] },
      }, options) as { choices?: { message?: { content?: string } }[]; usage?: { total_tokens?: number } };
      return { text: body.choices?.[0]?.message?.content ?? '', tokens: body.usage?.total_tokens ?? 0 };
    },
  };
}

/** Replays canned replies; used by tests and the offline demo. */
export class FakeProvider implements Provider {
  name = 'fake';
  model = 'scripted';
  constructor(private readonly replies: Array<string | Error>) {}
  async complete(): Promise<Completion> {
    const next = this.replies.shift();
    if (next === undefined) return { text: '{"attacks":[]}', tokens: 1 };
    if (next instanceof Error) throw next;
    return { text: next, tokens: 40 };
  }
}

export interface ProviderConfig { provider: Provider | null; status: AIStatus; reason: string | null }

/**
 * `AGENT_PROVIDER` is anthropic, gemini, or openai, and `AGENT_MODEL` names the model; nothing
 * is assumed. Missing pieces leave the agent in deterministic mode.
 */
export function providerFromEnv(env: NodeJS.ProcessEnv = process.env, options: CallOptions = {}): ProviderConfig {
  const choice = (env.AGENT_PROVIDER ?? '').trim().toLowerCase();
  const legacy = choice === 'gemini' ? env.GEMINI_MODEL : choice === 'anthropic' || choice === 'haiku' ? env.ANTHROPIC_MODEL : undefined;
  const model = (env.AGENT_MODEL || legacy || '').trim();
  if (!choice || choice === 'none' || choice === 'fake') return { provider: null, status: 'DISABLED', reason: 'No AGENT_PROVIDER is set.' };
  if (!model) return { provider: null, status: 'DISABLED', reason: 'AGENT_MODEL is not set.' };
  if (choice === 'anthropic' || choice === 'haiku') {
    return env.ANTHROPIC_API_KEY
      ? { provider: anthropicProvider(env.ANTHROPIC_API_KEY, model, options), status: 'AVAILABLE', reason: null }
      : { provider: null, status: 'DISABLED', reason: 'ANTHROPIC_API_KEY is not set.' };
  }
  if (choice === 'gemini') {
    return env.GEMINI_API_KEY
      ? { provider: geminiProvider(env.GEMINI_API_KEY, model, options), status: 'AVAILABLE', reason: null }
      : { provider: null, status: 'DISABLED', reason: 'GEMINI_API_KEY is not set.' };
  }
  if (choice === 'openai') {
    const baseUrl = env.AGENT_BASE_URL || 'https://api.openai.com/v1';
    const key = env.OPENAI_API_KEY || env.AGENT_API_KEY;
    if (!key && !env.AGENT_BASE_URL) return { provider: null, status: 'DISABLED', reason: 'OPENAI_API_KEY is not set.' };
    return { provider: openAiCompatibleProvider(baseUrl, key, model, options), status: 'AVAILABLE', reason: null };
  }
  return { provider: null, status: 'DISABLED', reason: `Unknown AGENT_PROVIDER "${choice}".` };
}
