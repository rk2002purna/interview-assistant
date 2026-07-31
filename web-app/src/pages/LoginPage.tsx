import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { login, loginWithGoogle, isAuthSession, getStoredTokens } from '../api/client';
import AuthExperience from '../components/AuthExperience';
import Header from '../components/Header';
import Footer from '../components/Footer';
import GoogleSignInButton from '../components/GoogleSignInButton';

/**
 * Restrict post-login navigation to same-origin, absolute in-app paths.
 * Accepts only values that begin with a single "/" (not "//" or "/\", which
 * are protocol-relative and navigate off-origin) and carry no scheme. Anything
 * else — a "javascript:" URI, an absolute "https://evil" URL, a
 * protocol-relative "//evil" — collapses to the safe fallback. Prevents the
 * open-redirect and redirect-to-XSS classes (findings F7/F8).
 */
function sanitizeRedirect(raw: string | null, fallback: string): string {
  if (!raw) return fallback;
  if (!/^\/(?![/\\])[^\s]*$/.test(raw)) return fallback;
  return raw;
}

export default function LoginPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const redirectTo = sanitizeRedirect(
    searchParams.get('redirect'),
    isAuthSession() ? '/admin' : '/',
  );
  const fromDesktop = searchParams.get('desktop') === '1';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
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
      // Silently handle: the endpoint intentionally always returns { sent: true }.
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
      // Desktop app OAuth flow: CallbackPage hands tokens back through the
      // interview-assistant:// protocol.
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
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
          <div className="spinner" />
          <div className="loading-text">Signing you in…</div>
        </div>
      )}
      <Header />
      <AuthExperience
        mode="login"
        eyebrow={fromDesktop ? 'Secure desktop connection' : 'Secure member access'}
        title="Welcome back"
        subtitle={fromDesktop ? 'Sign in to securely connect and activate the desktop app.' : 'Continue to your private UpNod workspace.'}
      >
        <div className="auth-google-slot">
          <GoogleSignInButton
            onCredential={handleGoogleCredential}
            onError={(message) => setError(message)}
            disabled={loading}
          />
        </div>

        <div className="auth-divider" role="separator">
          <span>or continue with email</span>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} aria-busy={loading}>
          {error && (
            <div className="auth-alert auth-alert--error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6M12 17h.01" />
              </svg>
              <div className="auth-alert-copy">
                <strong>Unable to sign in</strong>
                <span>{error}</span>
                {error.includes('not been verified') && (
                  <button
                    type="button"
                    onClick={handleResendVerification}
                    disabled={resending}
                    className="auth-resend-button"
                  >
                    {resending ? 'Sending verification…' : resendSent ? 'Sent — check your inbox' : 'Resend verification email'}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="form-group auth-form-group">
            <label htmlFor="email" className="form-label">Email address</label>
            <div className="auth-input-shell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="3" y="5" width="18" height="14" rx="3" />
                <path d="m5 8 7 5 7-5" />
              </svg>
              <input
                id="email"
                type="email"
                className="form-input auth-form-input"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
                placeholder="you@example.com"
                disabled={loading}
              />
            </div>
          </div>

          <div className="form-group auth-form-group">
            <div className="auth-label-row">
              <label htmlFor="password" className="form-label">Password</label>
              <Link to="/forgot-password">Forgot password?</Link>
            </div>
            <div className="auth-input-shell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="4" y="10" width="16" height="11" rx="3" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
              </svg>
              <input
                id="password"
                type={showPassword ? 'text' : 'password'}
                className="form-input auth-form-input auth-form-input--password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                autoComplete="current-password"
                placeholder="Enter your password"
                disabled={loading}
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowPassword((visible) => !visible)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
                aria-pressed={showPassword}
              >
                {showPassword ? (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="m4 4 16 16M10.7 10.7a2 2 0 0 0 2.6 2.6M9.9 5.2A10.7 10.7 0 0 1 12 5c5.5 0 9 7 9 7a16 16 0 0 1-2.1 3.1M6.2 6.2C3.9 7.8 3 12 3 12s3.5 7 9 7a9.8 9.8 0 0 0 3.1-.5" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M3 12s3.5-7 9-7 9 7 9 7-3.5 7-9 7-9-7-9-7Z" />
                    <circle cx="12" cy="12" r="2.5" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          <button type="submit" disabled={loading} className="btn btn-primary auth-submit auth-submit--login">
            <span>{loading ? 'Signing in…' : 'Sign in securely'}</span>
            {!loading && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M14 7l5 5-5 5" />
              </svg>
            )}
          </button>
        </form>

        <p className="auth-switch-copy">
          New to UpNod? <Link to={`/register${fromDesktop ? '?desktop=1' : ''}`}>Create a free account <span aria-hidden="true">→</span></Link>
        </p>
      </AuthExperience>
      <Footer />
    </>
  );
}
