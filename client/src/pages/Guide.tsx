import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

function Term({ path, children }: { path: string; children: ReactNode }) {
  return (
    <section className="term guide-term">
      <div className="terminal-top">
        <i /><i /><i />
        <span className="term-path">{path}</span>
      </div>
      <div className="guide-body">{children}</div>
    </section>
  );
}

function Line({ cmd, children }: { cmd: string; children: ReactNode }) {
  return (
    <div className="g-line">
      <span className="g-cmd">{cmd}</span>
      <span>{children}</span>
    </div>
  );
}

export function Guide() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">$ man codeclash</p>
          <h1>Operator guide</h1>
        </div>
      </div>

      <div className="guide">
        <Term path="who">
          <Line cmd="participant">seat, submit, quiz — email confirmed first</Line>
          <Line cmd="setter"><Link to="/authoring">authoring</Link> — problems, tests, publish check, agent</Line>
          <Line cmd="organiser"><Link to="/control">control</Link> — contest, cancel, quiz, rejudge</Line>
          <Line cmd="admin">all of the above, plus <Link to="/admin">people, workers, audit</Link></Line>
          <Line cmd="promote">People → role. You cannot drop your own admin role.</Line>
        </Term>

        <Term path="contest">
          <Line cmd="draft">Control. ICPC = penalty. IOI = partial scores. “Start right away” skips to running.</Line>
          <Line cmd="registration">Hard cap. Overflow waits. Withdraw hands the seat to the head of the list, once.</Line>
          <Line cmd="running">Reserved seats compete. Submissions and the quiz open. Clock is the server’s.</Line>
          <Line cmd="freeze">Public board stops. You still see the true board. Later attempts show as ?</Line>
          <Line cmd="publish">After end. Ratings written once. Editorials unlock. Problems enter the problemset.</Line>
          <Line cmd="cancel">Any step before publish. Seats released. Contest cannot restart.</Line>
        </Term>

        <Term path="judging">
          <Line cmd="submit">Returns an id at once. Own container. No network. Time and memory limits.</Line>
          <Line cmd="verdicts">Accepted, Wrong answer, Time limit, Memory limit, Runtime error, Compilation error</Line>
          <Line cmd="run samples">Visible examples only. Nothing is stored.</Line>
          <Line cmd="double click">Same idempotency key. Second request returns the original submission.</Line>
          <Line cmd="rejudge">Control. Reason required. Empty submission id = the whole contest. Old verdicts stay in the audit row.</Line>
          <Line cmd="subtasks">A group scores only if every test in it passes. Later groups still run.</Line>
        </Term>

        <Term path="quiz">
          <Line cmd="next">Control → open next question. Server timer. Correct option hidden until it closes.</Line>
          <Line cmd="score">One answer. A faster correct answer scores more.</Line>
          <Line cmd="streak">+10% of the base per prior correct answer in a row. Cap 5.</Line>
          <Line cmd="rating">Elo when standings are published. Once. New accounts start at 1200.</Line>
          <Line cmd="practice">Problemset shows rating and consecutive days with an accepted solution.</Line>
        </Term>

        <Term path="authoring">
          <Line cmd="new problem">Opens in the pane on the right. A new draft, not a copy.</Line>
          <Line cmd="new version">Toolbar. Copies a published problem so you can edit it.</Line>
          <Line cmd="publish check">Reference must pass every test. Each wrong solution must fail one.</Line>
          <Line cmd="blocked">Edit it and run the check again.</Line>
          <Line cmd="harden">Agent proposes tests and wrong solutions. Approve makes a new draft. You still run the check.</Line>
          <Line cmd="subtask">Group name on the test. Same name under Subtasks, with points.</Line>
        </Term>

        <Term path="problemset">
          <Line cmd="hidden">Live contest problems, until that contest is published.</Line>
          <Line cmd="visible">Practice problems that were never in a contest.</Line>
          <Line cmd="filters">Name, tag, difficulty, your status. Stored in the URL.</Line>
          <Line cmd="accepted">Share of judged submissions that passed.</Line>
          <Line cmd="difficulty">The label the setter stored.</Line>
        </Term>

        <Term path="workers">
          <Line cmd="slots">Advertised count plus a heartbeat.</Line>
          <Line cmd="drain">Stops new work.</Line>
          <Line cmd="evict">Marks it gone. Another worker reclaims the job. A claim token blocks a late score.</Line>
          <Line cmd="live">At least 80% of slots stay on the contest. Practice uses the rest.</Line>
          <Line cmd="audit">Append-only. Actor, action, decision, before, after, reason.</Line>
          <Line cmd="search">Matches action, actor, target, or decision.</Line>
          <Line cmd="request id"><code>x-request-id</code> on every response. Same id on a server error.</Line>
        </Term>

        <Term path="room">
          <Line cmd="submit"><kbd>Ctrl</kbd> + <kbd>Enter</kbd></Line>
          <Line cmd="memory">Drafts and the last language stay in this browser.</Line>
          <Line cmd="theme">Palette icon in the header. Saved, and applied before paint.</Line>
          <Line cmd="verdicts">Announced, and written. Not colour alone.</Line>
          <Line cmd="skip">First tab stop.</Line>
          <Line cmd="demo"><code>admin@codeclash.local</code> / <code>codeclash</code></Line>
          <Line cmd="rounds">Warmup round is live. Library cup is already published.</Line>
        </Term>
      </div>
    </div>
  );
}
