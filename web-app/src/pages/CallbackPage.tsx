import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getStoredTokens } from '../api/client';

export default function CallbackPage() {
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get('redirect') || '/admin';
  const [tokens] = useState(() => getStoredTokens());
  const [autoTriggered, setAutoTriggered] = useState(false);

  const callbackUrl = tokens
    ? (() => {
        const url = new URL('interview-assistant://callback');
        url.searchParams.set('access_token', tokens.accessToken);
        url.searchParams.set('refresh_token', tokens.refreshToken);
        url.searchParams.set('redirect', redirectTo);
        return url.toString();
      })()
    : null;

  useEffect(() => {
    if (callbackUrl && !autoTriggered) {
      setAutoTriggered(true);
      window.location.href = callbackUrl;
    }
  }, [callbackUrl, autoTriggered]);

  if (!tokens) {
    return (
      <main className="auth-status-page">
        <section className="auth-status-card" aria-labelledby="session-missing-title">
          <a href="/" className="auth-status-logo" aria-label="Cueviq home">
            <img className="theme-logo theme-logo-dark" src="/cueviq_logo_dark.svg" alt="Cueviq" />
            <img className="theme-logo theme-logo-light" src="/cueviq_logo_light.svg" alt="Cueviq" />
          </a>
          <span className="auth-status-icon auth-status-icon-alert" aria-hidden="true">!</span>
          <h1 id="session-missing-title">Session not found</h1>
          <p>Please sign in first, then return to the Cueviq desktop app.</p>
          <a href="/login?desktop=1" className="btn btn-primary auth-status-action">Go to sign in</a>
        </section>
      </main>
    );
  }

  return (
    <main className="auth-status-page">
      <section className="auth-status-card" aria-labelledby="callback-success-title">
        <a href="/" className="auth-status-logo" aria-label="Cueviq home">
          <img className="theme-logo theme-logo-dark" src="/cueviq_logo_dark.svg" alt="Cueviq" />
          <img className="theme-logo theme-logo-light" src="/cueviq_logo_light.svg" alt="Cueviq" />
        </a>
        <span className="auth-status-icon" aria-hidden="true">✓</span>
        <h1 id="callback-success-title">Signed in successfully</h1>
        <p>
          {autoTriggered
            ? 'Cueviq should open automatically. If it does not, use the button below.'
            : 'Continue to the Cueviq desktop app.'}
        </p>
        <a href={callbackUrl!} className="btn btn-primary auth-status-action" onClick={() => setAutoTriggered(true)}>
          Open Cueviq
        </a>
        <p className="auth-status-fallback">
          App not launching? Make sure it is running or <a href="/download">download it here</a>.
        </p>
      </section>
    </main>
  );
}
