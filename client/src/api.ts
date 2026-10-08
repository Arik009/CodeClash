async function readError(response: Response) {
  const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
  return new Error(body.error ?? response.statusText);
}

export const OFFLINE = 'Cannot reach the server. Is `npm run dev` running?';

export function isAbort(error: unknown) {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** Reads are retried once, since a dev server restart drops the connection for a moment. */
async function send(path: string, init: RequestInit) {
  const read = !init.method || init.method === 'GET';
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetch(path, init);
    } catch (error) {
      if (isAbort(error)) throw error;
      if (!read || attempt > 0) throw new Error(OFFLINE);
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  const response = await send(path, { ...init, headers });
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
