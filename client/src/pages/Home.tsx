import { ArrowRight, BadgeCheck, Radio, ShieldCheck, Trophy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { formatLeft, LANGUAGES, useNow } from '../ui';

interface Contest { id: string; title: string; status: string; startsAt: string; endsAt: string; reserved: number; capacity: number }
interface Stats { problems: number; participants: number; contests: number; submissions: number; languages: number }

const STEPS = [
  { title: 'Reserve a seat', body: 'Contests open registration ahead of time. Seats are limited, and a waitlist moves up automatically when someone withdraws.' },
  { title: 'Solve in the browser', body: 'Read the statement, run the samples, and submit in any supported language. Verdicts arrive within seconds.' },
  { title: 'Climb the standings', body: 'Rankings follow ICPC rules with a freeze before the end. Ratings update once the organisers publish the results.' },
];

export function Home({ signedIn }: { signedIn: boolean }) {
  const [contests, setContests] = useState<Contest[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const now = useNow(1000);
  useEffect(() => {
    api<Contest[]>('/api/contests').then(setContests).catch(() => {});
    api<Stats>('/api/stats').then((row) => { if (typeof row?.problems === 'number') setStats(row); }).catch(() => {});
  }, []);
  const live = contests.find((c) => c.status === 'running' || c.status === 'frozen');
  const next = contests.find((c) => c.status === 'registration_open');
  const featured = live ?? next;

  return (
    <div className="page landing">
      <section className="hero">
        <div>
          <p className="eyebrow">// competitive programming, judged live</p>
          <h1>Code. Compete.<br /><span className="accent">Conquer.</span></h1>
          <p className="lead prose">
            CodeClash hosts timed programming contests with a sandboxed judge, live standings and quiz rounds,
            alongside a practice archive of verified problems. Register for a seat, solve in the browser, and earn
            a rating that reflects how you perform against the field.
          </p>
          <div className="row">
            <Link className="btn primary lg" to={signedIn ? '/arena' : '/auth'}>{signedIn ? 'Enter the arena' : 'Create a free account'} <ArrowRight size={16} /></Link>
            <Link className="btn lg" to="/problemset">Browse problems</Link>
          </div>
        </div>
        <div className="terminal" aria-hidden>
          <div className="terminal-top"><i /><i /><i /><span>~/contests/autumn-open</span></div>
          <pre>
            <span className="muted">$</span> codeclash register "Autumn Open"{'\n'}
            <span className="ok">  ✓ seat confirmed</span> <span className="muted">· 118 of 200 taken</span>{'\n'}
            <span className="muted">$</span> codeclash submit C.cpp --lang cpp{'\n'}
            <span className="muted">  judging against 14 hidden tests …</span>{'\n'}
            <span className="ok">  ✓ Accepted</span> <span className="muted">· 46 ms · 3.1 MB</span>{'\n'}
            <span className="muted">$</span> codeclash standings --top 3{'\n'}
            <span className="accent">  1</span>  Ananya Krishnan      <span className="ok">5</span>  <span className="muted">312</span>{'\n'}
            <span className="accent">  2</span>  Karthik Subramanian  <span className="ok">5</span>  <span className="muted">347</span>{'\n'}
            <span className="accent">  3</span>  Lucas Moreau         <span className="ok">4</span>  <span className="muted">205</span>{'\n'}
            <span className="muted">$</span> <span className="cursor" />
          </pre>
        </div>
      </section>

      {featured ? (
        <div className="live-strip">
          <span className={`pill ${live ? 'live' : 'upcoming'}`}>{live ? 'live now' : 'registration open'}</span>
          <strong className="grow">{featured.title}</strong>
          <span className="muted num">
            {live ? `ends in ${formatLeft(new Date(live.endsAt).getTime() - now)}` : `starts in ${formatLeft(new Date(next!.startsAt).getTime() - now)}`}
          </span>
          <span className="muted small num">{featured.reserved}/{featured.capacity} seats</span>
          <Link className="btn primary sm" to={`/arena/${featured.id}`}>{live ? 'Enter' : 'Register'} <ArrowRight size={14} /></Link>
        </div>
      ) : null}

      {stats ? (
        <section className="proof" aria-label="Platform in numbers">
          <div><b className="num">{stats.problems.toLocaleString()}</b><span>problems in the archive</span></div>
          <div><b className="num">{stats.participants.toLocaleString()}</b><span>registered competitors</span></div>
          <div><b className="num">{stats.contests.toLocaleString()}</b><span>contests held</span></div>
          <div><b className="num">{stats.submissions.toLocaleString()}</b><span>submissions judged</span></div>
          <div><b className="num">{stats.languages}</b><span>languages supported</span></div>
        </section>
      ) : null}

      <section className="section" aria-labelledby="features-title">
        <h2 id="features-title" className="section-head">Built for fair, fast contests</h2>
        <div className="features">
          <div className="feature"><ShieldCheck size={20} /><h3>Sandboxed judge</h3><p>Each submission runs in an isolated container with no network access and strict time and memory limits.</p></div>
          <div className="feature"><Trophy size={20} /><h3>Live standings</h3><p>ICPC-style scoring with penalty time, first-solve markers and a scoreboard freeze for the final hour.</p></div>
          <div className="feature"><Radio size={20} /><h3>Quiz rounds</h3><p>Timed multiple-choice questions pushed to every competitor at once. Faster correct answers score higher.</p></div>
          <div className="feature"><BadgeCheck size={20} /><h3>Verified problems</h3><p>Every problem ships with a reference solution, hidden tests and known wrong answers that the tests must reject.</p></div>
        </div>
      </section>

      <section className="section" aria-labelledby="steps-title">
        <h2 id="steps-title" className="section-head">How a contest works</h2>
        <ol className="steps">
          {STEPS.map((step, index) => (
            <li key={step.title}>
              <span className="step-no">{String(index + 1).padStart(2, '0')}</span>
              <h3>{step.title}</h3>
              <p>{step.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="cta-band">
        <div>
          <h2>Ready for the next round?</h2>
          <p className="muted">Write in {LANGUAGES.map((l) => l.name.split(' ')[0]).join(', ').replace(/, ([^,]*)$/, ' or $1')}.</p>
        </div>
        <Link className="btn primary lg" to={signedIn ? '/arena' : '/auth'}>{signedIn ? 'See contests' : 'Get started'} <ArrowRight size={16} /></Link>
      </section>

      <footer className="landing-foot muted small">
        <span>CodeClash · CS455 software engineering project</span>
        <span>Archive problems from Codeforces via DeepMind CodeContests, CC BY 4.0</span>
      </footer>
    </div>
  );
}
