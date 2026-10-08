import { BookOpen, FileUp, RotateCcw, Send } from 'lucide-react';
import { Fragment, useRef, useState, type ReactNode } from 'react';
import {
  CopyButton, Editor, errorText, LANGUAGES, letter, STARTERS, toast, useDraft, useLanguage, useSubmission, VerdictCard,
  VERDICT_NAMES, verdictTone, type Language, type SubmissionState,
} from './ui';

export type Limits = Partial<Record<Language, { timeMs: number; memoryMb: number }>> | null | undefined;

export interface ProblemData {
  title: string;
  statement: string;
  samples: string;
  editorial?: string | null;
  limits?: Limits;
  tags?: string[];
}

const HEADINGS = /^(input|output|note|notes|constraints|examples?|explanation|interaction|scoring)\s*:?$/i;

function inline(text: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((part, index) => (
    part.startsWith('`') && part.endsWith('`') && part.length > 2
      ? <code key={index}>{part.slice(1, -1)}</code>
      : <Fragment key={index}>{part}</Fragment>
  ));
}

/** Plain-text statements: blank lines split paragraphs, a line such as "Input" becomes a section title, `x` is code. */
export function Statement({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  text.split(/\n\s*\n/).forEach((block, index) => {
    const lines = block.split('\n');
    if (HEADINGS.test(lines[0]?.trim() ?? '')) {
      blocks.push(<div key={`h${index}`} className="section-title">{lines[0]!.trim().replace(/:$/, '')}</div>);
      lines.shift();
    }
    const body = lines.join('\n').trim();
    if (body) blocks.push(<p key={`p${index}`} style={{ whiteSpace: 'pre-wrap' }}>{inline(body)}</p>);
  });
  return <div className="statement prose">{blocks}</div>;
}

export function parseSamples(text: string) {
  const pairs: { input: string; output: string }[] = [];
  let mode: 'input' | 'output' | null = null;
  let input: string[] = [];
  let output: string[] = [];
  const flush = () => {
    if (input.length || output.length) pairs.push({ input: input.join('\n').trim(), output: output.join('\n').trim() });
    input = [];
    output = [];
  };
  for (const line of text.split('\n')) {
    const marker = line.trim().toLowerCase().replace(/:$/, '');
    if (marker === 'input') {
      if (mode === 'output') flush();
      mode = 'input';
    } else if (marker === 'output') {
      mode = 'output';
    } else if (mode === 'input') {
      input.push(line);
    } else if (mode === 'output') {
      output.push(line);
    }
  }
  flush();
  if (pairs.length === 0 && text.trim()) pairs.push({ input: text.trim(), output: '' });
  return pairs;
}

export function Samples({ text }: { text: string }) {
  const pairs = parseSamples(text);
  if (pairs.length === 0) return null;
  return (
    <>
      <div className="section-title">{pairs.length > 1 ? 'Examples' : 'Example'}</div>
      <div className="samples">
        {pairs.map((pair, index) => (
          <div key={index} className="sample">
            <div>
              <div className="sample-head"><span>input</span><CopyButton text={pair.input} /></div>
              <pre>{pair.input}</pre>
            </div>
            <div>
              <div className="sample-head"><span>output</span><CopyButton text={pair.output} /></div>
              <pre>{pair.output}</pre>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

export function LimitsLine({ limits, language }: { limits: Limits; language: Language }) {
  const limit = limits?.[language] ?? { timeMs: 2000, memoryMb: 256 };
  const seconds = limit.timeMs / 1000;
  return (
    <div className="limits">
      <span>time limit per test <b>{seconds} {seconds === 1 ? 'second' : 'seconds'}</b></span>
      <span>memory limit per test <b>{limit.memoryMb} megabytes</b></span>
      <span>input <b>stdin</b></span>
      <span>output <b>stdout</b></span>
    </div>
  );
}

export function ProblemView({ problem, index, language, editorial = 'toggle' }: {
  problem: ProblemData;
  index?: number;
  language: Language;
  editorial?: 'toggle' | 'always';
}) {
  const [open, setOpen] = useState(editorial === 'always');
  const tags = Array.isArray(problem.tags) ? problem.tags : [];
  return (
    <article className="problem">
      <header className="problem-head">
        <h2>{index !== undefined ? `${letter(index)}. ` : ''}{problem.title}</h2>
        <LimitsLine limits={problem.limits} language={language} />
        {tags.length ? <div className="row tags-line">{tags.map((tag, tagIndex) => <span key={`${tag}-${tagIndex}`} className="chip">{tag}</span>)}</div> : null}
      </header>
      <Statement text={problem.statement} />
      {problem.samples ? <Samples text={problem.samples} /> : null}
      {problem.editorial ? (
        <div className="editorial">
          {editorial === 'toggle' ? (
            <button className="btn sm" type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              <BookOpen size={14} /> {open ? 'hide editorial' : 'show editorial'}
            </button>
          ) : <div className="section-title">Editorial</div>}
          {open ? <div className="editorial-body"><Statement text={problem.editorial} /></div> : null}
        </div>
      ) : null}
    </article>
  );
}

/** Editor, language, draft and the live verdict of the last submission, shared by contests and practice. */
export function CodePanel({ draftKey, submit, run, blocked, label, onJudged, onLanguage }: {
  draftKey: string;
  submit: (language: Language, code: string) => Promise<string>;
  /** Runs the sample tests and stores nothing. */
  run?: (language: Language, code: string) => Promise<{ results: { verdict: string }[] }>;
  /** When set, submitting is disabled and this explains why. */
  blocked?: string;
  label: string;
  onJudged?: (row: SubmissionState) => void;
  onLanguage?: (language: Language) => void;
}) {
  const [language, setLanguageState] = useLanguage();
  const [code, setCode] = useDraft(`${draftKey}.${language}`, STARTERS[language]);
  const [submission, setSubmission] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [samples, setSamples] = useState('');
  const footRef = useRef<HTMLDivElement>(null);
  const reveal = () => requestAnimationFrame(() => footRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  const verdict = useSubmission(submission, (row) => {
    reveal();
    toast(`${label} · ${VERDICT_NAMES[row.verdict ?? ''] ?? row.verdict}`, verdictTone(row.verdict) === 'ok' ? 'ok' : verdictTone(row.verdict) === 'warn' ? 'warn' : 'bad');
    onJudged?.(row);
  });

  function setLanguage(next: Language) {
    setLanguageState(next);
    onLanguage?.(next);
  }

  async function trySamples() {
    if (!run || blocked || busy) return;
    if (!code.trim()) { setError('Write some code first.'); return; }
    setError('');
    setBusy(true);
    try {
      const outcome = await run(language, code);
      const passed = outcome.results.filter((row) => row.verdict === 'AC').length;
      const text = `${passed}/${outcome.results.length} samples accepted`;
      setSamples(text);
      toast(text, passed === outcome.results.length ? 'ok' : 'warn');
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function send() {
    if (blocked || busy) return;
    if (!code.trim()) { setError('Write some code first.'); return; }
    setError('');
    setBusy(true);
    try {
      setSubmission(await submit(language, code));
      reveal();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  async function openFile(file: File) {
    setCode(await file.text());
    const name = file.name.toLowerCase();
    if (name.endsWith('.js')) setLanguage('javascript');
    if (name.endsWith('.py')) setLanguage('python');
  }

  const judging = verdict !== null && !verdict.verdict;
  return (
    <section className="code-panel" aria-label="Solution">
      <div className="code-toolbar">
        <select aria-label="Language" value={language} onChange={(e) => setLanguage(e.target.value as Language)}>
          {LANGUAGES.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <span className="grow" />
        <label className="btn ghost sm file" title="Open a source file" style={{ margin: 0 }}>
          <FileUp size={14} /> open
          <input type="file" accept=".py,.js,.txt" onChange={(e) => { const file = e.target.files?.[0]; if (file) void openFile(file); e.target.value = ''; }} />
        </label>
        <CopyButton text={code} />
        <button className="btn ghost sm" type="button" onClick={() => { if (window.confirm('Replace your code with the starter template?')) setCode(STARTERS[language]); }}>
          <RotateCcw size={14} /> reset
        </button>
      </div>
      <Editor language={language} value={code} onChange={setCode} onSubmit={send} height="clamp(260px, calc(100vh - 430px), 600px)" />
      <div className="code-foot" ref={footRef}>
        <div className="row between">
          <span className="muted small">{blocked ?? <>submit with <kbd>Ctrl</kbd> + <kbd>Enter</kbd></>}</span>
          <span className="row">
            {run ? <button className="btn sm" type="button" onClick={trySamples} disabled={!!blocked || busy || judging}>run samples</button> : null}
            <button className="btn primary" type="button" onClick={send} disabled={!!blocked || busy || judging}>
              <Send size={14} /> {busy ? 'sending…' : judging ? 'judging…' : 'submit'}
            </button>
          </span>
        </div>
        {samples ? <p className="muted small" style={{ margin: 0 }} role="status">{samples}. Nothing was recorded.</p> : null}
        {error ? <div className="alert bad" style={{ margin: 0 }}>{error}</div> : null}
        <VerdictCard row={verdict} />
      </div>
    </section>
  );
}
