import { FilePlus2, Plus, Save, Search, X } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api, isAbort } from '../api';
import { ProblemView } from '../problem';
import { Alert, Empty, errorText, StatusPill, toast, type Language } from '../ui';

interface ProblemRow { problemId: string; versionId: string; version: number; title: string; status: string }
interface Test { input: string; output: string; hidden: boolean }
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
  tests: Test[];
  reference: { language: Language; code: string } | null;
  wrongSolutions: Solution[];
  status: string;
  report: string[];
}
type Section = 'statement';

const EDITABLE = ['draft', 'blocked'];

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
    setVersion({ ...next, tags: tagList(next.tags) });
    setTagText(tagList(next.tags).join(', '));
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
        body: JSON.stringify({ title: version.title, statement: version.statement, samples: version.samples, editorial: version.editorial, tags: version.tags, difficulty: version.difficulty }),
      });
      await Promise.all([loadVersion(version.versionId), loadProblems()]);
      toast('Saved', 'ok');
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
                </div>
              </div>


              <nav className="tabs" role="tablist" aria-label="Sections">
                {([['statement', 'statement']] as const).map(([key, name]) => (
                  <button key={key} type="button" role="tab" aria-selected={section === key} className={`tab ${section === key ? 'on' : ''}`} onClick={() => setSection(key)}>
                    {name}
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
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
