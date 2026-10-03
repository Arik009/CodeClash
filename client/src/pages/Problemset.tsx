import { BookOpenCheck, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Box, Empty, errorText } from '../ui';

interface ArchiveItem {
  problemId: string;
  versionId: string;
  title: string;
  tags?: string[];
  editorial?: string;
  difficulty?: string;
  acceptance?: number | null;
  status?: 'solved' | 'attempted' | 'unsolved';
}

interface Me { rating: number; streak: number; emailVerified: boolean }

export function Problemset() {
  const [items, setItems] = useState<ArchiveItem[] | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState('');
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const difficulty = params.get('difficulty') ?? '';
  const status = params.get('status') ?? '';

  useEffect(() => {
    const search = new URLSearchParams({ q: query, difficulty, status });
    let cancelled = false;
    api<ArchiveItem[]>(`/api/archive?${search}`).then((rows) => {
      if (!cancelled) setItems(rows);
    }).catch((e) => {
      if (!cancelled) { setError(errorText(e)); setItems([]); }
    });
    return () => { cancelled = true; };
  }, [query, difficulty, status]);

  useEffect(() => {
    api<Me>('/api/me').then(setMe).catch(() => setMe(null));
  }, []);

  const tags = useMemo(() => [...new Set((items ?? []).flatMap((item) => Array.isArray(item.tags) ? item.tags : []))].sort(), [items]);
  const shown = (items ?? []).filter((item) => !tag || (Array.isArray(item.tags) && item.tags.includes(tag)));

  function update(next: { q?: string; tag?: string; difficulty?: string; status?: string }) {
    const merged = { q: query, tag, difficulty, status, ...next };
    setParams(Object.fromEntries(Object.entries(merged).filter(([, value]) => value)), { replace: true });
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Problemset</h1>
          <p>Problems from finished contests, plus practice problems that were never in a live round.</p>
        </div>
        <div className="input-icon" style={{ width: 'min(20rem, 100%)' }}>
          <Search size={15} />
          <input type="search" aria-label="Search problems" placeholder="search by name" value={query} onChange={(e) => update({ q: e.target.value })} />
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="with-side">
        <div>
          <div className="row" style={{ marginBottom: '0.6rem' }} role="group" aria-label="Filter by difficulty">
            {['', 'easy', 'medium', 'hard'].map((item) => (
              <button key={item || 'all'} type="button" className={`chip ${difficulty === item ? 'on' : ''}`} onClick={() => update({ difficulty: item })}>{item || 'any difficulty'}</button>
            ))}
            {['', 'solved', 'attempted', 'unsolved'].map((item) => (
              <button key={`s-${item || 'any'}`} type="button" className={`chip ${status === item ? 'on' : ''}`} onClick={() => update({ status: item })}>{item || 'any status'}</button>
            ))}
          </div>
          {tags.length > 0 ? (
            <div className="row" style={{ marginBottom: '1rem' }} role="group" aria-label="Filter by tag">
              <button type="button" className={`chip ${tag === '' ? 'on' : ''}`} onClick={() => update({ tag: '' })}>all tags</button>
              {tags.map((item) => (
                <button key={item} type="button" className={`chip ${tag === item ? 'on' : ''}`} onClick={() => update({ tag: tag === item ? '' : item })}>{item}</button>
              ))}
            </div>
          ) : null}
          <div className="table-wrap">
            {items === null ? <div className="box-body"><div className="skeleton" /></div> : shown.length === 0 ? (
              <Empty icon={<BookOpenCheck size={28} />} title="No problem matches">Try another name, tag, or difficulty. Live contest problems stay hidden until results are published.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '4rem' }}>#</th>
                    <th>name</th>
                    <th>difficulty</th>
                    <th className="r">accepted</th>
                    <th>you</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((item, index) => (
                    <tr key={item.versionId} className={item.status === 'solved' ? 'solved' : ''}>
                      <td className="muted num">{String(index + 1).padStart(3, '0')}</td>
                      <td>
                        <Link className="row-link" to={`/practice/${item.versionId}`}>{item.title}</Link>
                        <div className="row" style={{ gap: '0.3rem', marginTop: '0.25rem' }}>
                          {(Array.isArray(item.tags) ? item.tags : []).map((t) => <button key={t} type="button" className={`chip ${tag === t ? 'on' : ''}`} onClick={() => update({ tag: t })}>{t}</button>)}
                        </div>
                      </td>
                      <td><span className={`pill ${item.difficulty === 'easy' ? 'ok' : item.difficulty === 'hard' ? 'bad' : ''}`}>{item.difficulty ?? 'medium'}</span></td>
                      <td className="r num">{item.acceptance === null || item.acceptance === undefined ? '—' : `${item.acceptance}%`}</td>
                      <td className="small">{item.status === 'solved' ? 'solved' : item.status === 'attempted' ? 'tried' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
        <aside className="side">
          <Box title="your record">
            {me ? (
              <div className="stack" style={{ gap: '0.4rem' }}>
                <div className="row between"><span className="muted small">rating</span><b className="num">{me.rating}</b></div>
                <div className="row between"><span className="muted small">solve streak</span><b className="num">{me.streak} day{me.streak === 1 ? '' : 's'}</b></div>
                <Link className="small" to="/profile">profile</Link>
              </div>
            ) : <p className="muted small" style={{ margin: 0 }}>Sign in to see your rating and streak. Anyone can browse.</p>}
          </Box>
          <Box title="how scoring works">
            <p className="muted small" style={{ margin: 0 }}>Run samples checks the visible examples and records nothing. Submit judges the hidden tests. A problem with subtasks keeps the points of every group you fully solve.</p>
          </Box>
        </aside>
      </div>
    </div>
  );
}
