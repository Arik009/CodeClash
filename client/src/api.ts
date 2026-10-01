const KEY = 'codeclash.session';
export const SIGNED_OUT = 'codeclash:signed-out';

export interface Session {
  access: string;
  refresh: string;
  user: { id: string; role: string; displayName?: string; emailVerified?: boolean; rating?: number };
  /** Present in local development, where there is no mail server. */
  verifyToken?: string;
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null) {
  if (!session) localStorage.removeItem(KEY);
  else localStorage.setItem(KEY, JSON.stringify(session));
}

async function readError(response: Response) {
  const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string };
  return new Error(body.error ?? response.statusText);
}

let refreshing: Promise<Session | null> | null = null;

/** One refresh at a time: parallel 401s share it, since the server rotates the token on use. */
function refreshSession(session: Session) {
  refreshing ??= (async () => {
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ refresh: session.refresh }),
    });
    if (!response.ok) return null;
    const next = { ...session, ...(await response.json() as Partial<Session>) };
    saveSession(next);
    return next;
  })().finally(() => { refreshing = null; });
  return refreshing;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const session = loadSession();
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (session) headers.set('authorization', `Bearer ${session.access}`);
  let response = await fetch(path, { ...init, headers });
  if (response.status === 401 && session && !path.startsWith('/api/auth/')) {
    const next = await refreshSession(session);
    if (!next) {
      saveSession(null);
      window.dispatchEvent(new Event(SIGNED_OUT));
      throw new Error('Your session expired. Sign in again.');
    }
    headers.set('authorization', `Bearer ${next.access}`);
    response = await fetch(path, { ...init, headers });
  }
  if (!response.ok) throw await readError(response);
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}
