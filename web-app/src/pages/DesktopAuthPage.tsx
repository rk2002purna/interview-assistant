import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getStoredTokens, isAuthSession } from '../api/client';

/**
 * Auto-login bridge for the Electron desktop app.
 *
 * Existing browser sessions are handed back through the custom protocol URL.
 * Otherwise, the user continues through the matching browser auth page.
 */
export default function DesktopAuthPage() {
  const [searchParams] = useSearchParams();
  const intent = searchParams.get('intent');
  const [status, setStatus] = useState<'checking' | 'redirecting' | 'no_session'>('checking');

  useEffect(() => {
    try {
      if (isAuthSession()) {
        setStatus('redirecting');
        const tokens = getStoredTokens()!;
        const callbackUrl = `interview-assistant://callback?access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`;
        window.location.href = callbackUrl;
      } else {
        setStatus('no_session');
        const fallbackPath = intent === 'register' ? '/register?desktop=1' : '/login?desktop=1';
        setTimeout(() => {
          window.location.href = fallbackPath;
        }, 800);
      }
    } catch {
      setStatus('no_session');
      const fallbackPath = intent === 'register' ? '/register?desktop=1' : '/login?desktop=1';
      setTimeout(() => {
        window.location.href = fallbackPath;
      }, 800);
    }
  }, [intent]);

  return (
    <main className="auth-status-page">
      <section className="auth-status-card" role="status" aria-live="polite">
        <div className="auth-status-logo" aria-label="Cueviq">
          <img className="theme-logo theme-logo-dark" src="/cueviq_logo_dark.svg" alt="Cueviq" />
          <img className="theme-logo theme-logo-light" src="/cueviq_logo_light.svg" alt="Cueviq" />
        </div>
        <span className="auth-status-loader" aria-hidden="true"><i /></span>
        <h1>Connecting Cueviq</h1>
        <p>
          {status === 'checking' && 'Checking for an existing browser session…'}
          {status === 'redirecting' && 'Session found. Returning to the desktop app…'}
          {status === 'no_session' && `Opening ${intent === 'register' ? 'account creation' : 'sign in'}…`}
        </p>
      </section>
    </main>
  );
}
