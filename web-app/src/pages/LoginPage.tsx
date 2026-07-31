import { useState, useEffect, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { login, loginWithGoogle, isAuthSession, getStoredTokens } from '../api/client';
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
      // silently handle — the endpoint always returns {sent: true}
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
      // Desktop app OAuth flow — CallbackPage hands tokens back to the
      // Electron app via the interview-assistant:// protocol.
      window.location.href = `/callback?redirect=${encodeURIComponent(redirectTo)}`;
    } else {
      // Full page reload so Header picks up the new auth state
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
      // Check if the error is specifically about email verification
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
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.iconWrap}>
            <span style={styles.icon}>🔐</span>
          </div>
          <h1 style={styles.title}>Welcome Back</h1>
          <p style={styles.subtitle}>
            {fromDesktop ? 'Sign in to activate the desktop app' : 'Sign in to your account to continue'}
          </p>

          <GoogleSignInButton
            onCredential={handleGoogleCredential}
            onError={(m) => setError(m)}
            disabled={loading}
          />
          <div style={styles.orRow}>
            <span style={styles.orLine} />
            <span style={styles.orText}>or continue with email</span>
            <span style={styles.orLine} />
          </div>

          <form onSubmit={handleSubmit}>
            {error && (
              <div style={styles.error}>
                {error}
                {error.includes('not been verified') && (
                  <div style={{ marginTop: 10 }}>
                    <button type="button"
                      onClick={handleResendVerification}
                      disabled={resending}
                      style={styles.resendBtn}>
                      {resending ? 'Sending…' : resendSent ? 'Sent! Check your inbox' : 'Resend Verification Email'}
                    </button>
                  </div>
                )}
              </div>
            )}

            <div className="form-group">
              <label htmlFor="email" className="form-label">Email</label>
              <input id="email" type="email" className="form-input"
                value={email} onChange={(e) => setEmail(e.target.value)}
                required autoComplete="email" placeholder="you@example.com"
                disabled={loading} />
            </div>

            <div className="form-group">
              <label htmlFor="password" className="form-label">Password</label>
              <input id="password" type="password" className="form-input"
                value={password} onChange={(e) => setPassword(e.target.value)}
                required autoComplete="current-password" placeholder="Enter your password"
                disabled={loading} />
            </div>

            <div style={{ textAlign: 'right', marginTop: -8, marginBottom: 14 }}>
              <Link to="/forgot-password" style={{ fontSize: 13, color: '#60a5fa', textDecoration: 'none' }}>
                Forgot password?
              </Link>
            </div>

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>
              {loading ? 'Signing in...' : 'Sign In'}
            </button>
          </form>

          <p style={styles.footer}>
            Don't have an account? <Link to={`/register${fromDesktop ? '?desktop=1' : ''}`}>Create one</Link>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '100px 24px 60px',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(99, 179, 237, 0.12)',
    borderRadius: 16,
    padding: '40px 32px',
    width: '100%',
    maxWidth: 420,
    backdropFilter: 'blur(8px)',
  },
  iconWrap: {
    width: 56,
    height: 56,
    borderRadius: 14,
    background: 'rgba(59, 130, 246, 0.1)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
  },
  icon: { fontSize: 28 },
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#94a3b8', marginBottom: 28 },
  error: {
    background: 'rgba(239, 68, 68, 0.1)',
    border: '1px solid rgba(239, 68, 68, 0.3)',
    color: '#fca5a5',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
  },
  footer: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 24 },
  orRow: { display: 'flex', alignItems: 'center', gap: 10, margin: '16px 0 18px' },
  orLine: { flex: 1, height: 1, background: 'rgba(148,163,184,0.18)' },
  orText: { fontSize: 12, color: '#64748b', whiteSpace: 'nowrap' as const },
  resendBtn: {
    background: 'rgba(59, 130, 246, 0.15)',
    border: '1px solid rgba(59, 130, 246, 0.3)',
    color: '#93c5fd',
    padding: '8px 16px',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    width: '100%',
  },
};
