import { Bot, Check, Play, Square, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, isAbort } from '../api';
import { Alert, Empty, errorText, toast } from '../ui';

interface Evidence { exitCode: number | null; timedOut: boolean; ms: number; stdout: string; stderr: string }
interface Proposal {
  id: string;
  type: 'test' | 'wrong_solution' | 'performance_test';
  input: string;
  inputLength: number;
  expected: string;
  language: string | null;
  code: string;
  reason: string;
  source: 'deterministic' | 'model';
  attack: string | null;
  targetMutationId: string | null;
  evidence: { validator: string; reference?: Evidence; mutant?: Evidence & { id: string } } | null;
  status: string;
}
interface Mutation {
  id: string;
  key: string;
  operator: string;
  source: string;
  description: string;
  diff: { line: number; original: string; mutated: string } | null;
  status: 'compile_error' | 'trivial' | 'killed' | 'survived' | 'equivalent';
  survivedRandom: number;
  killedByProposalId: string | null;
}
interface Metrics {
  tests: number;
  baseline: { passed: number; total: number };
  mutants: { generated: number; compileErrors: number; trivial: number; killed: number; survived: number; equivalent: number };
  score: number | null;
  projectedScore: number | null;
  boundary: { kind: string; generated: boolean; covered: boolean }[];
  performance: { checked: boolean; maxInputSize: number; largestTestSize: number; referenceMs: number | null; limitMs: number; proposed: boolean; slowSolutionsCaught: string[] };
  spec: 'given' | 'drafted' | 'none';
  attacks: { boundary: number; random: number; max: number; model: number };
}
interface Run {
  id: string;
  baseVersionId: string;
  status: 'queued' | 'running' | 'completed' | 'timed_out' | 'failed' | 'cancelled';
  stage: string | null;
  aiStatus: string | null;
  metrics: Metrics | null;
  notes: string[];
  draftedSpec: string | null;
  calls: number;
  tokens: number;
  error: string | null;
  mutations: Mutation[];
  proposals: Proposal[];
}
interface RunRow { id: string; status: string; score: number | null; proposals: number; createdAt: string }
interface AgentStatus { status: string; provider: string | null; model: string | null; reason: string | null; monthly: { used: number; cap: number } }

const ACTIVE = ['queued', 'running'];
const RUN_TONE: Record<string, string> = { queued: 'upcoming', running: 'accent', completed: 'ok', timed_out: 'warn', failed: 'bad', cancelled: '' };
const AI_TONE: Record<string, string> = { AVAILABLE: 'ok', DISABLED: '', RATE_LIMITED: 'warn', BUDGET_EXCEEDED: 'warn', ERROR: 'bad' };
const TYPE_LABEL: Record<Proposal['type'], string> = { test: 'test', wrong_solution: 'wrong solution', performance_test: 'performance test' };

const percent = (value: number | null) => (value === null ? '—' : `${Math.round(value * 100)}%`);

function severity(m: Mutation) {
  if (m.status === 'equivalent') return { label: 'likely equivalent', tone: '' };
  if (m.survivedRandom >= 20) return { label: 'high', tone: 'bad' };
  if (m.survivedRandom >= 5) return { label: 'medium', tone: 'warn' };
  return { label: 'low', tone: '' };
}

function EvidenceBlock({ title, run }: { title: string; run?: Evidence }) {
  if (!run) return null;
  return (
    <div>
      <p className="label" style={{ marginTop: 0 }}>{title} · exit {run.exitCode ?? '—'}{run.timedOut ? ' · timed out' : ''} · {run.ms} ms</p>
      <pre>{run.stdout || '(no output)'}</pre>
      {run.stderr ? <pre className="muted">{run.stderr}</pre> : null}
    </div>
  );
}

export function Hardening({ problemId, versionId, hasReference, startRequest, onStartHandled, onApproved, onDraftSpec }: {
  problemId: string;
  versionId: string;
  hasReference: boolean;
  /** Non-zero when the toolbar button asked for a run; reset through onStartHandled so a remount does not start another. */
  startRequest: number;
  onStartHandled: () => void;
  onApproved: (versionId: string) => void;
  onDraftSpec: (spec: string) => void;
}) {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const handled = useRef(0);

  const loadRun = useCallback(async (id: string, signal?: AbortSignal) => {
    const next = await api<Run>(`/api/hardening-runs/${id}`, { signal });
    setRun(next);
    return next;
  }, []);

  const loadRuns = useCallback(async (signal?: AbortSignal) => {
    const [rows, agent] = await Promise.all([
      api<RunRow[]>(`/api/problems/${problemId}/hardening-runs`, { signal }),
      api<AgentStatus>('/api/agent/status', { signal }),
    ]);
    setRuns(rows);
    setStatus(agent);
    return rows;
  }, [problemId]);

  useEffect(() => {
    const controller = new AbortController();
    setRun(null);
    setSelected(new Set());
    loadRuns(controller.signal)
      .then((rows) => (rows[0] ? loadRun(rows[0].id, controller.signal) : null))
      .catch((e) => { if (!isAbort(e)) setError(errorText(e)); });
    return () => controller.abort();
  }, [loadRuns, loadRun]);

  const active = run ? ACTIVE.includes(run.status) : false;
  useEffect(() => {
    if (!run || !active) return undefined;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      loadRun(run.id, controller.signal)
        .then((next) => {
          if (ACTIVE.includes(next.status)) return;
          void loadRuns();
          const found = next.proposals.filter((p) => p.status === 'held').length;
          if (next.status === 'completed') toast(found ? `Hardening finished with ${found} proposal(s) to review.` : 'Hardening finished. Nothing to propose.', found ? 'ok' : 'warn');
          else toast(next.error ?? `The run ended as ${next.status}.`, 'bad');
        })
        .catch((e) => { if (!isAbort(e)) setError(errorText(e)); });
    }, 1500);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [run, active, loadRun, loadRuns]);

  const start = useCallback(async () => {
    setError('');
    setBusy('start');
    try {
      const started = await api<{ runId: string }>(`/api/problem-versions/${versionId}/hardening-runs`, { method: 'POST' });
      setSelected(new Set());
      await loadRun(started.runId);
      await loadRuns();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }, [versionId, loadRun, loadRuns]);

  useEffect(() => {
    if (startRequest === 0) { handled.current = 0; return; }
    if (startRequest === handled.current) return;
    handled.current = startRequest;
    onStartHandled();
    void start();
  }, [startRequest, start, onStartHandled]);

  async function cancel() {
    if (!run) return;
    setBusy('cancel');
    try {
      await api(`/api/hardening-runs/${run.id}/cancel`, { method: 'POST' });
      await loadRun(run.id);
      await loadRuns();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function approve(ids: string[]) {
    if (!run || ids.length === 0) return;
    setBusy('approve');
    try {
      const result = await api<{ versionId: string }>(`/api/hardening-runs/${run.id}/approve`, { method: 'POST', body: JSON.stringify({ proposalIds: ids }) });
      setSelected(new Set());
      await loadRun(run.id);
      toast(`Approved ${ids.length} into the draft. Run the publish check to ship it.`, 'ok');
      onApproved(result.versionId);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  async function reject(id: string) {
    if (!run) return;
    setBusy('reject');
    try {
      await api(`/api/proposals/${id}/reject`, { method: 'POST' });
      await loadRun(run.id);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy('');
    }
  }

  const metrics = run?.metrics ?? null;
  const held = run?.proposals.filter((p) => p.status === 'held') ?? [];
  const keyOf = new Map(run?.mutations.map((m) => [m.id, m.key]) ?? []);
  const survivors = run?.mutations.filter((m) => m.status === 'survived' || m.status === 'equivalent') ?? [];
  const aiStatus = run?.aiStatus ?? status?.status ?? 'DISABLED';
  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <div className="harden">
      {error ? <Alert>{error}</Alert> : null}
      <div className="harden-bar">
        <div className="row">
          <span className={`pill ${AI_TONE[aiStatus] ?? ''}`} title={status?.reason ?? undefined}>
            AI {aiStatus.toLowerCase().replace('_', ' ')}{status?.model ? ` · ${status.model}` : ''}
          </span>
          {run ? <span className={`pill ${RUN_TONE[run.status] ?? ''}`}>{run.status.replace('_', ' ')}</span> : null}
          {run && active && run.stage ? <span className="muted small">{run.stage}</span> : null}
        </div>
        <div className="row">
          {runs.length > 1 ? (
            <select aria-label="Earlier runs" value={run?.id ?? ''} onChange={(e) => { setSelected(new Set()); void loadRun(e.target.value); }}>
              {runs.map((row) => (
                <option key={row.id} value={row.id}>
                  {new Date(row.createdAt).toLocaleString()} · {row.status.replace('_', ' ')} · {percent(row.score)}
                </option>
              ))}
            </select>
          ) : null}
          {active ? (
            <button className="btn sm" type="button" disabled={busy !== ''} onClick={cancel}><Square size={13} /> cancel</button>
          ) : (
            <button className="btn primary sm" type="button" disabled={!hasReference || busy !== ''} onClick={start}><Play size={13} /> {busy === 'start' ? 'queueing…' : 'run hardening'}</button>
          )}
        </div>
      </div>

      {!run ? (
        <div className="table-wrap">
          <Empty icon={<Bot size={28} />} title="No hardening runs yet">
            {hasReference
              ? 'A run mutates the reference, attacks it with boundary, random, and max-size inputs, and proposes the tests that catch what the suite misses.'
              : 'Add a reference solution first.'}
          </Empty>
        </div>
      ) : null}

      {run && active ? (
        <Alert tone="info">
          {run.status === 'queued' ? 'Waiting for the agent worker to pick this run up.' : 'Running in the sandbox. Mutants compile once and run every input in one container.'}
        </Alert>
      ) : null}
      {run?.error ? <Alert tone="bad">{run.error}</Alert> : null}
      {run && run.notes.length > 0 ? (
        <ul className="harden-notes">{run.notes.map((note) => <li key={note}>{note}</li>)}</ul>
      ) : null}

      {metrics ? (
        <>
          <section className="harden-stats" aria-label="Test strength">
            <div className="stat"><span className="stat-value">{metrics.tests}</span><span className="stat-label">tests</span></div>
            <div className="stat"><span className="stat-value">{metrics.mutants.generated}</span><span className="stat-label">mutants</span></div>
            <div className="stat"><span className="stat-value">{metrics.mutants.killed}</span><span className="stat-label">killed</span></div>
            <div className="stat"><span className="stat-value">{metrics.mutants.survived}</span><span className="stat-label">survived</span></div>
            <div className="stat"><span className="stat-value">{metrics.mutants.equivalent}</span><span className="stat-label">likely equivalent</span></div>
            <div className="stat strong"><span className="stat-value">{percent(metrics.score)}</span><span className="stat-label">mutation score</span></div>
            <div className="stat"><span className="stat-value">{percent(metrics.projectedScore)}</span><span className="stat-label">after approval</span></div>
          </section>
          <p className="muted small harden-foot">
            Score = killed ÷ (generated − trivial − likely equivalent − compile errors). {metrics.mutants.trivial} trivial mutant(s) failed the samples and {metrics.mutants.compileErrors} did not compile; neither counts.
            {' '}Reference passes {metrics.baseline.passed}/{metrics.baseline.total} current tests.
          </p>

          <div className="two harden-facts">
            <div>
              <p className="section-title" style={{ marginTop: 0 }}>Boundary classes <span className="muted small">· spec {metrics.spec}</span></p>
              {metrics.spec === 'none' ? <p className="muted small">No input spec, so boundary classes were not checked.</p> : (
                <div className="chips">
                  {metrics.boundary.map((b) => (
                    <span key={b.kind} className={`pill ${b.covered ? 'ok' : b.generated ? 'warn' : ''}`} title={b.covered ? 'a current test has it' : b.generated ? 'generated as an attack, not in the suite' : 'the spec does not allow it'}>
                      {b.covered ? '✓ ' : ''}{b.kind}
                    </span>
                  ))}
                </div>
              )}
              {run?.draftedSpec ? (
                <p className="small" style={{ marginTop: 'var(--space-2)' }}>
                  Drafted spec used for this run.{' '}
                  <button className="btn ghost sm" type="button" onClick={() => onDraftSpec(run.draftedSpec!)}>copy into the spec section</button>
                </p>
              ) : null}
            </div>
            <div>
              <p className="section-title" style={{ marginTop: 0 }}>Performance</p>
              {metrics.performance.checked ? (
                <p className="small">
                  Largest test has {metrics.performance.largestTestSize} values; the maximum input has {metrics.performance.maxInputSize}.
                  {' '}The reference took {metrics.performance.referenceMs} ms of {metrics.performance.limitMs} ms on it.
                  {metrics.performance.proposed ? ' A max-size test is proposed below.' : ' The suite already has a large test.'}
                  {metrics.performance.slowSolutionsCaught.length ? ` It catches ${metrics.performance.slowSolutionsCaught.join(', ')}.` : ''}
                </p>
              ) : <p className="muted small">Not checked: needs an input spec and a reference that handles the maximum input.</p>}
            </div>
          </div>

          <p className="section-title">Surviving mutants <span className="muted small">· bugs the current tests do not catch</span></p>
          {survivors.length === 0 ? <p className="muted small">None. Every counted mutant is killed by the current tests.</p> : (
            <div className="mutants">
              {survivors.map((m) => {
                const level = severity(m);
                return (
                  <div key={m.id} className="mutant">
                    <div className="mutant-head">
                      <strong className="num">{m.key}</strong>
                      <span className="muted small">{m.operator}{m.source === 'model' ? ' · model' : ''}</span>
                      <span className={`pill ${level.tone}`}>{level.label}</span>
                      {m.killedByProposalId ? <span className="pill accent">caught by proposal</span> : null}
                      <span className="grow" />
                      <span className="muted small">survived {m.survivedRandom} random input(s)</span>
                    </div>
                    {m.diff ? (
                      <pre className="diff"><span className="del">- {m.diff.original}</span>{'\n'}<span className="add">+ {m.diff.mutated}</span></pre>
                    ) : <p className="small">{m.description}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </>
      ) : null}

      {run && run.proposals.length > 0 ? (
        <>
          <div className="row between">
            <p className="section-title">Proposals <span className="muted small">· nothing changes until you approve</span></p>
            <button className="btn primary sm" type="button" disabled={selected.size === 0 || busy !== ''} onClick={() => approve([...selected])}>
              <Check size={13} /> approve selected ({selected.size})
            </button>
          </div>
          <div className="stack">
            {run.proposals.map((p) => {
              const ref = p.evidence?.reference;
              const target = p.targetMutationId ? keyOf.get(p.targetMutationId) : null;
              return (
                <div key={p.id} className="proposal">
                  <div className="proposal-head">
                    <span className="row">
                      {p.status === 'held' ? <input type="checkbox" aria-label={`Select ${p.id}`} checked={selected.has(p.id)} onChange={() => toggle(p.id)} /> : null}
                      <strong>{TYPE_LABEL[p.type]}</strong>
                      <span className="muted small">{p.source === 'model' ? 'model' : 'deterministic'}{p.attack ? ` · ${p.attack}` : ''}</span>
                    </span>
                    {p.status === 'held' ? (
                      <div className="row">
                        <button className="btn primary sm" type="button" disabled={busy !== ''} onClick={() => approve([p.id])}><Check size={13} /> approve</button>
                        <button className="btn sm" type="button" disabled={busy !== ''} onClick={() => reject(p.id)}><X size={13} /> reject</button>
                      </div>
                    ) : <span className={`pill ${p.status === 'approved' ? 'ok' : ''}`}>{p.status}</span>}
                  </div>
                  <p className="small proposal-why">{p.reason}</p>
                  {p.type !== 'wrong_solution' ? (
                    <ul className="checks">
                      <li className={p.evidence?.validator.startsWith('valid') ? 'ok' : 'warn'}>{p.evidence?.validator ?? 'not checked'}</li>
                      <li className={ref && ref.exitCode === 0 && !ref.timedOut ? 'ok' : 'warn'}>reference verified{ref ? ` in ${ref.ms} ms` : ''}</li>
                      {target ? <li className="ok">kills mutant {target}</li> : null}
                    </ul>
                  ) : null}
                  <div className="proposal-body">
                    {p.type === 'wrong_solution' ? (
                      <div><p className="label" style={{ marginTop: 0 }}>code · {p.language}</p><pre>{p.code}</pre></div>
                    ) : (
                      <>
                        <div><p className="label" style={{ marginTop: 0 }}>input{p.inputLength > p.input.length ? ` · first 4 KB of ${Math.round(p.inputLength / 1024)} KB` : ''}</p><pre>{p.input}</pre></div>
                        <div><p className="label" style={{ marginTop: 0 }}>expected · from the reference</p><pre>{p.expected}</pre></div>
                      </>
                    )}
                  </div>
                  {p.evidence?.reference || p.evidence?.mutant ? (
                    <details className="evidence">
                      <summary>run evidence</summary>
                      <div className="proposal-body">
                        <EvidenceBlock title="reference" run={p.evidence.reference} />
                        <EvidenceBlock title={`mutant ${p.evidence.mutant ? keyOf.get(p.targetMutationId ?? '') ?? p.evidence.mutant.id : ''}`} run={p.evidence.mutant} />
                      </div>
                    </details>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : null}
      {run && held.length === 0 && run.status === 'completed' && run.proposals.length === 0 ? (
        <p className="muted small">This run found nothing to add.</p>
      ) : null}
    </div>
  );
}
