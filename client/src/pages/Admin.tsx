import { Plus, Search } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { Alert, Empty, errorText, StatusPill, toast } from '../ui';

interface Worker { id: string; name: string; slots: number; status: string }
interface Audit { _id: string; action: string; decision: string; actor: string; actorType?: string; target: string; at: string }
interface User { id: string; email: string; displayName: string; role: string }
type Tab = 'people' | 'workers' | 'audit';

const ROLES = ['participant', 'setter', 'organiser', 'admin'];
const DECISION_TONE: Record<string, string> = { allow: 'ok', published: 'ok', deny: 'bad', blocked: 'bad', hold: 'warn' };

export function Admin({ me }: { me: string }) {
  const [tab, setTab] = useState<Tab>('people');
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [audit, setAudit] = useState<Audit[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  const [name, setName] = useState('local-1');
  const [userQuery, setUserQuery] = useState('');
  const [auditQuery, setAuditQuery] = useState('');
  const [error, setError] = useState('');

  const loadWorkers = useCallback(() => api<Worker[]>('/api/admin/workers').then(setWorkers), []);
  const loadAudit = useCallback((q = '') => api<Audit[]>(`/api/admin/audit?q=${encodeURIComponent(q)}`).then(setAudit), []);
  const loadUsers = useCallback((q = '') => api<User[]>(`/api/admin/users?q=${encodeURIComponent(q)}`).then(setUsers), []);

  useEffect(() => {
    Promise.all([loadWorkers(), loadAudit(), loadUsers()]).catch((e) => setError(errorText(e)));
  }, [loadWorkers, loadAudit, loadUsers]);

  async function run(action: () => Promise<unknown>, done?: string) {
    setError('');
    try {
      await action();
      if (done) toast(done, 'ok');
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function register(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      await api('/api/admin/workers', { method: 'POST', body: JSON.stringify({ name, slots: 4 }) });
      await Promise.all([loadWorkers(), loadAudit(auditQuery)]);
    }, `Worker ${name} registered`);
  }

  async function workerAction(worker: Worker, action: 'drain' | 'evict') {
    if (action === 'evict' && !window.confirm(`Evict ${worker.name}? Its unfinished work moves to another worker.`)) return;
    await run(async () => {
      await api(`/api/admin/workers/${worker.id}/${action}`, { method: 'POST' });
      await Promise.all([loadWorkers(), loadAudit(auditQuery)]);
    }, `${worker.name}: ${action === 'drain' ? 'draining' : 'evicted'}`);
  }

  async function setRole(user: User, role: string) {
    await run(async () => {
      await api(`/api/admin/users/${user.id}/role`, { method: 'PUT', body: JSON.stringify({ role }) });
      await Promise.all([loadUsers(userQuery), loadAudit(auditQuery)]);
    }, `${user.displayName} is now ${role}`);
  }

  const activeSlots = workers.filter((w) => w.status === 'active').reduce((sum, w) => sum + w.slots, 0);

  return (
    <div className="page">
      <div className="page-head"><div><h1>Admin</h1><p>People and roles, judge capacity, and the append-only audit log.</p></div></div>
      {error ? <Alert>{error}</Alert> : null}

      <div className="stats">
        <div className="box stat"><b>{users.length}</b><span>people shown</span></div>
        <div className="box stat"><b className="ok">{workers.filter((w) => w.status === 'active').length}</b><span>active workers</span></div>
        <div className="box stat"><b>{activeSlots}</b><span>judge slots</span></div>
        <div className="box stat"><b>{audit.length}</b><span>recent audit rows</span></div>
      </div>

      <nav className="tabs" role="tablist" aria-label="Admin">
        {(['people', 'workers', 'audit'] as const).map((key) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} className={`tab ${tab === key ? 'on' : ''}`} onClick={() => setTab(key)}>
            {key === 'workers' ? 'judge workers' : key === 'audit' ? 'audit log' : 'people'}
          </button>
        ))}
      </nav>

      {tab === 'people' ? (
        <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => loadUsers(userQuery)); }} style={{ marginBottom: '0.9rem' }}>
            <div className="input-icon grow" style={{ maxWidth: '24rem' }}><Search size={14} /><input aria-label="Search people" placeholder="email or name" value={userQuery} onChange={(e) => setUserQuery(e.target.value)} /></div>
            <button className="btn" type="submit">search</button>
          </form>
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

      {tab === 'workers' ? (
        <>
          <form onSubmit={register} className="row" style={{ marginBottom: '0.9rem' }}>
            <input aria-label="Worker name" value={name} onChange={(e) => setName(e.target.value)} style={{ maxWidth: '18rem' }} />
            <button className="btn primary" type="submit"><Plus size={14} /> register worker</button>
          </form>
          <div className="table-wrap">
            {workers.length === 0 ? <Empty title="No workers have checked in" /> : (
              <table>
                <thead><tr><th>name</th><th>slots</th><th>status</th><th className="r">actions</th></tr></thead>
                <tbody>
                  {workers.map((w) => (
                    <tr key={w.id}>
                      <td><strong>{w.name}</strong></td>
                      <td className="num">{w.slots}</td>
                      <td><StatusPill status={w.status} /></td>
                      <td className="r">
                        <div className="row" style={{ justifyContent: 'flex-end' }}>
                          <button className="btn sm" type="button" disabled={w.status !== 'active'} onClick={() => workerAction(w, 'drain')}>drain</button>
                          <button className="btn danger sm" type="button" disabled={w.status === 'evicted'} onClick={() => workerAction(w, 'evict')}>evict</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="muted small" style={{ marginTop: '0.75rem' }}>Drain lets running work finish and takes no new jobs. Evict hands unfinished work to another worker.</p>
        </>
      ) : null}

      {tab === 'audit' ? (
        <>
          <form className="row" onSubmit={(e) => { e.preventDefault(); void run(() => loadAudit(auditQuery)); }} style={{ marginBottom: '0.9rem' }}>
            <div className="input-icon grow" style={{ maxWidth: '24rem' }}><Search size={14} /><input aria-label="Search audit" placeholder="action, actor, target or decision" value={auditQuery} onChange={(e) => setAuditQuery(e.target.value)} /></div>
            <button className="btn" type="submit">search</button>
          </form>
          <div className="table-wrap">
            {audit.length === 0 ? <Empty title="No audit rows" /> : (
              <table>
                <thead><tr><th>when</th><th>actor</th><th>action</th><th>target</th><th>decision</th></tr></thead>
                <tbody>
                  {audit.map((row) => (
                    <tr key={row._id}>
                      <td className="nowrap small num">{new Date(row.at).toLocaleString()}</td>
                      <td className="clip">{row.actorType === 'agent' ? <span className="pill accent">agent</span> : null} {row.actor}</td>
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
