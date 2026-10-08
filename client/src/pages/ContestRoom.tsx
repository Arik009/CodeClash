import { ArrowLeft, Check, Clock, List, Lock, Trophy, UserPlus, Users } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { io } from 'socket.io-client';
import { api } from '../api';
import { CodePanel, ProblemView, type Limits } from '../problem';
import {
  Alert, Empty, errorText, formatLeft, formatWhen, LANGUAGES, letter, StatusPill, toast, useLanguage, useNow, VerdictText,
} from '../ui';

interface Cell { solved: boolean; tries: number; minute: number | null }
interface BoardRow {
  userId: string;
  displayName: string;
  solved: number;
  penalty: number;
  quizPoints: number;
  cells?: Record<string, Cell>;
}
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
interface Seat { seatId: string; status: string; position: number | null }
interface MySubmission { id: string; problemId: string; language: string; status: string; verdict: string | null; submittedAt: string }

const ACTIVE_SEAT = ['reserved', 'modified', 'competing'];
type Tab = 'problems' | 'standings' | 'mine';

export function ContestRoom({ me }: { me: string | null }) {
  const { id = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab | null) ?? 'problems';
  const openLetter = params.get('p') ?? '';
  const [contest, setContest] = useState<Contest | null>(null);
  const [skew, setSkew] = useState(0);
  const [seat, setSeat] = useState<Seat | null>(null);
  const [board, setBoard] = useState<BoardRow[]>([]);
  const [mine, setMine] = useState<MySubmission[]>([]);
  const [language, setLanguage] = useLanguage();
  const [error, setError] = useState('');
  const now = useNow(1000) + skew;

  const loadContest = useCallback(() => api<Contest>(`/api/contests/${id}`).then((c) => {
    setContest(c);
    setSkew(new Date(c.serverNow).getTime() - Date.now());
  }).catch((e) => setError(errorText(e))), [id]);
  const loadSeat = useCallback(() => (me ? api<Seat | null>(`/api/contests/${id}/seat`).then(setSeat).catch(() => {}) : Promise.resolve()), [id, me]);
  const loadMine = useCallback(() => (me ? api<MySubmission[]>(`/api/contests/${id}/submissions/mine`).then(setMine).catch(() => {}) : Promise.resolve()), [id, me]);
  const loadBoard = useCallback(() => api<BoardRow[]>(`/api/contests/${id}/leaderboard`).then(setBoard).catch(() => {}), [id]);

  useEffect(() => {
    void loadContest();
    void loadSeat();
    void loadMine();
    void loadBoard();
    const socket = io();
    socket.on('connect', () => socket.emit('join', id));
    socket.on('leaderboard', (rows: BoardRow[]) => setBoard(rows));
    socket.on('SeatChanged', () => { void loadSeat(); void loadContest(); });
    socket.on('ContestStatus', () => { void loadContest(); void loadBoard(); });
    return () => { socket.close(); };
  }, [id, loadContest, loadSeat, loadMine, loadBoard]);

  function go(next: { tab?: Tab; p?: string }) {
    const merged = { tab, p: openLetter, ...next };
    const entries = Object.entries(merged).filter(([key, value]) => value && !(key === 'tab' && value === 'problems'));
    setParams(Object.fromEntries(entries));
  }

  async function reserve() {
    setError('');
    try {
      const result = await api<{ outcome: string; position?: number }>(`/api/contests/${id}/seats`, { method: 'POST' });
      toast(result.outcome === 'waitlisted' ? `Contest is full: you are #${result.position} on the waitlist` : 'You are registered', result.outcome === 'waitlisted' ? 'warn' : 'ok');
      await Promise.all([loadSeat(), loadContest()]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  async function withdraw() {
    if (!seat || !window.confirm('Give up your seat? The next person on the waitlist takes it.')) return;
    setError('');
    try {
      await api(`/api/seats/${seat.seatId}`, { method: 'DELETE' });
      toast('Seat released', 'info');
      await Promise.all([loadSeat(), loadContest()]);
    } catch (e) {
      setError(errorText(e));
    }
  }

  if (!contest) {
    return <div className="page">{error ? <Alert>{error}</Alert> : <div className="skeleton" style={{ height: '8rem' }} />}</div>;
  }

  const live = ['running', 'frozen'].includes(contest.status);
  const hasSeat = seat ? ACTIVE_SEAT.includes(seat.status) : false;
  const canRegister = ['registration_open', 'running'].includes(contest.status);
  const clock = countdown(contest, now);
  const solved = new Set(mine.filter((s) => s.verdict === 'AC').map((s) => s.problemId));
  const tried = new Set(mine.filter((s) => s.verdict && s.verdict !== 'AC').map((s) => s.problemId));
  const problemIndex = openLetter ? openLetter.toUpperCase().charCodeAt(0) - 65 : -1;
  const problem = contest.problems[problemIndex] ?? null;
  const solvedBy = (problemId: string) => board.filter((row) => row.cells?.[problemId]?.solved).length;
  const titleOf = (problemId: string) => {
    const index = contest.problems.findIndex((p) => p.problemId === problemId);
    return index >= 0 ? `${letter(index)}. ${contest.problems[index]!.title}` : '—';
  };
  const blocked = !me ? 'sign in to submit' : !live ? 'the contest is not running' : !hasSeat ? 'register for a seat to submit' : undefined;

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
        <div className="seat-line">
          {!me ? (
            <><Link className="btn primary sm" to="/auth" state={{ from: `/arena/${id}` }}><UserPlus size={14} /> sign in to register</Link><span className="muted small">You can read the standings without an account.</span></>
          ) : seat && hasSeat ? (
            <>
              <span className="pill ok"><Check size={12} /> {seat.status === 'competing' ? 'competing' : 'registered'}</span>
              {seat.status === 'reserved' || seat.status === 'modified'
                ? <button className="btn ghost sm" type="button" onClick={withdraw}>withdraw</button>
                : null}
            </>
          ) : seat?.status === 'waitlisted' ? (
            <span className="pill warn">waitlist #{seat.position}</span>
          ) : canRegister ? (
            <><button className="btn primary sm" type="button" onClick={reserve}><UserPlus size={14} /> register</button><span className="muted small">{Math.max(0, contest.capacity - contest.reserved)} seats left</span></>
          ) : <span className="muted small">Registration is closed.</span>}
        </div>
      </section>

      {error ? <Alert>{error}</Alert> : null}

      <nav className="tabs" role="tablist" aria-label="Contest">
        <button type="button" role="tab" aria-selected={tab === 'problems'} className={`tab ${tab === 'problems' ? 'on' : ''}`} onClick={() => go({ tab: 'problems', p: '' })}>
          <List size={14} /> problems <span className="count">{contest.problemCount}</span>
        </button>
        <button type="button" role="tab" aria-selected={tab === 'standings'} className={`tab ${tab === 'standings' ? 'on' : ''}`} onClick={() => go({ tab: 'standings', p: '' })}>
          <Trophy size={14} /> standings <span className="count">{board.length}</span>
        </button>
        {me ? (
          <button type="button" role="tab" aria-selected={tab === 'mine'} className={`tab ${tab === 'mine' ? 'on' : ''}`} onClick={() => go({ tab: 'mine', p: '' })}>
            my submissions <span className="count">{mine.length}</span>
          </button>
        ) : null}
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
              <thead><tr><th style={{ width: '3.5rem' }}>#</th><th>name</th><th>limits</th><th className="r">solved by</th></tr></thead>
              <tbody>
                {contest.problems.map((p, index) => {
                  const limit = p.limits?.[language] ?? { timeMs: 2000, memoryMb: 256 };
                  return (
                    <tr key={p.problemId} className={solved.has(p.problemId) ? 'solved' : tried.has(p.problemId) ? 'tried' : ''}>
                      <td><span className="letter">{letter(index)}</span></td>
                      <td>
                        <button type="button" className="row-link linkbtn" onClick={() => go({ p: letter(index) })}>{p.title}</button>
                        {solved.has(p.problemId) ? <span className="ok small"> · solved</span> : tried.has(p.problemId) ? <span className="bad small"> · tried</span> : null}
                      </td>
                      <td className="muted small nowrap">{limit.timeMs / 1000} s, {limit.memoryMb} MB</td>
                      <td className="r num"><Users size={12} className="muted" /> × {solvedBy(p.problemId)}</td>
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
                className={`${index === problemIndex ? 'on' : ''} ${solved.has(p.problemId) ? 'solved' : tried.has(p.problemId) ? 'tried' : ''}`}
                onClick={() => go({ p: letter(index) })}
                title={p.title}
              >
                {letter(index)}
              </button>
            ))}
          </div>
          <div className="workbench">
            <ProblemView problem={problem} index={problemIndex} language={language} editorial="always" />
            <CodePanel
              key={problem.problemId}
              draftKey={`cc.draft.${id}.${problem.problemId}`}
              label={`${letter(problemIndex)} · ${problem.title}`}
              blocked={blocked}
              onLanguage={setLanguage}
              onJudged={() => { void loadMine(); }}
              run={async (lang, code) => api<{ results: { verdict: string }[] }>('/api/run', {
                method: 'POST',
                body: JSON.stringify({ problemVersionId: problem.versionId, language: lang, code, contestId: id }),
              })}
              submit={async (lang, code) => {
                const result = await api<{ id: string }>(`/api/contests/${id}/submissions`, {
                  method: 'POST',
                  headers: { 'idempotency-key': crypto.randomUUID() },
                  body: JSON.stringify({ problemVersionId: problem.versionId, language: lang, code }),
                });
                void loadMine();
                return result.id;
              }}
            />
          </div>
        </>
      ) : null}

      {tab === 'standings' ? <Standings contest={contest} board={board} me={me} /> : null}

      {tab === 'mine' ? (
        mine.length === 0 ? <Empty title="No submissions yet">Open a problem and submit with Ctrl + Enter.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>#</th><th>when</th><th>problem</th><th>lang</th><th>verdict</th></tr></thead>
              <tbody>
                {mine.map((s, index) => (
                  <tr key={s.id}>
                    <td className="muted num">{mine.length - index}</td>
                    <td className="nowrap num">{new Date(s.submittedAt).toLocaleTimeString()}</td>
                    <td>
                      <button type="button" className="row-link linkbtn" onClick={() => {
                        const index2 = contest.problems.findIndex((p) => p.problemId === s.problemId);
                        if (index2 >= 0) go({ tab: 'problems', p: letter(index2) });
                      }}>{titleOf(s.problemId)}</button>
                    </td>
                    <td className="muted">{LANGUAGES.find((item) => item.id === s.language)?.name ?? s.language}</td>
                    <td><VerdictText verdict={s.verdict} status={s.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : null}
    </div>
  );
}

function Standings({ contest, board, me }: { contest: Contest; board: BoardRow[]; me: string | null }) {
  const problems = contest.problems;
  if (board.length === 0) return <Empty icon={<Trophy size={28} />} title="No scores yet">Rows appear after the first judged submission.</Empty>;
  return (
    <>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="c" style={{ width: '3rem' }}>#</th>
              <th>who</th>
              <th className="c">=</th>
              <th className="c">penalty</th>
              {problems.map((p, index) => <th key={p.problemId} className="c upper" title={p.title}>{letter(index)}</th>)}
            </tr>
          </thead>
          <tbody>
            {board.map((row, index) => (
              <tr key={row.userId} className={row.userId === me ? 'me' : ''}>
                <td className={`c rank ${index < 3 ? 'top' : ''}`}>{index + 1}</td>
                <td><strong>{row.displayName}</strong>{row.userId === me ? <span className="muted small"> · you</span> : null}</td>
                <td className="c"><strong>{row.solved}</strong></td>
                <td className="c num muted">{row.penalty}</td>
                {problems.map((p) => <td key={p.problemId} className="c"><StandingCell cell={row.cells?.[p.problemId]} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function StandingCell({ cell }: { cell?: Cell }) {
  if (cell?.solved) {
    const minute = cell.minute ?? 0;
    return <span className="cell ok">{cell.tries ? `+${cell.tries}` : '+'}<small>{Math.floor(minute / 60)}:{String(minute % 60).padStart(2, '0')}</small></span>;
  }
  if (cell && cell.tries > 0) return <span className="cell bad">-{cell.tries}</span>;
  return null;
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
