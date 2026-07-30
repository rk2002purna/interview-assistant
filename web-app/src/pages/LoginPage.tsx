import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { login, loginWithGoogle, isAuthSession, getStoredTokens } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';
import GoogleSignInButton from '../components/GoogleSignInButton';
import AuthShowcase from '../components/AuthShowcase';

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = searchParams.get('redirect') || (isAuthSession() ? '/admin' : '/');
  const fromDesktop = searchParams.get('desktop') === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [resending, setResending] = useState(false);
  const [resendSent, setResendSent] = useState(false);

  // If already logged in and came from desktop, redirect back to desktop app
  useEffect(() => {
    if (fromDesktop && isAuthSession()) {
      const tokens = getStoredTokens()!;
      const callbackUrl = `interview-assistant://callback?access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`;
      window.location.href = callbackUrl;
    }
  }, [fromDesktop]);

  // If already logged in (non-desktop), redirect
  if (!fromDesktop && isAuthSession() && !searchParams.get('redirect')) {
    navigate('/admin', { replace: true });
    return null;
  }

  async function handleResendVerification() {
    if (!email) return;
    setResending(true);
    setResendSent(false);
    try {
      const apiBase = import.meta.env.VITE_API_BASE_URL ?? '/api';
      await fetch(`${apiBase}/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setResendSent(true);
    } catch {
      // Silently handle — the endpoint always returns {sent: true}.
      setResendSent(true);
    } finally {
      setResending(false);
    }
  }

  // Completes sign-in after the browser reaches an authenticated state.
  // For the desktop app we hand tokens back through the custom protocol URL
  // the Electron app already listens for; otherwise we do a normal redirect.
  function completeAuthRedirect() {
    if (fromDesktop) {
      window.location.href = `/callback?redirect=${encodeURIComponent(redirectTo)}`;
    } else {
      // Full page reload so Header picks up the new auth state.
      window.location.href = redirectTo;
    }
  }

  async function handleGoogleCredential(idToken: string) {
    setError('');
    setLoading(true);
    const result = await loginWithGoogle(idToken);
    if (result.success) {
      completeAuthRedirect();
    } else {
      setError(result.error);
      setLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError('');
    setLoading(true);

    const result = await login(email, password);
    if (result.success) {
      completeAuthRedirect();
    } else {
      setError(result.error);
      if (result.error.toLowerCase().includes('not been verified')) {
        setError('Your email address has not been verified yet. Please check your inbox or resend the verification email below.');
      }
    }
    setLoading(false);
  }

  return (
    <>
      {loading && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <div className="loading-text">Signing you in…</div>
        </div>
      )}
      <Header />
      <main className="auth-page auth-page-login">
        <div className="auth-page-glow" aria-hidden="true" />
        <div className="auth-shell">
          <AuthShowcase variant="login" desktop={fromDesktop} />

          <section className="auth-panel" aria-labelledby="login-title">
            <div className="auth-panel-inner">
              <div className="auth-panel-heading">
                <span className="auth-panel-kicker">{fromDesktop ? 'Continue to desktop' : 'Welcome back'}</span>
                <h1 id="login-title">Sign in to Cueviq</h1>
                <p>{fromDesktop ? 'Use your account to connect the Cueviq desktop app.' : 'Continue to your interview workspace and wallet.'}</p>
              </div>

              {error && (
                <div className="auth-alert auth-alert-error" role="alert">
                  <p>{error}</p>
                  {error.includes('not been verified') && (
                    <button
                      type="button"
                      onClick={handleResendVerification}
                      disabled={resending}
                      className="auth-resend-button"
                    >
                      {resending ? 'Sending…' : resendSent ? 'Sent! Check your inbox' : 'Resend verification email'}
                    </button>
                  )}
                </div>
              )}

              <GoogleSignInButton
                onCredential={handleGoogleCredential}
                onError={(message) => setError(message)}
                disabled={loading}
              />

              <div className="auth-divider" role="separator"><span>or continue with email</span></div>

              <form className="auth-form" onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="email" className="form-label">Email address</label>
                  <input
                    id="email"
                    type="email"
                    className="form-input"
                    value={email}
                    onChange={(event) => setEmail(event.target.value)}
                    required
                    autoComplete="email"
                    placeholder="you@example.com"
                    disabled={loading}
                  />
                </div>

                <div className="form-group">
                  <div className="auth-label-row">
                    <label htmlFor="password" className="form-label">Password</label>
                    <Link to="/forgot-password">Forgot password?</Link>
                  </div>
                  <input
                    id="password"
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    disabled={loading}
                  />
                </div>

                <button type="submit" disabled={loading} className="btn btn-primary auth-submit">
                  {loading ? 'Signing in…' : 'Sign in'}
                  {!loading && <span aria-hidden="true">→</span>}
                </button>
              </form>

              <p className="auth-switch">
                New to Cueviq? <Link to={`/register${fromDesktop ? '?desktop=1' : ''}`}>Create a free account</Link>
              </p>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
