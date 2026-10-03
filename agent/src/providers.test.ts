import { afterEach, describe, expect, it } from 'vitest';
import {
  anthropicProvider, geminiProvider, openAiCompatibleProvider, postJson, providerFromEnv, ProviderError,
} from './providers.js';

const original = globalThis.fetch;
afterEach(() => { globalThis.fetch = original; });

function respond(...replies: Array<{ status: number; body?: unknown } | 'hang'>) {
  const seen: { url: string; init: RequestInit }[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    const next = replies.shift() ?? { status: 200, body: {} };
    if (next === 'hang') {
      return new Promise((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    }
    return new Response(next.body === undefined ? 'not json' : JSON.stringify(next.body), { status: next.status });
  }) as typeof fetch;
  return seen;
}

const fast = { timeoutMs: 50, retryDelayMs: 0 };

describe('postJson', () => {
  it('times out a call that does not answer', async () => {
    respond('hang');
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toMatchObject({ status: 'ERROR', message: 'The model did not answer in time' });
  });

  it('retries once on 429 and 5xx', async () => {
    const seen = respond({ status: 503 }, { status: 200, body: { ok: 1 } });
    expect(await postJson('https://x', { headers: {}, body: {} }, fast)).toEqual({ ok: 1 });
    expect(seen).toHaveLength(2);
    respond({ status: 429 }, { status: 429 });
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toMatchObject({ status: 'RATE_LIMITED' });
  });

  it('maps auth failures, other errors, and bad bodies', async () => {
    respond({ status: 401, body: {} });
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toMatchObject({ message: 'The model provider rejected the API key' });
    respond({ status: 400, body: {} });
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toMatchObject({ message: 'The model provider returned 400' });
    respond({ status: 200 });
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toThrow(ProviderError);
    globalThis.fetch = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(postJson('https://x', { headers: {}, body: {} }, fast)).rejects.toMatchObject({ message: 'The model endpoint is unreachable' });
  });
});

describe('providers', () => {
  it('reads text and tokens from each API shape', async () => {
    const seen = respond(
      { status: 200, body: { content: [{ text: 'a' }], usage: { input_tokens: 2, output_tokens: 3 } } },
      { status: 200, body: { candidates: [{ content: { parts: [{ text: 'b' }] } }], usageMetadata: { totalTokenCount: 7 } } },
      { status: 200, body: { choices: [{ message: { content: 'c' } }], usage: { total_tokens: 9 } } },
    );
    expect(await anthropicProvider('k', 'model-a', fast).complete('p')).toEqual({ text: 'a', tokens: 5 });
    expect(await geminiProvider('k', 'model-g', fast).complete('p')).toEqual({ text: 'b', tokens: 7 });
    expect(await openAiCompatibleProvider('http://localhost:11434/v1/', undefined, 'llama', fast).complete('p')).toEqual({ text: 'c', tokens: 9 });
    expect(seen[1]!.url).toContain('models/model-g:generateContent');
    expect(seen[1]!.url).not.toContain('key=');
    expect(seen[2]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(JSON.parse(String(seen[0]!.init.body)).model).toBe('model-a');
  });

  it('builds the provider from env and never assumes a model', () => {
    expect(providerFromEnv({})).toMatchObject({ provider: null, status: 'DISABLED' });
    expect(providerFromEnv({ AGENT_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: 'k' })).toMatchObject({ status: 'DISABLED', reason: 'AGENT_MODEL is not set.' });
    expect(providerFromEnv({ AGENT_PROVIDER: 'anthropic', AGENT_MODEL: 'm' }).reason).toBe('ANTHROPIC_API_KEY is not set.');
    expect(providerFromEnv({ AGENT_PROVIDER: 'anthropic', AGENT_MODEL: 'm', ANTHROPIC_API_KEY: 'k' }).provider?.name).toBe('anthropic');
    expect(providerFromEnv({ AGENT_PROVIDER: 'gemini', AGENT_MODEL: 'm', GEMINI_API_KEY: 'k' }).provider?.model).toBe('m');
    expect(providerFromEnv({ AGENT_PROVIDER: 'gemini', AGENT_MODEL: 'm' }).status).toBe('DISABLED');
    expect(providerFromEnv({ AGENT_PROVIDER: 'openai', AGENT_MODEL: 'm' }).status).toBe('DISABLED');
    expect(providerFromEnv({ AGENT_PROVIDER: 'openai', AGENT_MODEL: 'm', AGENT_BASE_URL: 'http://localhost:11434/v1' }).status).toBe('AVAILABLE');
    expect(providerFromEnv({ AGENT_PROVIDER: 'OpenAI', AGENT_MODEL: 'm', OPENAI_API_KEY: 'k' }).provider?.name).toBe('openai-compatible');
    expect(providerFromEnv({ AGENT_PROVIDER: 'mystery', AGENT_MODEL: 'm' }).reason).toMatch(/Unknown/);
    expect(providerFromEnv({ AGENT_PROVIDER: 'haiku', ANTHROPIC_MODEL: 'old', ANTHROPIC_API_KEY: 'k' }).provider?.model).toBe('old');
    expect(providerFromEnv({ AGENT_PROVIDER: 'gemini', GEMINI_MODEL: 'g', GEMINI_API_KEY: 'k' }).provider?.model).toBe('g');
  });
});
