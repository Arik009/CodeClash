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
  rating: number;
  streak: number;
  days: string[];
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

  const rating = me?.rating ?? session.user.rating ?? 1200;
  const delta = rating - 1200;

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
        <Box title="rating">
          <div className="rating-hero">
            <b className="num">{rating}</b>
            <span className={delta >= 0 ? 'ok' : 'bad'}>{delta >= 0 ? '+' : ''}{delta}</span>
          </div>
          <div className="rate-track" aria-hidden>
            <span style={{ width: `${Math.max(6, Math.min(100, ((rating - 100) / 2300) * 100))}%` }} />
            <i style={{ left: `${((1200 - 100) / 2300) * 100}%` }} />
          </div>
          <p className="muted small">Contest Elo. New accounts start at 1200. The mark on the bar is that start.</p>
        </Box>

        <Box title="streak">
          <div className="rating-hero">
            <b className="num">{me?.streak ?? 0}</b>
            <span className="muted">day{(me?.streak ?? 0) === 1 ? '' : 's'}</span>
          </div>
          <Heatmap days={me?.days ?? []} />
          <p className="muted small">Consecutive days with an accepted solution, counting back from today or yesterday. Filled cells are days you solved something.</p>
        </Box>

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

function Heatmap({ days }: { days: string[] }) {
  const solved = new Set(days);
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  const start = new Date(end);
  start.setUTCDate(end.getUTCDate() - end.getUTCDay() - 15 * 7);
  const cells: { key: string; on: boolean }[] = [];
  for (const cursor = new Date(start); cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const key = cursor.toISOString().slice(0, 10);
    cells.push({ key, on: solved.has(key) });
  }
  return (
    <div className="heat" role="img" aria-label={`${solved.size} days with an accepted solution`}>
      {cells.map((cell) => <i key={cell.key} className={cell.on ? 'on' : ''} title={cell.key} />)}
    </div>
  );
}
