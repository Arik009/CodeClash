import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, loadSession, saveSession, SIGNED_OUT, type Session } from './api';
import { Auth } from './pages/Auth';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { ThemePicker } from './ThemePicker';
import { Toaster } from './ui';

export default function App() {
  const [session, setSession] = useState<Session | null>(loadSession());
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => { saveSession(session); }, [session]);

  useEffect(() => {
    const expired = () => {
      setSession(null);
      navigate('/auth');
    };
    window.addEventListener(SIGNED_OUT, expired);
    return () => window.removeEventListener(SIGNED_OUT, expired);
  }, [navigate]);

  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  function signOut() {
    if (session) void api('/api/auth/logout', { method: 'POST', body: JSON.stringify({ refresh: session.refresh }) }).catch(() => {});
    setSession(null);
    navigate('/');
  }

  const unverified = session?.user.emailVerified === false;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="header">
        <div className="header-in">
          <Link to="/" className="brand" aria-label="CodeClash home"><span className="brand-mark">&gt;_</span>codeclash</Link>
          <div className="header-right">
            <ThemePicker />
            {session ? (
              <>
                <span className="who">
                  <span className="avatar" aria-hidden>{(session.user.displayName ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className="name">{session.user.displayName ?? 'you'}</span>
                </span>
                <button className="btn ghost icon sm" type="button" onClick={signOut} aria-label="Sign out" title="Sign out"><LogOut size={15} /></button>
              </>
            ) : <Link className="btn primary sm" to="/auth">sign in</Link>}
          </div>
        </div>
      </header>
      {unverified ? (
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="alert warn" role="status">Confirm your email before you take a seat or submit. <Link to="/auth">Open the confirmation page</Link></div>
        </div>
      ) : null}
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home signedIn={!!session} />} />
          <Route path="/auth" element={session && !unverified ? <Navigate to="/" /> : <Auth onSession={setSession} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Toaster />
    </>
  );
}

export { api };
