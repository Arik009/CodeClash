import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Alert, Empty, errorText, toast } from '../ui';

interface Audit { _id: string; action: string; decision: string; actor: string; actorType?: string; target: string; at: string }
interface User { id: string; email: string; displayName: string; role: string }
type Tab = 'people' | 'audit';

const ROLES = ['participant', 'setter', 'organiser', 'admin'];
const DECISION_TONE: Record<string, string> = { allow: 'ok', published: 'ok', deny: 'bad', blocked: 'bad', hold: 'warn' };

export function Admin({ me }: { me: string }) {
  const [tab, setTab] = useState<Tab>('people');
  const [audit, setAudit] = useState<Audit[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState('');

  const loadAudit = useCallback(() => api<Audit[]>('/api/admin/audit').then(setAudit), []);
  const loadUsers = useCallback(() => api<User[]>('/api/admin/users').then(setUsers), []);

  useEffect(() => {
    Promise.all([loadAudit(), loadUsers()]).catch((e) => setError(errorText(e)));
  }, [loadAudit, loadUsers]);

  async function run(action: () => Promise<unknown>, done?: string) {
    setError('');
    try {
      await action();
      if (done) toast(done, 'ok');
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function setRole(user: User, role: string) {
    await run(async () => {
      await api(`/api/admin/users/${user.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      await Promise.all([loadUsers(), loadAudit()]);
    }, `${user.displayName} is now ${role}`);
  }

  return (
    <div className="page">
      <div className="page-head"><div><h1>Admin</h1><p>People and roles, and the append-only audit log.</p></div></div>
      {error ? <Alert>{error}</Alert> : null}

      <div className="stats">
        <div className="box stat"><b>{users.length}</b><span>people shown</span></div>
        <div className="box stat"><b>{audit.length}</b><span>recent audit rows</span></div>
      </div>

      <nav className="tabs" role="tablist" aria-label="Admin">
        {(['people', 'audit'] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}>
            {key === 'audit' ? 'audit log' : 'people'}
          </button>
        ))}
      </nav>

      {tab === 'people' ? (
        <>
          <div className="table-wrap">
            {users.length === 0 ? <Empty title="Nobody matches" /> : (
              <table>
                <thead><tr><th>name</th><th>email</th><th>role</th></tr></thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className={u.id === me ? 'me' : ''}>
                      <td><strong>{u.displayName}</strong>{u.id === me ? <span className="muted small"> · you</span> : null}</td>
                      <td className="muted">{u.email}</td>
                      <td>
                        <select aria-label={`Role for ${u.displayName}`} value={u.role} disabled={u.id === me} onChange={(e) => setRole(u, e.target.value)}>
                          {ROLES.map((role) => <option key={role} value={role}>{role}</option>)}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}

      {tab === 'audit' ? (
        <>
          <div className="table-wrap">
            {audit.length === 0 ? <Empty title="No audit rows" /> : (
              <table>
                <thead><tr><th>when</th><th>actor</th><th>action</th><th>target</th><th>decision</th></tr></thead>
                <tbody>
                  {audit.map((row) => (
                    <tr key={row._id}>
                      <td className="nowrap small num">{new Date(row.at).toLocaleString()}</td>
                      <td className="clip">{row.actor}</td>
                      <td><code>{row.action}</code></td>
                      <td className="clip muted">{row.target}</td>
                      <td><span className={`pill ${DECISION_TONE[row.decision] ?? ''}`}>{row.decision}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      ) : null}
    </div>
  );
}
