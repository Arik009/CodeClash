import { Eye, EyeOff, LogOut } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { api, type Session } from '../api';
import { Alert, Box, errorText, toast } from '../ui';

interface Me {
  id: string;
  role: string;
  displayName: string;
  email: string;
  emailVerified: boolean;
}

export function Profile({ session, onSession, onSignOut }: {
  session: Session;
  onSession: (session: Session) => void;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState(session.user.displayName ?? '');
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [reveal, setReveal] = useState(false);
  const [working, setWorking] = useState('');

  useEffect(() => {
    api<Me>('/api/me').then((row) => { setMe(row); setName(row.displayName); }).catch((e) => setError(errorText(e)));
  }, []);

  async function saveName(event: FormEvent) {
    event.preventDefault();
    setWorking('name');
    setError('');
    try {
      const updated = await api<Me>('/api/me', { method: 'PATCH', body: JSON.stringify({ displayName: name.trim() }) });
      setMe((prev) => prev ? { ...prev, displayName: updated.displayName } : prev);
      onSession({ ...session, user: { ...session.user, displayName: updated.displayName } });
      toast('Name updated', 'ok');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking('');
    }
  }

  async function savePassword(event: FormEvent) {
    event.preventDefault();
    if (next !== again) { setError('The new passwords do not match'); return; }
    setWorking('password');
    setError('');
    try {
      await api('/api/me/password', { method: 'POST', body: JSON.stringify({ current, next }) });
      setCurrent('');
      setNext('');
      setAgain('');
      toast('Password updated', 'ok');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setWorking('');
    }
  }

  return (
    <div className="page profile-page">
      <div className="page-head">
        <div>
          <h1>Profile</h1>
          <p>{me?.email ?? 'Your account'}</p>
        </div>
        <button className="btn" type="button" onClick={onSignOut}><LogOut size={14} /> sign out</button>
      </div>
      {error ? <Alert>{error}</Alert> : null}

      <div className="profile-grid">
        <Box title="name">
          <form onSubmit={saveName}>
            <label htmlFor="display-name">Shown on standings</label>
            <input id="display-name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={40} autoComplete="nickname" />
            <div className="create-actions">
              <button className="btn primary" type="submit" disabled={working !== '' || name.trim() === (me?.displayName ?? '')}>
                {working === 'name' ? 'saving…' : 'save name'}
              </button>
            </div>
          </form>
        </Box>

        <Box title="password">
          <form onSubmit={savePassword}>
            <label htmlFor="current-password">Current password</label>
            <input id="current-password" type={reveal ? 'text' : 'password'} value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" />
            <label htmlFor="new-password">New password</label>
            <div className="password">
              <input id="new-password" type={reveal ? 'text' : 'password'} value={next} onChange={(e) => setNext(e.target.value)} required minLength={8} autoComplete="new-password" />
              <button type="button" className="btn ghost icon sm" onClick={() => setReveal((v) => !v)} aria-label={reveal ? 'Hide passwords' : 'Show passwords'}>
                {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <label htmlFor="again-password">Repeat new password</label>
            <input id="again-password" type={reveal ? 'text' : 'password'} value={again} onChange={(e) => setAgain(e.target.value)} required minLength={8} autoComplete="new-password" />
            <div className="create-actions">
              <button className="btn primary" type="submit" disabled={working !== ''}>{working === 'password' ? 'saving…' : 'change password'}</button>
            </div>
          </form>
        </Box>
      </div>
    </div>
  );
}
