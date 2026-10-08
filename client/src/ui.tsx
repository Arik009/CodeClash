import { AlertTriangle, Check, CheckCircle2, Copy, Info, X, XCircle } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { OFFLINE } from './api';

export type Language = 'python' | 'javascript';

export const LANGUAGES: { id: Language; name: string }[] = [
  { id: 'python', name: 'Python 3' },
  { id: 'javascript', name: 'JavaScript (Node)' },
];

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

export function errorText(error: unknown) {
  if (error instanceof TypeError && /fetch/i.test(error.message)) return OFFLINE;
  return error instanceof Error ? error.message : 'Something went wrong';
}
