import { useState, useEffect, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { register, loginWithGoogle, isAuthSession, getStoredTokens } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';
import GoogleSignInButton from '../components/GoogleSignInButton';
import AuthShowcase from '../components/AuthShowcase';

export default function RegisterPage() {
  const [searchParams] = useSearchParams();
  const fromDesktop = searchParams.get('desktop') === '1';
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  // If user is already logged in and came from desktop, redirect back to desktop app
  useEffect(() => {
    if (fromDesktop && isAuthSession()) {
      const tokens = getStoredTokens()!;
      const callbackUrl = `interview-assistant://callback?access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`;
      window.location.href = callbackUrl;
    }
  }, [fromDesktop]);

  // Google sign-up == sign-in: the account is created on first use and the
  // email is treated as verified (no verification link), so we route straight
  // back to the app just like the login page does.
  function completeAuthRedirect() {
    if (fromDesktop) {
      window.location.href = `/callback?redirect=${encodeURIComponent('/')}`;
    } else {
      window.location.href = '/';
    }
  }

  async function handleGoogleCredential(idToken: string) {
    setError('');
    setSuccess('');
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
    setSuccess('');

    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    if (password.length < 12) {
      setError('Password must be at least 12 characters with uppercase, lowercase, number, and symbol.');
      return;
    }

    setLoading(true);
    const result = await register(email, password, displayName.trim() || undefined);
    setLoading(false);

    if (result.success) {
      setSuccess('Account created! Please check your email to verify your address, then sign in.');
    } else {
      setError(result.error);
    }
  }

  return (
    <>
      {loading && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="spinner" aria-hidden="true" />
          <div className="loading-text">Creating your account…</div>
        </div>
      )}
      <Header />
      <main className="auth-page auth-page-register">
        <div className="auth-page-glow" aria-hidden="true" />
        <div className="auth-shell">
          <AuthShowcase variant="register" desktop={fromDesktop} />

          <section className="auth-panel" aria-labelledby="register-title">
            <div className="auth-panel-inner">
              <div className="auth-panel-heading">
                <span className="auth-panel-kicker">{fromDesktop ? 'Connect your desktop app' : 'Start with ₹50 credit'}</span>
                <h1 id="register-title">Create your Cueviq account</h1>
                <p>Get set up in minutes, then pay only for the active time you use.</p>
              </div>

              {error && <div className="auth-alert auth-alert-error" role="alert"><p>{error}</p></div>}
              {success && <div className="auth-alert auth-alert-success" role="status" aria-live="polite"><p>{success}</p></div>}

              <GoogleSignInButton
                onCredential={handleGoogleCredential}
                onError={(message) => setError(message)}
                disabled={loading}
              />

              <div className="auth-divider" role="separator"><span>or sign up with email</span></div>

              <form className="auth-form" onSubmit={handleSubmit}>
                <div className="form-group">
                  <label htmlFor="displayName" className="form-label">Name <span>(optional)</span></label>
                  <input
                    id="displayName"
                    type="text"
                    className="form-input"
                    value={displayName}
                    onChange={(event) => setDisplayName(event.target.value)}
                    autoComplete="name"
                    placeholder="Your full name"
                    disabled={loading}
                  />
                </div>

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
                  <label htmlFor="password" className="form-label">Password</label>
                  <input
                    id="password"
                    type="password"
                    className="form-input"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="Create a strong password"
                    disabled={loading}
                    aria-describedby="password-help"
                  />
                  <span id="password-help" className="auth-field-hint">12+ characters with uppercase, lowercase, number, and symbol</span>
                </div>

                <div className="form-group">
                  <label htmlFor="confirm" className="form-label">Confirm password</label>
                  <input
                    id="confirm"
                    type="password"
                    className="form-input"
                    value={confirm}
                    onChange={(event) => setConfirm(event.target.value)}
                    required
                    autoComplete="new-password"
                    placeholder="Re-enter your password"
                    disabled={loading}
                  />
                </div>

                <button type="submit" disabled={loading} className="btn btn-primary auth-submit">
                  {loading ? 'Creating account…' : 'Create free account'}
                  {!loading && <span aria-hidden="true">→</span>}
                </button>
              </form>

              <p className="auth-switch">
                Already have an account? <Link to={`/login${fromDesktop ? '?desktop=1' : ''}`}>Sign in</Link>
              </p>
            </div>
          </section>
        </div>
      </main>
      <Footer />
    </>
  );
}
