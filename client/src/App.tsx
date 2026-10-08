import { useEffect } from 'react';
import { Link, Route, Routes, useLocation } from 'react-router-dom';
import { Home } from './pages/Home';
import { NotFound } from './pages/NotFound';
import { ThemePicker } from './ThemePicker';
import { Toaster } from './ui';

export default function App() {
  const location = useLocation();

  useEffect(() => { window.scrollTo(0, 0); }, [location.pathname]);

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="header">
        <div className="header-in">
          <Link to="/" className="brand" aria-label="CodeClash home"><span className="brand-mark">&gt;_</span>codeclash</Link>
          <div className="header-right">
            <ThemePicker />
          </div>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Home signedIn={false} />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
      </main>
      <Toaster />
    </>
  );
}
