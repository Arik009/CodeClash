import { Check, Palette, Shuffle } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { setTheme, THEMES, useTheme, type Theme } from './theme';

function Preview({ theme }: { theme: Theme }) {
  const c = theme.colors;
  return (
    <div className="theme-preview" style={{ background: c.bg, color: c.fg }}>
      <div><span style={{ color: c.accent }}>def</span> solve(n):</div>
      <div>&nbsp;&nbsp;<span style={{ color: c.muted }}># {theme.dark ? 'dark' : 'light'}</span></div>
      <div className="strip">
        <span style={{ background: c.accent }} />
        <span style={{ background: c.ok }} />
        <span style={{ background: c.bad }} />
        <span style={{ background: c.warn }} />
      </div>
    </div>
  );
}

export function ThemePicker() {
  const theme = useTheme();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<'all' | 'light' | 'dark'>('all');
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', close); };
  }, [open]);

  const shown = THEMES.filter((item) => filter === 'all' || item.dark === (filter === 'dark'));
  function shuffle() {
    const others = THEMES.filter((item) => item.id !== theme.id);
    setTheme(others[Math.floor(Math.random() * others.length)]!.id);
  }

  return (
    <div className="picker" ref={root}>
      <button type="button" className="btn ghost icon sm" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-haspopup="dialog" aria-label={`Theme, ${theme.name}`} title="Theme">
        <Palette size={15} />
      </button>
      {open ? (
        <div className="picker-panel" role="dialog" aria-label="Themes">
          <div className="picker-top">
            <div className="segmented" role="group" aria-label="Filter themes">
              {(['all', 'light', 'dark'] as const).map((item) => (
                <button key={item} type="button" className={filter === item ? 'on' : ''} onClick={() => setFilter(item)}>{item}</button>
              ))}
            </div>
            <button type="button" className="btn sm" onClick={shuffle}><Shuffle size={14} /> surprise me</button>
          </div>
          <div className="theme-grid">
            {shown.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`theme-card ${item.id === theme.id ? 'on' : ''}`}
                onClick={() => setTheme(item.id)}
                aria-pressed={item.id === theme.id}
              >
                <Preview theme={item} />
                <span className="theme-name">
                  {item.name}
                  {item.id === theme.id ? <Check size={13} className="accent" /> : <span className="swatch" style={{ background: `linear-gradient(135deg, ${item.colors.bg} 50%, ${item.colors.accent} 50%)` }} />}
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
