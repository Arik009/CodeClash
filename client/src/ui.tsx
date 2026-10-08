import { AlertTriangle, Check, CheckCircle2, Copy, Info, Loader2, X, XCircle } from 'lucide-react';
import { lazy, Suspense, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { api, OFFLINE } from './api';

const LazyEditor = lazy(() => import('./monaco'));

export type Language = 'python' | 'javascript';

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: 'python', name: 'Python 3' },
  { id: 'javascript', name: 'JavaScript (Node)' },
];

export const STARTERS: Record<Language, string> = {
  python: 'import sys\n\ndata = sys.stdin.read().split()\n# read from data, print the answer\n',
  javascript: "const data = require('fs').readFileSync(0, 'utf8').trim().split(/\\s+/);\n// read from data, print the answer\n",
};

export function Editor(props: {
  language: Language;
  value: string;
  onChange: (value: string) => void;
  height?: string;
  readOnly?: boolean;
  onSubmit?: () => void;
}) {
  return (
    <div className="editor" style={{ height: props.height ?? '360px' }}>
      <Suspense fallback={<div className="editor-loading"><Loader2 size={18} className="spin" /></div>}>
        <LazyEditor {...props} />
      </Suspense>
    </div>
  );
}

/** Keeps one draft per key in localStorage so a reload does not lose code. */
export function useDraft(key: string, fallback: string) {
  const [value, setValue] = useState(() => localStorage.getItem(key) ?? fallback);
  useEffect(() => { setValue(localStorage.getItem(key) ?? fallback); }, [key, fallback]);
  function update(next: string) {
    setValue(next);
    localStorage.setItem(key, next);
  }
  return [value, update] as const;
}

/** Remembers the last language across problems. */
export function useLanguage() {
  const [language, setLanguage] = useState<Language>(() => {
    const stored = localStorage.getItem('cc.language');
    return LANGUAGES.some((item) => item.id === stored) ? stored as Language : 'python';
  });
  function update(next: Language) {
    setLanguage(next);
    localStorage.setItem('cc.language', next);
  }
  return [language, update] as const;
}

export interface SubmissionState { status: string; verdict: string | null; reason: string | null }

export function useSubmission(id: string, onDone?: (row: SubmissionState) => void) {
  const [row, setRow] = useState<SubmissionState | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(() => {
    if (!id) return;
    setRow({ status: 'queued', verdict: null, reason: null });
    let stopped = false;
    const timer = setInterval(() => {
      api<SubmissionState>(`/api/submissions/${id}`).then((next) => {
        if (stopped) return;
        setRow(next);
        if (next.verdict) {
          stopped = true;
          clearInterval(timer);
          done.current?.(next);
        }
      }).catch(() => {});
    }, 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, [id]);
  return row;
}

export const VERDICT_NAMES: Record<string, string> = {
  AC: 'Accepted',
  WA: 'Wrong answer',
  TLE: 'Time limit exceeded',
  MLE: 'Memory limit exceeded',
  RE: 'Runtime error',
  CE: 'Compilation error',
};

export function verdictTone(verdict: string | null) {
  if (!verdict) return 'accent';
  if (verdict === 'AC') return 'ok';
  if (verdict === 'TLE' || verdict === 'MLE') return 'warn';
  if (verdict === 'CE') return 'muted';
  return 'bad';
}

/** The live result of the latest submission, with the judge's reason when it failed. */
export function VerdictCard({ row }: { row: SubmissionState | null }) {
  if (!row) return null;
  if (!row.verdict) {
    return (
      <div className="verdict-card" aria-live="polite">
        <Loader2 size={18} className="spin accent" />
        <div><span className="verdict pending">{row.status === 'running' ? 'Running on tests…' : 'In queue…'}</span></div>
      </div>
    );
  }
  const Icon = row.verdict === 'AC' ? CheckCircle2 : row.verdict === 'TLE' || row.verdict === 'MLE' ? AlertTriangle : XCircle;
  return (
    <div className={`verdict-card ${row.verdict.toLowerCase()}`} aria-live="polite">
      <Icon size={18} className={verdictTone(row.verdict)} />
      <div className="grow">
        <span className={`verdict ${row.verdict.toLowerCase()}`}>{VERDICT_NAMES[row.verdict] ?? row.verdict}</span>
        {row.reason && row.verdict !== 'AC' ? <pre>{row.reason}</pre> : null}
      </div>
    </div>
  );
}

export function VerdictText({ verdict, status }: { verdict: string | null; status: string }) {
  if (!verdict) {
    return <span className="verdict pending"><Loader2 size={12} className="spin" /> {status === 'running' ? 'Running' : 'In queue'}</span>;
  }
  return <span className={`verdict ${verdict.toLowerCase()}`} title={verdict}>{VERDICT_NAMES[verdict] ?? verdict}</span>;
}

export const STATUS_LABEL: Record<string, string> = {
  draft: 'draft',
  registration_open: 'registration',
  running: 'live',
  frozen: 'frozen',
  ended: 'ended',
  published: 'final',
  cancelled: 'cancelled',
};

const STATUS_TONE: Record<string, string> = {
  registration_open: 'upcoming',
  running: 'live',
  frozen: 'frozen',
  published: 'ok',
  cancelled: 'bad',
  checking: 'accent',
  blocked: 'bad',
  superseded: '',
  active: 'ok',
  draining: 'warn',
  evicted: 'bad',
  stale: '',
};

export function StatusPill({ status, label }: { status: string; label?: string }) {
  return <span className={`pill ${STATUS_TONE[status] ?? ''}`}>{label ?? STATUS_LABEL[status] ?? status}</span>;
}

export function Box({ title, action, children, flush }: { title: string; action?: ReactNode; children: ReactNode; flush?: boolean }) {
  return (
    <section className="box">
      <header className="box-head"><strong>{title}</strong>{action}</header>
      <div className={`box-body ${flush ? 'flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Empty({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Alert({ tone = 'bad', children }: { tone?: 'bad' | 'ok' | 'warn' | 'info'; children: ReactNode }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : tone === 'info' ? Info : XCircle;
  return (
    <div className={`alert ${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      <Icon size={16} />
      <div className="grow">{children}</div>
    </div>
  );
}

export function CopyButton({ text, label = 'copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(text).catch(() => {});
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button type="button" className="btn ghost sm" onClick={copy} aria-label={`${label} to clipboard`}>
      {copied ? <Check size={13} className="ok" /> : <Copy size={13} />} {copied ? 'copied' : label}
    </button>
  );
}

// ---------- toasts ----------

interface Toast { id: number; tone: 'ok' | 'bad' | 'warn' | 'info'; text: string }
let toasts: Toast[] = [];
let toastSeq = 0;
const toastListeners = new Set<() => void>();
function emitToasts() { toastListeners.forEach((listener) => listener()); }

export function toast(text: string, tone: Toast['tone'] = 'info') {
  const id = ++toastSeq;
  toasts = [...toasts.slice(-3), { id, tone, text }];
  emitToasts();
  setTimeout(() => dismiss(id), 5000);
}

function dismiss(id: number) {
  toasts = toasts.filter((item) => item.id !== id);
  emitToasts();
}

export function Toaster() {
  const items = useSyncExternalStore(
    (listener) => { toastListeners.add(listener); return () => { toastListeners.delete(listener); }; },
    () => toasts,
  );
  return (
    <div className="toasts" aria-live="polite">
      {items.map((item) => (
        <div key={item.id} className={`toast ${item.tone}`}>
          <span>{item.text}</span>
          <button type="button" className="btn ghost icon sm" onClick={() => dismiss(item.id)} aria-label="Dismiss"><X size={14} /></button>
        </div>
      ))}
    </div>
  );
}

// ---------- time ----------

export function useNow(intervalMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export function formatLeft(ms: number) {
  if (ms <= 0) return '0:00';
  const total = Math.floor(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** Contest length as hh:mm, the way contest tables show it. */
export function formatLength(ms: number) {
  const minutes = Math.round(ms / 60000);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

export function formatWhen(value: string | Date) {
  return new Date(value).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function letter(index: number) {
  return String.fromCharCode(65 + index);
}

export function errorText(error: unknown) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) return OFFLINE;
  return error instanceof Error ? error.message : 'Something went wrong';
}
