import { LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { api, loadSession, saveSession, SIGNED_OUT, type Session } from './api';
import { Admin } from './pages/Admin';
import { Guide } from './pages/Guide';
import { Arena } from './pages/Arena';
import { Auth } from './pages/Auth';
import { Authoring } from './pages/Authoring';
import { ContestRoom } from './pages/ContestRoom';
import { Control } from './pages/Control';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { Practice } from './pages/Practice';
import { Problemset } from './pages/Problemset';
import { Profile } from './pages/Profile';
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

  const role = session?.user.role;
  const unverified = session?.user.emailVerified === false;
  const isSetter = role === 'setter' || role === 'admin';
  const isOrganiser = role === 'organiser' || role === 'admin';
  const signIn = <Navigate to="/auth" state={{ from: location.pathname }} />;
  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="header">
        <div className="header-in">
          <Link to="/" className="brand" aria-label="CodeClash home"><span className="brand-mark">&gt;_</span>codeclash</Link>
          <nav className="menu" aria-label="Main">
            <NavLink to="/arena">contests</NavLink>
            <NavLink to="/problemset">problemset</NavLink>
            {isSetter ? <NavLink to="/authoring">authoring</NavLink> : null}
            {isOrganiser ? <NavLink to="/control">control</NavLink> : null}
            {role === 'admin' ? <NavLink to="/admin">admin</NavLink> : null}
            {role === 'admin' ? <NavLink to="/guide">guide</NavLink> : null}
          </nav>
          <div className="header-right">
            <ThemePicker />
            {session ? (
              <>
                <Link to="/profile" className="who" title="Profile">
                  <span className="avatar" aria-hidden>{(session.user.displayName ?? '?').slice(0, 1).toUpperCase()}</span>
                  <span className="name">{session.user.displayName ?? 'you'}</span>
                </Link>
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
          <Route path="/auth" element={session && !unverified ? <Navigate to="/arena" /> : <Auth onSession={setSession} />} />
          <Route path="/arena" element={<Arena />} />
          <Route path="/arena/:id" element={<ContestRoom me={session?.user.id ?? null} />} />
          <Route path="/problemset" element={<Problemset />} />
          <Route path="/practice/:versionId" element={<Practice signedIn={!!session} />} />
          <Route path="/authoring" element={isSetter ? <Authoring /> : session ? <Navigate to="/arena" /> : signIn} />
          <Route path="/control" element={isOrganiser ? <Control /> : session ? <Navigate to="/arena" /> : signIn} />
          <Route path="/admin" element={role === 'admin' ? <Admin me={session!.user.id} /> : session ? <Navigate to="/arena" /> : signIn} />
          <Route path="/guide" element={role === 'admin' ? <Guide /> : session ? <Navigate to="/arena" /> : signIn} />
          <Route path="/profile" element={session ? <Profile session={session} onSession={setSession} onSignOut={signOut} /> : signIn} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Toaster />
    </>
  );
}

export { api };
