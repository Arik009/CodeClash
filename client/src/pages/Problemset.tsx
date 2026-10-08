import { BookOpenCheck, ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { Alert, Box, Empty, errorText } from '../ui';

interface ArchiveItem {
  problemId: string;
  versionId: string;
  title: string;
  tags: string[];
  difficulty: string;
  rating: number | null;
  source: string | null;
  acceptance: number | null;
  solvedCount: number;
  status: 'solved' | 'attempted' | 'unsolved';
}

interface ArchivePage { items: ArchiveItem[]; total: number; page: number; pageSize: number; tags: string[] }

const PAGE_SIZE = 25;
const TOP_TAGS = 12;

export function Problemset() {
  const [data, setData] = useState<ArchivePage | null>(null);
  const [error, setError] = useState('');
  const [allTags, setAllTags] = useState(false);
  const [params, setParams] = useSearchParams();
  const query = params.get('q') ?? '';
  const tag = params.get('tag') ?? '';
  const difficulty = params.get('difficulty') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? 1) || 1);

  useEffect(() => {
    const search = new URLSearchParams({ q: query, tag, difficulty, status, page: String(page), pageSize: String(PAGE_SIZE) });
    let cancelled = false;
    const timer = window.setTimeout(() => {
      api<ArchivePage>(`/api/archive?${search}`).then((rows) => {
        if (!cancelled) { setData(rows); setError(''); }
      }).catch((e) => {
        if (!cancelled) { setError(errorText(e)); setData({ items: [], total: 0, page: 1, pageSize: PAGE_SIZE, tags: [] }); }
      });
    }, query ? 180 : 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [query, tag, difficulty, status, page]);

  function update(next: { q?: string; tag?: string; difficulty?: string; status?: string; page?: number }) {
    const merged = { q: query, tag, difficulty, status, page: 1, ...next };
    const entries = Object.entries(merged).filter(([key, value]) => value && !(key === 'page' && value === 1));
    setParams(Object.fromEntries(entries.map(([key, value]) => [key, String(value)])), { replace: true });
  }

  const items = data?.items ?? [];
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const first = data && data.total > 0 ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? Math.min(data.total, data.page * data.pageSize) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Problemset</h1>
          <p>Problems from finished contests and the practice library, each with hidden tests and a verified reference solution.</p>
        </div>
        <div className="input-icon" style={{ width: 'min(20rem, 100%)' }}>
          <Search size={15} />
          <input type="search" aria-label="Search problems" placeholder="search by name" value={query} onChange={(e) => update({ q: e.target.value })} />
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="with-side">
        <div className="stack">
          <div className="filters">
            <div className="row" role="group" aria-label="Filter by difficulty">
              {['', 'easy', 'medium', 'hard'].map((item) => (
                <button key={item || 'all'} type="button" className={`chip ${difficulty === item ? 'on' : ''}`} onClick={() => update({ difficulty: item })}>{item || 'any difficulty'}</button>
              ))}
              <span className="filters-sep" aria-hidden />
              {['', 'solved', 'attempted', 'unsolved'].map((item) => (
                <button key={`s-${item || 'any'}`} type="button" className={`chip ${status === item ? 'on' : ''}`} onClick={() => update({ status: item })}>{item || 'any status'}</button>
              ))}
            </div>
            {data && data.tags.length > 0 ? (
              <div className="row" role="group" aria-label="Filter by tag">
                <button type="button" className={`chip ${tag === '' ? 'on' : ''}`} onClick={() => update({ tag: '' })}>all tags</button>
                {(allTags ? data.tags : data.tags.slice(0, TOP_TAGS)).map((item) => (
                  <button key={item} type="button" className={`chip ${tag === item ? 'on' : ''}`} onClick={() => update({ tag: tag === item ? '' : item })}>{item}</button>
                ))}
                {data.tags.length > TOP_TAGS ? (
                  <button type="button" className="linkbtn small accent" onClick={() => setAllTags(!allTags)}>{allTags ? 'fewer' : `+${data.tags.length - TOP_TAGS} more`}</button>
                ) : null}
              </div>
            ) : null}
          </div>
          <div className="table-wrap">
            {data === null ? <div className="box-body"><div className="skeleton" /></div> : items.length === 0 ? (
              <Empty icon={<BookOpenCheck size={28} />} title="No problem matches">Try another name, tag, or difficulty.</Empty>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th style={{ width: '4rem' }}>#</th>
                    <th>name</th>
                    <th>difficulty</th>
                    <th className="r">solved by</th>
                    <th className="r">accepted</th>
                    <th>you</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, index) => (
                    <tr key={item.versionId} className={item.status === 'solved' ? 'solved' : ''}>
                      <td className="muted num">{String(first + index).padStart(3, '0')}</td>
                      <td>
                        <Link className="row-link" to={`/practice/${item.versionId}`}>{item.title}</Link>
                        <div className="row tag-row">
                          {item.source ? <span className="muted small">{item.source}</span> : null}
                          {item.tags.map((t) => <button key={t} type="button" className={`chip ${tag === t ? 'on' : ''}`} onClick={() => update({ tag: t })}>{t}</button>)}
                        </div>
                      </td>
                      <td className="nowrap">
                        <span className={`pill ${item.difficulty === 'easy' ? 'ok' : item.difficulty === 'hard' ? 'bad' : ''}`}>{item.difficulty}</span>
                        {item.rating ? <span className="muted small num"> {item.rating}</span> : null}
                      </td>
                      <td className="r num">{item.solvedCount}</td>
                      <td className="r num">{item.acceptance === null ? '—' : `${item.acceptance}%`}</td>
                      <td className="small">{item.status === 'solved' ? 'solved' : item.status === 'attempted' ? 'tried' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          {data && data.total > 0 ? (
            <nav className="pager" aria-label="Pages">
              <span className="muted small num">{first}–{last} of {data.total}</span>
              <div className="row">
                <button type="button" className="btn sm" disabled={page <= 1} onClick={() => update({ page: page - 1 })} aria-label="Previous page"><ChevronLeft size={14} /></button>
                <span className="small num">page {data.page} / {pages}</span>
                <button type="button" className="btn sm" disabled={page >= pages} onClick={() => update({ page: page + 1 })} aria-label="Next page"><ChevronRight size={14} /></button>
              </div>
            </nav>
          ) : null}
        </div>
        <aside className="side">
          <Box title="how scoring works">
            <p className="muted small" style={{ margin: 0 }}>Run samples checks the visible examples and records nothing. Submit judges the hidden tests.</p>
          </Box>
        </aside>
      </div>
    </div>
  );
}
