import { ArrowLeft, Clock, List, Lock, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ProblemView, type Limits } from '../problem';
import { Alert, Empty, errorText, formatLeft, formatWhen, letter, StatusPill, useLanguage, useNow } from '../ui';

interface Problem { problemId: string; versionId: string; title: string; statement: string; samples: string; editorial: string | null; limits?: Limits }
interface Contest {
  id: string;
  title: string;
  type: 'coding' | 'quiz' | 'mixed';
  status: string;
  capacity: number;
  reserved: number;
  startsAt: string;
  freezeAt: string;
  endsAt: string;
  serverNow: string;
  problemCount: number;
  problems: Problem[];
}

type Tab = 'problems';

export function ContestRoom() {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'problems';
  const openLetter = params.get('p') ?? '';
  const [contest, setContest] = useState<Contest | null>(null);
  const [skew, setSkew] = useState(0);
  const [language] = useLanguage();
  const [error, setError] = useState('');
  const now = useNow(1000) + skew;

  const loadContest = useCallback(() => api<Contest>(`/api/contests/${id}`).then((c) => {
    setContest(c);
    setSkew(new Date(c.serverNow).getTime() - Date.now());
  }).catch((e) => setError(errorText(e))), [id]);

  useEffect(() => {
    void loadContest();
  }, [loadContest]);

  function go(next: { tab?: Tab; p?: string }) {
    const merged = { tab, p: openLetter, ...next };
    const entries = Object.entries(merged).filter(([key, value]) => value && !(key === 'tab' && value === 'problems'));
    setParams(Object.fromEntries(entries));
  }

  if (!contest) {
    return <div className="page">{error ? <Alert>{error}</Alert> : <div className="skeleton" style={{ height: '8rem' }} />}</div>;
  }

  const live = ['running', 'frozen'].includes(contest.status);
  const clock = countdown(contest, now);
  const problemIndex = openLetter ? openLetter.toUpperCase().charCodeAt(0) - 65 : -1;
  const problem = contest.problems[problemIndex] ?? null;

  return (
    <div className="page wide">
      <div className="crumbs"><Link to="/arena">contests</Link> / <span>{contest.title}</span></div>

      <section className="contest-bar">
        <div>
          <div className="row"><h1>{contest.title}</h1><StatusPill status={contest.status} /></div>
          <div className="meta-line">
            <span>{contest.type === 'mixed' ? 'coding + quiz' : contest.type}</span>
            <span><Users size={12} /> {contest.reserved}/{contest.capacity} seats</span>
            <span><Clock size={12} /> {formatWhen(contest.startsAt)} → {formatWhen(contest.endsAt)}</span>
          </div>
        </div>
        {clock ? (
          <div className="clock-block" aria-live="off">
            <p className="label">{clock.label}</p>
            <div className="clock">{formatLeft(clock.ms)}</div>
            {live ? <div className={`bar ${contest.status === 'frozen' ? 'warn' : 'ok'}`}><span style={{ width: `${elapsed(contest, now)}%` }} /></div> : null}
          </div>
        ) : <div className="clock-block"><p className="label">contest is over</p><div className="clock muted">final</div></div>}
      </section>

      {error ? <Alert>{error}</Alert> : null}

      <nav className="tabs" role="tablist" aria-label="Contest">
        <button type="button" role="tab" aria-selected={tab === 'problems'} className={`tab ${tab === 'problems' ? 'on' : ''}`} onClick={() => go({ tab: 'problems', p: '' })}>
          <List size={14} /> problems <span className="count">{contest.problemCount}</span>
        </button>
      </nav>

      {tab === 'problems' && !problem ? (
        contest.problems.length === 0 ? (
          contest.problemCount > 0 ? (
            <div className="locked">
              <Lock size={28} />
              <div><strong>{contest.problemCount} problems</strong> unlock when the contest starts.</div>
              {clock ? <span className="clock">{formatLeft(clock.ms)}</span> : null}
            </div>
          ) : <Empty title={contest.type === 'quiz' ? 'This is a quiz contest' : 'No problems'}>{contest.type === 'quiz' ? 'Questions appear above when the organiser opens them.' : null}</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead><tr><th style={{ width: '3.5rem' }}>#</th><th>name</th><th>limits</th></tr></thead>
              <tbody>
                {contest.problems.map((p, index) => {
                  const limit = p.limits?.[language] ?? { timeMs: 2000, memoryMb: 256 };
                  return (
                    <tr key={p.problemId}>
                      <td><span className="letter">{letter(index)}</span></td>
                      <td>
                        <button type="button" className="row-link linkbtn" onClick={() => go({ p: letter(index) })}>{p.title}</button>
                      </td>
                      <td className="muted small nowrap">{limit.timeMs / 1000} s, {limit.memoryMb} MB</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : null}

      {tab === 'problems' && problem ? (
        <>
          <div className="letters" role="tablist" aria-label="Problems">
            <button type="button" onClick={() => go({ p: '' })} aria-label="All problems" title="All problems"><ArrowLeft size={14} /></button>
            {contest.problems.map((p, index) => (
              <button
                key={p.problemId}
                type="button"
                role="tab"
                aria-selected={index === problemIndex}
                className={index === problemIndex ? 'on' : ''}
                onClick={() => go({ p: letter(index) })}
                title={p.title}
              >
                {letter(index)}
              </button>
            ))}
          </div>
          <div className="workbench">
            <ProblemView problem={problem} index={problemIndex} language={language} editorial="always" />
          </div>
        </>
      ) : null}
    </div>
  );
}

function countdown(contest: Contest, now: number) {
  const starts = new Date(contest.startsAt).getTime();
  const freezes = new Date(contest.freezeAt).getTime();
  const ends = new Date(contest.endsAt).getTime();
  if (contest.status === 'registration_open' || contest.status === 'draft') return { label: 'before start', ms: starts - now };
  if (contest.status === 'running' && freezes > now) return { label: 'until freeze', ms: freezes - now };
  if (contest.status === 'running' || contest.status === 'frozen') return { label: 'remaining', ms: ends - now };
  return null;
}

function elapsed(contest: Contest, now: number) {
  const start = new Date(contest.startsAt).getTime();
  const end = new Date(contest.endsAt).getTime();
  return Math.max(0, Math.min(100, ((now - start) / Math.max(1, end - start)) * 100));
}
