import { ArrowRight, Eye, EyeOff } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, loadSession, type Session } from '../api';
import { Alert, errorText, toast } from '../ui';

export function Auth({ onSession }: { onSession: (session: Session) => void }) {
  const pending = loadSession();
  const [mode, setMode] = useState<'login' | 'register' | 'verify'>(pending?.user.emailVerified === false ? 'verify' : 'login');
  const [token, setToken] = useState(pending?.verifyToken ?? '');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? '/';

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const path = mode === 'login' ? '/api/auth/login' : '/api/auth/register';
      const session = await api<Session & { verifyToken?: string }>(path, {
        method: 'POST',
        body: JSON.stringify(mode === 'login' ? { email, password } : { email, password, displayName }),
      });
      onSession(session);
      if (session.user.emailVerified === false) {
        setToken(session.verifyToken ?? '');
        setMode('verify');
        toast('Confirm your email before competing', 'warn');
        return;
      }
      toast(`Welcome${session.user.displayName ? `, ${session.user.displayName}` : ''}`, 'ok');
      navigate(from);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  async function confirm(event: FormEvent) {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api('/api/auth/verify', { method: 'POST', body: JSON.stringify({ token }) });
      const current = await api<{ id: string; role: string; displayName: string; emailVerified: boolean; rating: number }>('/api/me');
      const stored = loadSession();
      if (stored) onSession({ ...stored, user: { id: current.id, role: current.role, displayName: current.displayName, emailVerified: true, rating: current.rating } });
      toast('Email confirmed', 'ok');
      navigate(from);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page narrow">
      <div className="auth-card">
        {mode === 'verify' ? (
          <>
            <h1>Confirm your email</h1>
            <p className="muted small">A seat, a submission, or a quiz answer needs a confirmed email. This machine has no mail server, so the link is shown here.</p>
            <form onSubmit={confirm}>
              <label htmlFor="token">Verification token</label>
              <input id="token" value={token} onChange={(e) => setToken(e.target.value)} required autoComplete="one-time-code" />
              {error ? <Alert>{error}</Alert> : null}
              <button className="btn primary lg" type="submit" disabled={busy} style={{ width: '100%', marginTop: 'var(--space-4)' }}>
                {busy ? 'please wait…' : 'Confirm email'} <ArrowRight size={16} />
              </button>
            </form>
          </>
        ) : null}
        {mode === 'verify' ? null : (<>
        <div className="segmented" role="tablist" aria-label="Account">
          <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => { setMode('login'); setError(''); }}>sign in</button>
          <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => { setMode('register'); setError(''); }}>create account</button>
        </div>
        <h1>{mode === 'login' ? 'Welcome back' : 'Join CodeClash'}</h1>
        <p className="muted small">{mode === 'login' ? 'Sign in to reserve seats and submit.' : 'One account, one seat per contest.'}</p>
        <form onSubmit={submit}>
          {mode === 'register' ? (
            <>
              <label htmlFor="name">Display name</label>
              <input id="name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} required maxLength={40} autoComplete="nickname" placeholder="shown on the standings" />
            </>
          ) : null}
          <label htmlFor="email">Email</label>
          <input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" autoFocus placeholder="you@example.com" />
          <label htmlFor="password">Password</label>
          <div className="password">
            <input
              id="password"
              type={reveal ? 'text' : 'password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
            <button type="button" className="btn ghost icon sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide password' : 'Show password'}>
              {reveal ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
          {mode === 'register' ? <p className="hint">At least 8 characters.</p> : null}
          <div style={{ marginTop: 'var(--space-5)' }}>{error ? <Alert>{error}</Alert> : null}</div>
          <button className="btn primary lg" type="submit" disabled={busy} style={{ width: '100%' }}>
            {busy ? 'please wait…' : mode === 'login' ? 'Sign in' : 'Create account'} <ArrowRight size={16} />
          </button>
        </form>
        </>)}
      </div>
    </div>
  );
}
