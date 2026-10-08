import { useLocation, Link } from 'react-router-dom';

export function NotFound() {
  const { pathname } = useLocation();
  return (
    <div className="page narrow">
      <div className="terminal" style={{ marginTop: 'var(--space-6)' }}>
        <div className="terminal-top"><i /><i /><i /><span>404</span></div>
        <pre>
          <span className="muted">$</span> cd {pathname}{'\n'}
          <span className="bad">cd: no such page: {pathname}</span>{'\n'}
          <span className="muted">$</span> <span className="cursor" />
        </pre>
      </div>
      <h1 style={{ margin: '1.5rem 0 0.5rem' }}>Nothing here.</h1>
      <p className="muted">The link may be old, or the contest was removed.</p>
      <div className="row"><Link className="btn primary" to="/arena">go to contests</Link><Link className="btn" to="/">home</Link></div>
    </div>
  );
}
