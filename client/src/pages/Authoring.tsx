import { Bot, Check, FilePlus2, FileUp, Plus, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api';
import { ProblemView } from '../problem';
import { Alert, Editor, Empty, errorText, LANGUAGES, StatusPill, toast, type Language } from '../ui';

interface ProblemRow { problemId: string; versionId: string; version: number; title: string; status: string }
interface Test { input: string; output: string; hidden: boolean; group?: string }
interface Subtask { name: string; points: number }
interface Solution { label: string; language: Language; code: string }
interface Version {
  problemId: string;
  versionId: string;
  version: number;
  title: string;
  statement: string;
  samples: string;
  editorial: string;
  tags: string[];
  difficulty: 'easy' | 'medium' | 'hard';
  subtasks: Subtask[];
  tests: Test[];
  reference: { language: Language; code: string } | null;
  wrongSolutions: Solution[];
  status: string;
  report: string[];
}
interface Proposal { id: string; kind: string; language: string; code: string; stdin: string; expected: string; status: string }
interface AgentRun { status: string; reason: string | null; proposals: number; denied: string[] }
type Section = 'statement' | 'tests' | 'solutions' | 'agent';

const EDITABLE = ['draft', 'blocked'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function Authoring() {
  const [params, setParams] = useSearchParams();
  const versionId = params.get('v') ?? '';
  const [problems, setProblems] = useState<ProblemRow[]>([]);
  const [filter, setFilter] = useState('');
  const [version, setVersion] = useState<Version | null>(null);
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState<Section>('statement');
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStatement, setNewStatement] = useState('');
  const [newDifficulty, setNewDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');

  const loadProblems = useCallback(() => api<ProblemRow[]>('/api/problems').then(setProblems), []);
  const loadVersion = useCallback(async (id: string) => {
    if (!id) { setVersion(null); setProposals([]); return; }
    const [next, props] = await Promise.all([
      api<Version>(`/api/problem-versions/${id}`),
      api<Proposal[]>(`/api/problem-versions/${id}/proposals`),
    ]);
    setVersion(next);
    setProposals(props);
    setDirty(false);
  }, []);

  useEffect(() => { loadProblems().catch((e) => setError(errorText(e))); }, [loadProblems]);
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCreating(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);
  useEffect(() => { loadVersion(versionId).catch((e) => setError(errorText(e))); }, [versionId, loadVersion]);

  function select(id: string) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setError('');
    setParams(id ? { v: id } : {});
  }

  async function guarded(label: string, action: () => Promise<void>) {
    setError('');
    setWorking(label);
    try {
      await action();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      setWorking('');
    }
  }

  function patch(change: Partial<Version>) {
    setVersion((current) => (current ? { ...current, ...change } : current));
    setDirty(true);
  }

  async function createProblem(event: FormEvent) {
    event.preventDefault();
    await guarded('create', async () => {
      const created = await api<{ versionId: string }>('/api/problems', {
        method: 'POST',
        body: JSON.stringify({ title: newTitle, statement: newStatement, samples: '', tags: [], difficulty: newDifficulty }),
      });
      setNewTitle('');
      setNewStatement('');
      setCreating(false);
      await loadProblems();
      setDirty(false);
      setParams({ v: created.versionId });
      toast('Problem created as a draft', 'ok');
    });
  }

  async function save() {
    if (!version) return false;
    return guarded('save', async () => {
      await api(`/api/problem-versions/${version.versionId}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: version.title, statement: version.statement, samples: version.samples, editorial: version.editorial, tags: version.tags, difficulty: version.difficulty }),
      });
      await api(`/api/problem-versions/${version.versionId}/tests`, {
        method: 'PUT',
        body: JSON.stringify({ tests: version.tests, subtasks: version.subtasks ?? [], reference: version.reference, wrongSolutions: version.wrongSolutions }),
      });
      await Promise.all([loadVersion(version.versionId), loadProblems()]);
      toast('Saved', 'ok');
    });
  }

  async function uploadZip(file: File) {
    if (!version) return;
    await guarded('zip', async () => {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = '';
      bytes.forEach((b) => { binary += String.fromCharCode(b); });
      const result = await api<{ count: number }>(`/api/problem-versions/${version.versionId}/tests-zip`, {
        method: 'POST',
        body: JSON.stringify({ zipBase64: btoa(binary) }),
      });
      await loadVersion(version.versionId);
      toast(`Loaded ${result.count} tests from the zip`, 'ok');
    });
  }

  async function publishCheck() {
    if (!version || !(await save())) return;
    await guarded('check', async () => {
      await api(`/api/problem-versions/${version.versionId}/publish-check`, { method: 'POST' });
      setVersion((current) => (current ? { ...current, status: 'checking', report: [] } : current));
      for (let i = 0; i < 120; i += 1) {
        await sleep(1500);
        const next = await api<Version>(`/api/problem-versions/${version.versionId}`);
        if (next.status !== 'checking') {
          setVersion(next);
          await loadProblems();
          toast(next.status === 'published' ? 'Published. Contests and practice now use this version.' : 'The check blocked this version. See the report.', next.status === 'published' ? 'ok' : 'bad');
          return;
        }
      }
      toast('The check is still running. Reload later.', 'warn');
    });
  }

  async function harden() {
    if (!version) return;
    setSection('agent');
    await guarded('harden', async () => {
      const started = await api<{ runId: string }>(`/api/problem-versions/${version.versionId}/harden`, { method: 'POST' });
      for (let i = 0; i < 120; i += 1) {
        await sleep(1500);
        const run = await api<AgentRun>(`/api/agent-runs/${started.runId}`);
        if (run.status !== 'running') {
          setProposals(await api<Proposal[]>(`/api/problem-versions/${version.versionId}/proposals`));
          const denied = run.denied.length ? ` Denied: ${run.denied.join(', ')}.` : '';
          toast(run.proposals ? `The agent proposed ${run.proposals} item(s) for review.${denied}` : `No proposals (${run.reason ?? 'none'}).${denied}`, run.proposals ? 'ok' : 'warn');
          return;
        }
      }
    });
  }

  async function decide(proposal: Proposal, verdict: 'approve' | 'reject') {
    await guarded(verdict, async () => {
      const result = await api<{ versionId?: string }>(`/api/proposals/${proposal.id}/${verdict}`, { method: 'POST' });
      if (verdict === 'approve' && result.versionId) {
        await loadProblems();
        setDirty(false);
        setParams({ v: result.versionId });
        toast('Approved into a new draft version. Run the publish check to ship it.', 'ok');
      } else if (version) {
        setProposals(await api<Proposal[]>(`/api/problem-versions/${version.versionId}/proposals`));
      }
    });
  }

  async function newVersion() {
    if (!version) return;
    await guarded('version', async () => {
      const created = await api<{ versionId: string }>(`/api/problems/${version.problemId}/versions`, { method: 'POST', body: '{}' });
      await loadProblems();
      setParams({ v: created.versionId });
      toast('New draft version created', 'ok');
    });
  }

  const editable = version ? EDITABLE.includes(version.status) : false;
  const shown = problems.filter((p) => p.title.toLowerCase().includes(filter.toLowerCase()));
  const held = proposals.filter((p) => p.status === 'held').length;

  return (
    <div className="page wide author-page">
      <div className="page-head">
        <div>
          <h1>Authoring</h1>
          <p>Draft a problem, prove it in the sandbox, then publish.</p>
        </div>
      </div>
      {error ? <Alert>{error}</Alert> : null}
      <div className="author">
        <aside className="box author-side">
          <header className="box-head">
            <strong>problems</strong>
            <span>{problems.length}</span>
          </header>
          <div className="side-find">
            <div className="input-icon">
              <Search size={14} />
              <input aria-label="Filter problems" placeholder="Filter by name" value={filter} onChange={(e) => setFilter(e.target.value)} />
            </div>
          </div>
          <ul className="plist">
            {shown.length === 0 ? <li className="muted small plist-empty">No matches</li> : shown.map((p) => (
              <li key={p.problemId}>
                <button type="button" className={p.versionId === versionId && !creating ? 'on' : ''} onClick={() => { setCreating(false); select(p.versionId); }}>
                  <span className="plist-name">{p.title}</span>
                  <span className="plist-meta">v{p.version}</span>
                  <StatusPill status={p.status} label={p.status} />
                </button>
              </li>
            ))}
          </ul>
          <button className="term-new" type="button" onClick={() => setCreating(true)}>
            <FilePlus2 size={14} /> new problem
          </button>
        </aside>

        <section className="author-main">
          {creating ? (
            <form className="box author-work" onSubmit={createProblem}>
              <header className="box-head">
                <strong>new problem</strong>
                <button className="btn ghost icon sm" type="button" onClick={() => setCreating(false)} aria-label="Close"><X size={14} /></button>
              </header>
              <div className="author-body">
                <p className="muted small" style={{ marginTop: 0 }}>A draft. Tests and the reference come after this. <kbd>Esc</kbd> closes.</p>
                <label htmlFor="new-title">Title</label>
                <input id="new-title" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} required autoFocus placeholder="Sum of two integers" />
                <label>Difficulty</label>
                <div className="segmented" role="radiogroup" aria-label="Difficulty">
                  {(['easy', 'medium', 'hard'] as const).map((level) => (
                    <button key={level} type="button" role="radio" aria-checked={newDifficulty === level} className={newDifficulty === level ? 'on' : ''} onClick={() => setNewDifficulty(level)}>{level}</button>
                  ))}
                </div>
                <label htmlFor="new-statement">Statement</label>
                <textarea id="new-statement" className="prose" value={newStatement} onChange={(e) => setNewStatement(e.target.value)} required placeholder="Read two integers and print their sum." style={{ minHeight: '14rem' }} />
                <div className="create-actions">
                  <button className="btn ghost" type="button" onClick={() => setCreating(false)}>cancel</button>
                  <button className="btn primary" type="submit" disabled={working !== ''}><FilePlus2 size={14} /> {working === 'create' ? 'creating…' : 'create draft'}</button>
                </div>
              </div>
            </form>
          ) : !version ? (
            <div className="box author-work">
              <header className="box-head"><strong>editor</strong></header>
              <div className="author-body empty-file">
                <Empty icon={<FilePlus2 size={28} />} title="Nothing open">
                  Pick a problem from the list, or start a new one.
                </Empty>
                <button className="btn primary" type="button" onClick={() => setCreating(true)}><FilePlus2 size={14} /> new problem</button>
              </div>
            </div>
          ) : (
            <div className="box author-work">
              <header className="box-head">
                <strong>{version.title}</strong>
                <span className="row">
                  <span className="muted small">v{version.version}</span>
                  <StatusPill status={version.status} label={version.status} />
                  {dirty ? <span className="pill warn">unsaved</span> : null}
                </span>
              </header>
              <div className="toolbar">
                <div className="row">
                  {!editable && version.status !== 'checking' ? <button className="btn sm" type="button" onClick={newVersion} disabled={working !== ''}><Plus size={14} /> new version</button> : null}
                  <button className="btn sm" type="button" disabled={!editable || working !== '' || !dirty} onClick={save}><Save size={14} /> {working === 'save' ? 'saving…' : 'save'}</button>
                  <button className="btn sm" type="button" disabled={!version.reference || working !== ''} onClick={harden}><Bot size={14} /> {working === 'harden' ? 'agent working…' : 'harden tests'}</button>
                  <button className="btn primary sm" type="button" disabled={!editable || !version.reference || working !== ''} onClick={publishCheck}>
                    <ShieldCheck size={14} /> {working === 'check' || version.status === 'checking' ? 'checking in sandbox…' : 'publish check'}
                  </button>
                </div>
              </div>

              {version.report.length > 0 ? (
                <Alert tone={version.status === 'published' ? 'ok' : 'bad'}>
                  <strong>{version.status === 'published' ? 'Publish check passed' : 'Publish check blocked this version'}</strong>
                  <ul>{version.report.map((line) => <li key={line}>{line}</li>)}</ul>
                </Alert>
              ) : null}
              {!editable ? <Alert tone="info">This version is {version.status} and cannot change. {version.status !== 'checking' ? 'Start a new version to edit it.' : 'Wait for the check to finish.'}</Alert> : null}

              <nav className="tabs" role="tablist" aria-label="Sections">
                {([['statement', 'statement'], ['tests', `tests`], ['solutions', 'solutions'], ['agent', 'agent']] as const).map(([key, name]) => (
                  <button key={key} type="button" role="tab" aria-selected={section === key} className={`tab ${section === key ? 'on' : ''}`} onClick={() => setSection(key)}>
                    {name}
                    {key === 'tests' ? <span className="count">{version.tests.length}</span> : null}
                    {key === 'solutions' ? <span className="count">{(version.reference ? 1 : 0) + version.wrongSolutions.length}</span> : null}
                    {key === 'agent' && held ? <span className="count">{held}</span> : null}
                  </button>
                ))}
              </nav>
              <div className="author-body">

              {section === 'statement' ? (
                <div className="two">
                  <fieldset disabled={!editable || working !== ''}>
                      <div className="field-row">
                        <div><label htmlFor="title" style={{ marginTop: 0 }}>Title</label><input id="title" value={version.title} onChange={(e) => patch({ title: e.target.value })} /></div>
                        <div><label htmlFor="tags" style={{ marginTop: 0 }}>Tags (comma separated)</label><input id="tags" value={version.tags.join(', ')} onChange={(e) => patch({ tags: e.target.value.split(',').map((t) => t.trim()).filter(Boolean) })} /></div>
                        <div>
                          <label htmlFor="difficulty" style={{ marginTop: 0 }}>Difficulty</label>
                          <select id="difficulty" value={version.difficulty ?? 'medium'} onChange={(e) => patch({ difficulty: e.target.value as Version['difficulty'] })}>
                            <option value="easy">easy</option>
                            <option value="medium">medium</option>
                            <option value="hard">hard</option>
                          </select>
                        </div>
                      </div>
                      <label htmlFor="statement">Statement · blank lines split paragraphs; a line “Input”, “Output” or “Note” starts a section; `x` is code</label>
                      <textarea id="statement" className="prose" value={version.statement} onChange={(e) => patch({ statement: e.target.value })} style={{ minHeight: '14rem' }} />
                      <label htmlFor="samples">Samples</label>
                      <textarea id="samples" value={version.samples} onChange={(e) => patch({ samples: e.target.value })} placeholder={'Input\n1 2\nOutput\n3'} />
                      <label htmlFor="editorial">Editorial · shown after the contest ends</label>
                      <textarea id="editorial" className="prose" value={version.editorial} onChange={(e) => patch({ editorial: e.target.value })} />
                  </fieldset>
                  <div>
                    <p className="label" style={{ marginTop: 0 }}>Preview · how participants see it</p>
                    <ProblemView problem={version} language="python" editorial="always" />
                  </div>
                </div>
              ) : null}

              <fieldset disabled={!editable || working !== ''}>
                {section === 'tests' ? (
                  <>
                    <div className="row between" style={{ marginBottom: '0.75rem' }}>
                      <span className="muted small">Hidden tests are never shown to participants. Files named sample*.in stay visible.</span>
                      <div className="row">
                        <label className="btn sm file" style={{ margin: 0 }}>
                          <FileUp size={14} /> upload zip
                          <input type="file" accept=".zip" onChange={(e) => { const file = e.target.files?.[0]; if (file) void uploadZip(file); e.target.value = ''; }} />
                        </label>
                        <button className="btn sm" type="button" onClick={() => patch({ tests: [...version.tests, { input: '', output: '', hidden: true, group: '' }] })}><Plus size={14} /> add test</button>
                      </div>
                    </div>
                    {version.tests.length === 0 ? <div className="table-wrap"><Empty title="No tests yet">Add them by hand or upload a zip of paired .in / .out files.</Empty></div> : (
                      <div className="test-list">
                        {version.tests.map((test, index) => (
                          <div key={index} className="test-item">
                            <span className="idx num">#{index + 1}</span>
                            <textarea aria-label={`Test ${index + 1} input`} placeholder="input" value={test.input} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, input: e.target.value } : t)) })} />
                            <textarea aria-label={`Test ${index + 1} output`} placeholder="expected output" value={test.output} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, output: e.target.value } : t)) })} />
                            <div className="stack" style={{ gap: '0.4rem' }}>
                              <input aria-label={`Test ${index + 1} subtask`} placeholder="subtask" value={test.group ?? ''} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, group: e.target.value } : t)) })} />
                              <label className="check"><input type="checkbox" checked={test.hidden} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, hidden: e.target.checked } : t)) })} /> hidden</label>
                              <button className="btn danger sm" type="button" onClick={() => patch({ tests: version.tests.filter((_, i) => i !== index) })} aria-label={`Remove test ${index + 1}`}><Trash2 size={13} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="row between" style={{ marginTop: '1rem' }}>
                      <p className="section-title" style={{ margin: 0 }}>Subtasks <span className="muted small">· a group scores only if every test in it passes</span></p>
                      <button className="btn sm" type="button" onClick={() => patch({ subtasks: [...(version.subtasks ?? []), { name: '', points: 10 }] })}><Plus size={14} /> add subtask</button>
                    </div>
                    {(version.subtasks ?? []).map((subtask, index) => (
                      <div key={index} className="field-row">
                        <div><label>Name</label><input aria-label={`Subtask ${index + 1} name`} value={subtask.name} onChange={(e) => patch({ subtasks: version.subtasks.map((s, i) => (i === index ? { ...s, name: e.target.value } : s)) })} /></div>
                        <div><label>Points</label><input aria-label={`Subtask ${index + 1} points`} type="number" min={1} value={subtask.points} onChange={(e) => patch({ subtasks: version.subtasks.map((s, i) => (i === index ? { ...s, points: Number(e.target.value) } : s)) })} /></div>
                      </div>
                    ))}
                  </>
                ) : null}

                {section === 'solutions' ? (
                  <>
                    <p className="section-title" style={{ marginTop: 0 }}>Reference solution <span className="muted small">· must pass every test</span></p>
                    <SolutionEditor
                      value={{ label: 'reference', ...(version.reference ?? { language: 'python', code: '' }) }}
                      readOnly={!editable}
                      onChange={(next) => patch({ reference: { language: next.language, code: next.code } })}
                    />
                    <div className="row between">
                      <p className="section-title">Wrong solutions <span className="muted small">· each must fail at least one test</span></p>
                      <button className="btn sm" type="button" onClick={() => patch({ wrongSolutions: [...version.wrongSolutions, { label: `wrong-${version.wrongSolutions.length + 1}`, language: 'python', code: '' }] })}><Plus size={14} /> add</button>
                    </div>
                    {version.wrongSolutions.length === 0 ? <p className="muted small">None yet. The agent can propose some from the agent tab.</p> : null}
                    {version.wrongSolutions.map((solution, index) => (
                      <SolutionEditor
                        key={index}
                        value={solution}
                        withLabel
                        readOnly={!editable}
                        onChange={(next) => patch({ wrongSolutions: version.wrongSolutions.map((s, i) => (i === index ? next : s)) })}
                        onRemove={() => patch({ wrongSolutions: version.wrongSolutions.filter((_, i) => i !== index) })}
                      />
                    ))}
                  </>
                ) : null}
              </fieldset>

              {section === 'agent' ? (
                <>
                  <Alert tone="info">
                    The test-hardening agent reads the statement, runs code in the sandbox and proposes extra tests and wrong solutions.
                    Nothing changes until you approve; approving creates a new draft version.
                  </Alert>
                  {proposals.length === 0 ? (
                    <div className="table-wrap">
                      <Empty icon={<Bot size={28} />} title={working === 'harden' ? 'The agent is working…' : 'No proposals yet'}>
                        {working === 'harden' ? 'This takes a few seconds per sandbox run.' : version.reference ? 'Press “harden tests” in the toolbar.' : 'Add a reference solution first.'}
                      </Empty>
                    </div>
                  ) : (
                    <div className="stack">
                      {proposals.map((p) => (
                        <div key={p.id} className="proposal">
                          <div className="proposal-head">
                            <span className="row"><strong>{p.kind === 'test' ? 'test' : 'wrong solution'}</strong><span className="muted small">{p.language}</span></span>
                            {p.status === 'held' ? (
                              <div className="row">
                                <button className="btn primary sm" type="button" disabled={working !== ''} onClick={() => decide(p, 'approve')}><Check size={13} /> approve</button>
                                <button className="btn sm" type="button" disabled={working !== ''} onClick={() => decide(p, 'reject')}><X size={13} /> reject</button>
                              </div>
                            ) : <StatusPill status={p.status} label={p.status} />}
                          </div>
                          <div className="proposal-body">
                            <div><p className="label" style={{ marginTop: 0 }}>{p.kind === 'test' ? 'input' : 'code'}</p><pre>{p.kind === 'test' ? p.stdin : p.code}</pre></div>
                            <div><p className="label" style={{ marginTop: 0 }}>{p.kind === 'test' ? 'expected (from the reference)' : 'why'}</p><pre>{p.kind === 'test' ? p.expected : 'should fail at least one test'}</pre></div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : null}
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function SolutionEditor({ value, onChange, withLabel, readOnly, onRemove }: {
  value: Solution;
  onChange: (next: Solution) => void;
  withLabel?: boolean;
  readOnly?: boolean;
  onRemove?: () => void;
}) {
  return (
    <div className="solution">
      <div className="solution-head">
        {withLabel ? <input aria-label="Label" value={value.label} onChange={(e) => onChange({ ...value, label: e.target.value })} style={{ maxWidth: '12rem' }} /> : <strong className="small">reference</strong>}
        <select aria-label="Language" value={value.language} onChange={(e) => onChange({ ...value, language: e.target.value as Language })}>
          {LANGUAGES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <span className="grow" />
        {onRemove ? <button className="btn danger sm" type="button" onClick={onRemove} aria-label={`Remove ${value.label}`}><Trash2 size={13} /></button> : null}
      </div>
      <Editor language={value.language} value={value.code} onChange={(code) => onChange({ ...value, code })} height="240px" readOnly={readOnly} />
    </div>
  );
}
