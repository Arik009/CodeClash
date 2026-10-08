import { FilePlus2, FileUp, Plus, Save, Search, ShieldCheck, Trash2, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isAbort } from '../api';
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
  inputSpec: string;
  source: { name: string; url?: string; license?: string } | null;
  status: string;
  report: string[];
}
interface SpecCheck { ok: boolean; parseError: string | null; failures: { test: number; error: string }[]; checked: number; drafted: string | null }
type Section = 'statement' | 'tests' | 'spec' | 'solutions';

const EDITABLE = ['draft', 'blocked'];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function tagList(tags: unknown): string[] {
  const source = Array.isArray(tags) ? tags : [];
  return source.map((tag) => String(tag).trim()).filter(Boolean);
}

export function Authoring() {
  const [params, setParams] = useSearchParams();
  const versionId = params.get('v') ?? '';
  const [problems, setProblems] = useState<ProblemRow[]>([]);
  const [filter, setFilter] = useState('');
  const [version, setVersion] = useState<Version | null>(null);
  const [dirty, setDirty] = useState(false);
  const [section, setSection] = useState<Section>('statement');
  const [specCheck, setSpecCheck] = useState<SpecCheck | null>(null);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newStatement, setNewStatement] = useState('');
  const [newDifficulty, setNewDifficulty] = useState<'easy' | 'medium' | 'hard'>('easy');
  const [working, setWorking] = useState('');
  const [error, setError] = useState('');
  const [tagText, setTagText] = useState('');

  const loadProblems = useCallback(() => api<ProblemRow[]>('/api/problems').then(setProblems), []);
  const loadVersion = useCallback(async (id: string, signal?: AbortSignal) => {
    if (!id) { setVersion(null); setTagText(''); return; }
    const next = await api<Version>(`/api/problem-versions/${id}`, { signal });
    if (signal?.aborted) return;
    setVersion({ ...next, tags: tagList(next.tags), inputSpec: next.inputSpec ?? '' });
    setTagText(tagList(next.tags).join(', '));
    setSpecCheck(null);
    setDirty(false);
  }, []);

  useEffect(() => { loadProblems().catch((e) => setError(errorText(e))); }, [loadProblems]);
  useEffect(() => {
    if (!creating) return undefined;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setCreating(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [creating]);
  useEffect(() => {
    const controller = new AbortController();
    loadVersion(versionId, controller.signal).catch((e) => { if (!isAbort(e)) setError(errorText(e)); });
    return () => controller.abort();
  }, [versionId, loadVersion]);

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

  function onTags(value: string) {
    setTagText(value);
    patch({ tags: tagList(value.split(',')) });
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
        body: JSON.stringify({ title: version.title, statement: version.statement, samples: version.samples, editorial: version.editorial, tags: version.tags, difficulty: version.difficulty, inputSpec: version.inputSpec }),
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

  async function checkSpec() {
    if (!version) return;
    await guarded('spec', async () => {
      setSpecCheck(await api<SpecCheck>(`/api/problem-versions/${version.versionId}/spec-check`, {
        method: 'POST',
        body: JSON.stringify({ inputSpec: version.inputSpec }),
      }));
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
                {([['statement', 'statement'], ['tests', 'tests'], ['spec', 'spec'], ['solutions', 'solutions']] as const).map(([key, name]) => (
                  <button key={key} type="button" role="tab" aria-selected={section === key} className={`tab ${section === key ? 'on' : ''}`} onClick={() => setSection(key)}>
                    {name}
                    {key === 'tests' ? <span className="count">{version.tests.length}</span> : null}
                    {key === 'spec' && !version.inputSpec.trim() ? <span className="count">none</span> : null}
                    {key === 'solutions' ? <span className="count">{(version.reference ? 1 : 0) + version.wrongSolutions.length}</span> : null}
                  </button>
                ))}
              </nav>
              <div className="author-body">

              {section === 'statement' ? (
                <div className="two">
                  <fieldset disabled={!editable || working !== ''}>
                      <div className="field-row">
                        <div><label htmlFor="title" style={{ marginTop: 0 }}>Title</label><input id="title" value={version.title} onChange={(e) => patch({ title: e.target.value })} /></div>
                        <div><label htmlFor="tags" style={{ marginTop: 0 }}>Tags (comma separated)</label><input id="tags" value={tagText} onChange={(e) => onTags(e.target.value)} /></div>
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
                    <div className="row between" style={{ marginBottom: 'var(--space-3)' }}>
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
                            <div className="stack tight">
                              <input aria-label={`Test ${index + 1} subtask`} placeholder="subtask" value={test.group ?? ''} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, group: e.target.value } : t)) })} />
                              <label className="check"><input type="checkbox" checked={test.hidden} onChange={(e) => patch({ tests: version.tests.map((t, i) => (i === index ? { ...t, hidden: e.target.checked } : t)) })} /> hidden</label>
                              <button className="btn danger sm" type="button" onClick={() => patch({ tests: version.tests.filter((_, i) => i !== index) })} aria-label={`Remove test ${index + 1}`}><Trash2 size={13} /></button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="row between" style={{ marginTop: 'var(--space-4)' }}>
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

                {section === 'spec' ? (
                  <div className="two">
                    <div>
                      <label htmlFor="spec" style={{ marginTop: 0 }}>Input spec · one line per input line</label>
                      <textarea
                        id="spec"
                        className="mono-area"
                        spellCheck={false}
                        value={version.inputSpec}
                        onChange={(e) => { patch({ inputSpec: e.target.value }); setSpecCheck(null); }}
                        placeholder={'n int 1..2*10^5\na int[n] -10^9..10^9'}
                        style={{ minHeight: '12rem' }}
                      />
                      <div className="row" style={{ marginTop: 'var(--space-2)' }}>
                        <button className="btn sm" type="button" onClick={checkSpec} disabled={working !== ''}><ShieldCheck size={14} /> {working === 'spec' ? 'checking…' : 'check against tests'}</button>
                        {specCheck?.drafted && specCheck.drafted !== version.inputSpec.trim() ? (
                          <button className="btn ghost sm" type="button" onClick={() => { patch({ inputSpec: specCheck.drafted! }); setSpecCheck(null); }}>use the spec drafted from the statement</button>
                        ) : null}
                      </div>
                      {specCheck ? (
                        specCheck.parseError ? <Alert tone="bad">{specCheck.parseError}</Alert>
                          : specCheck.ok ? <Alert tone="ok">All {specCheck.checked} tests are valid under this spec.</Alert>
                            : (
                              <Alert tone="bad">
                                <strong>{specCheck.failures.length} test(s) break this spec</strong>
                                <ul>{specCheck.failures.map((f) => <li key={f.test}>test #{f.test}: {f.error}</li>)}</ul>
                              </Alert>
                            )
                      ) : null}
                    </div>
                    <div className="spec-help small">
                      <p className="label" style={{ marginTop: 0 }}>Syntax</p>
                      <pre>{[
                        'n int 1..2*10^5, k int 0..n   one line, two integers',
                        'a int[n] -10^9..10^9          n integers on one line',
                        's str[1..n] a-z               a string and its alphabet',
                        'lines n-1: u int 1..n, v int 1..n',
                        't int 1..10^4',
                        'repeat t:                     the indented block, t times',
                        '  n int 1..10^5',
                        'sum n <= 2*10^5               over all repeats',
                      ].join('\n')}</pre>
                      <p className="muted">
                        Hardening validates every generated or model-proposed input against this spec before it runs.
                        Without one, it drafts a spec from the statement and keeps it only if every current test fits.
                      </p>
                    </div>
                  </div>
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
                    {version.wrongSolutions.length === 0 ? <p className="muted small">None yet.</p> : null}
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
