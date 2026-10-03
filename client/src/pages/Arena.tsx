import { ArrowRight, CalendarClock, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Alert, Box, Empty, errorText, formatLeft, formatLength, formatWhen, StatusPill, useNow } from '../ui';

interface Contest {
  id: string;
  title: string;
  status: string;
  capacity: number;
  reserved: number;
  type: string;
  startsAt: string;
  endsAt: string;
}

interface ArchiveItem { problemId: string; versionId: string; title: string; tags?: string[] }

const LIVE = ['running', 'frozen'];
const PAST = ['ended', 'published'];
const TYPE_LABEL: Record<string, string> = { coding: 'coding', quiz: 'quiz', mixed: 'coding + quiz' };

export function Arena() {
  const [contests, setContests] = useState<Contest[] | null>(null);
  const [archive, setArchive] = useState<ArchiveItem[]>([]);
  const [error, setError] = useState('');
  const now = useNow(1000);

  useEffect(() => {
    api<Contest[]>('/api/contests').then(setContests).catch((e) => { setError(errorText(e)); setContests([]); });
    api<{ items: ArchiveItem[] }>('/api/archive?pageSize=6').then((page) => setArchive(page.items)).catch(() => setArchive([]));
  }, []);

  const rows = contests ?? [];
  const current = rows.filter((c) => LIVE.includes(c.status) || c.status === 'registration_open');
  const past = rows.filter((c) => PAST.includes(c.status)).reverse();
  const live = rows.filter((c) => LIVE.includes(c.status));
  const next = rows.filter((c) => c.status === 'registration_open').sort((a, b) => a.startsAt.localeCompare(b.startsAt))[0];

  function when(c: Contest) {
    if (LIVE.includes(c.status)) return <span className="num">ends in {formatLeft(new Date(c.endsAt).getTime() - now)}</span>;
    const left = new Date(c.startsAt).getTime() - now;
    return <span className="num">{left > 0 ? `starts in ${formatLeft(left)}` : 'starting'}</span>;
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Contests</h1>
          <p>Register for a seat, then compete while the contest is live.</p>
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="with-side">
        <div className="stack">
          <Box title="current or upcoming contests" flush>
            {contests === null ? <div className="box-body"><div className="skeleton" /></div> : current.length === 0 ? (
              <Empty icon={<CalendarClock size={28} />} title="Nothing scheduled">Past contests and the problemset are still open.</Empty>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>name</th><th>start</th><th>length</th><th>seats</th><th>status</th><th /></tr></thead>
                  <tbody>
                    {current.map((c) => (
                      <tr key={c.id}>
                        <td>
                          <Link className="row-link" to={`/arena/${c.id}`}>{c.title}</Link>
                          <div className="muted small">{TYPE_LABEL[c.type] ?? c.type}</div>
                        </td>
                        <td className="nowrap">{formatWhen(c.startsAt)}</td>
                        <td className="num">{formatLength(new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime())}</td>
                        <td>
                          <div className="num small">{c.reserved}/{c.capacity}</div>
                          <div className="bar"><span style={{ width: `${Math.min(100, (c.reserved / Math.max(1, c.capacity)) * 100)}%` }} /></div>
                        </td>
                        <td><StatusPill status={c.status} /><div className="muted small">{when(c)}</div></td>
                        <td className="r">
                          <Link className={`btn sm ${LIVE.includes(c.status) ? 'primary' : ''}`} to={`/arena/${c.id}`}>
                            {LIVE.includes(c.status) ? 'enter' : 'register'} <ArrowRight size={13} />
                          </Link>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Box>

          <Box title="past contests" flush>
            {past.length === 0 ? <Empty title="No finished contests yet" /> : (
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead><tr><th>name</th><th>start</th><th>length</th><th>participants</th><th /></tr></thead>
                  <tbody>
                    {past.map((c) => (
                      <tr key={c.id}>
                        <td><Link className="row-link" to={`/arena/${c.id}`}>{c.title}</Link><div className="muted small">{TYPE_LABEL[c.type] ?? c.type}</div></td>
                        <td className="nowrap">{formatWhen(c.startsAt)}</td>
                        <td className="num">{formatLength(new Date(c.endsAt).getTime() - new Date(c.startsAt).getTime())}</td>
                        <td className="num">× {c.reserved}</td>
                        <td className="r"><Link className="btn sm" to={`/arena/${c.id}?tab=standings`}><Trophy size={13} /> standings</Link></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Box>
        </div>

        <aside className="side">
          {live.length > 0 ? (
            <Box title="live now">
              {live.map((c) => (
                <div key={c.id} className="stack tight">
                  <div className="row between"><strong>{c.title}</strong><StatusPill status={c.status} /></div>
                  <div className="clock" style={{ fontSize: '1.3rem' }}>{formatLeft(new Date(c.endsAt).getTime() - now)}</div>
                  <div className="bar ok"><span style={{ width: `${progress(c, now)}%` }} /></div>
                  <Link className="btn primary sm" to={`/arena/${c.id}`}>enter contest <ArrowRight size={13} /></Link>
                </div>
              ))}
            </Box>
          ) : null}
          {next ? (
            <Box title="pay attention">
              <p className="muted small" style={{ margin: 0 }}>Before contest</p>
              <strong>{next.title}</strong>
              <div className="clock" style={{ fontSize: '1.3rem' }}>{formatLeft(new Date(next.startsAt).getTime() - now)}</div>
              <Link className="btn sm" to={`/arena/${next.id}`}>register now »</Link>
            </Box>
          ) : null}
          <Box title="practice" flush action={<Link className="small" to="/problemset">all →</Link>}>
            {archive.length === 0 ? <Empty title="Archive is empty" /> : (
              <ul className="box-list">
                {archive.slice(0, 6).map((p) => (
                  <li key={p.versionId}>
                    <Link to={`/practice/${p.versionId}`}>{p.title}</Link>
                    {p.tags?.[0] ? <span className="chip">{p.tags[0]}</span> : null}
                  </li>
                ))}
              </ul>
            )}
          </Box>
        </aside>
      </div>
    </div>
  );
}

function progress(c: Contest, now: number) {
  const start = new Date(c.startsAt).getTime();
  const end = new Date(c.endsAt).getTime();
  return Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
}
