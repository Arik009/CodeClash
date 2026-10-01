import { ArrowRight, Radio, ShieldCheck, Trophy, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatLeft, useNow } from '../ui';

interface Contest { id: string; title: string; status: string; startsAt: string; endsAt: string; reserved: number; capacity: number }

export function Home({ signedIn }: { signedIn: boolean }) {
  const [contests, setContests] = useState<Contest[]>([]);
  const now = useNow(1000);
  useEffect(() => { api<Contest[]>('/api/contests').then(setContests).catch(() => {}); }, []);
  const live = contests.find((c) => c.status === 'running' || c.status === 'frozen');
  const next = contests.find((c) => c.status === 'registration_open');

  return (
    <div className="page">
      <section className="hero">
        <div>
          <p className="eyebrow">// live coding &amp; quiz contests</p>
          <h1>Seats. Verdicts.<br /><span className="accent">Rank.</span></h1>
          <p className="lead prose">
            Reserve a seat, solve problems in the browser, answer timed quiz rounds, and watch the standings move as verdicts land.
          </p>
          <div className="row">
            <Link className="btn primary lg" to={signedIn ? '/arena' : '/auth'}>{signedIn ? 'enter the arena' : 'sign in to compete'} <ArrowRight size={16} /></Link>
            <Link className="btn lg" to="/problemset">browse problems</Link>
          </div>
        </div>
        <div className="terminal" aria-hidden>
          <div className="terminal-top"><i /><i /><i /><span>~/contest/warmup</span></div>
          <pre>
            <span className="muted">$</span> codeclash submit A.py{'\n'}
            <span className="muted">  queued → judge slot 2</span>{'\n'}
            <span className="muted">  test 1</span> <span className="ok">ok</span>  <span className="muted">test 2</span> <span className="ok">ok</span>  <span className="muted">test 3</span> <span className="ok">ok</span>{'\n'}
            <span className="ok">  ✓ Accepted</span> <span className="muted">· 48 ms · 9 MB</span>{'\n'}
            <span className="muted">$</span> codeclash submit B.js{'\n'}
            <span className="bad">  ✗ Wrong answer on test 2</span>{'\n'}
            <span className="muted">$</span> codeclash standings{'\n'}
            <span className="accent">  #1</span> you   <span className="ok">+ +1 -2</span>   penalty 41{'\n'}
            <span className="muted">$</span> <span className="cursor" />
          </pre>
        </div>
      </section>

      {live || next ? (
        <div className="live-strip">
          <span className={`pill ${live ? 'live' : 'upcoming'}`}>{live ? 'live now' : 'next up'}</span>
          <strong className="grow">{(live ?? next)!.title}</strong>
          <span className="muted num">
            {live ? `ends in ${formatLeft(new Date(live.endsAt).getTime() - now)}` : `starts in ${formatLeft(new Date(next!.startsAt).getTime() - now)}`}
          </span>
          <Link className="btn primary sm" to={`/arena/${(live ?? next)!.id}`}>{live ? 'enter' : 'register'} <ArrowRight size={14} /></Link>
        </div>
      ) : null}

      <section className="features" aria-label="What you get">
        <div className="feature"><ShieldCheck size={20} /><h3>Sandboxed judge</h3><p>Every submission runs in an isolated container with no network, hard time and memory limits.</p></div>
        <div className="feature"><Trophy size={20} /><h3>Live standings</h3><p>ICPC-style penalty with per-problem cells, a freeze near the end, and your row always highlighted.</p></div>
        <div className="feature"><Radio size={20} /><h3>Quiz rounds</h3><p>Timed questions pushed to everyone at once. Faster correct answers score more.</p></div>
      </section>
      <p className="muted small row"><Zap size={13} /> tip: the palette icon in the header switches the theme. There are twenty.</p>
    </div>
  );
}
