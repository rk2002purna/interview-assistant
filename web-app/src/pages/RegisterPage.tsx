import { useState, useEffect, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { register, loginWithGoogle, isAuthSession, getStoredTokens } from '../api/client';
import AuthExperience from '../components/AuthExperience';
import Header from '../components/Header';
import Footer from '../components/Footer';
import GoogleSignInButton from '../components/GoogleSignInButton';

export default function RegisterPage() {
  const [searchParams] = useSearchParams();
  const fromDesktop = searchParams.get('desktop') === '1';
  const [displayName, setDisplayName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(false);

  const passwordRequirements = [
    password.length >= 12 && password.length <= 128,
    /[A-Z]/.test(password),
    /[a-z]/.test(password),
    /\d/.test(password),
    /[^A-Za-z0-9]/.test(password),
  ];
  const passwordScore = passwordRequirements.filter(Boolean).length;
  const passwordIsValid = passwordRequirements.every(Boolean);
  const strengthLabel = passwordIsValid ? 'All 5 requirements met' : `${passwordScore} of 5 requirements met`;
  const passwordsMatch = Boolean(confirm) && password === confirm;

  // If user is already logged in and came from desktop, redirect back to desktop app
  useEffect(() => {
    if (fromDesktop && isAuthSession()) {
      const tokens = getStoredTokens()!;
      const callbackUrl = `interview-assistant://callback?access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`;
      window.location.href = callbackUrl;
    }
  }, [fromDesktop]);

  // Google sign-up is also sign-in: an account is created on first use and
  // the email is considered verified, so return to the app immediately.
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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (!passwordIsValid) { setError('Password must be 12–128 characters and include uppercase, lowercase, number, and symbol.'); return; }

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
          <div className="spinner" />
          <div className="loading-text">Creating your account…</div>
        </div>
      )}
      <Header />
      <AuthExperience
        mode="register"
        eyebrow={fromDesktop ? 'Connect your desktop app' : 'Start with ₹50 free credit'}
        title="Create your account"
        subtitle="Set up your private workspace and make your next interview feel more manageable."
      >
        <div className="auth-google-slot">
          <GoogleSignInButton
            onCredential={handleGoogleCredential}
            onError={(message) => setError(message)}
            disabled={loading}
          />
        </div>

        <div className="auth-divider" role="separator">
          <span>or create an account with email</span>
        </div>

        <form className="auth-form" onSubmit={handleSubmit} aria-busy={loading}>
          {error && (
            <div className="auth-alert auth-alert--error" role="alert">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v6M12 17h.01" />
              </svg>
              <div className="auth-alert-copy">
                <strong>Let’s fix that</strong>
                <span>{error}</span>
              </div>
            </div>
          )}
          {success && (
            <div className="auth-alert auth-alert--success" role="status" aria-live="polite">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="12" r="9" />
                <path d="m8 12 2.5 2.5L16.5 9" />
              </svg>
              <div className="auth-alert-copy">
                <strong>You’re almost ready</strong>
                <span>{success}</span>
              </div>
            </div>
          )}

          <div className="form-group auth-form-group">
            <div className="auth-label-row">
              <label htmlFor="displayName" className="form-label">Full name</label>
              <span>Optional</span>
            </div>
            <div className="auth-input-shell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <circle cx="12" cy="8" r="4" />
                <path d="M4.5 21a7.5 7.5 0 0 1 15 0" />
              </svg>
              <input
                id="displayName"
                type="text"
                className="form-input auth-form-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                placeholder="Your full name"
                disabled={loading}
              />
            </div>
          </div>

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
            <label htmlFor="password" className="form-label">Create password</label>
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
                minLength={12}
                maxLength={128}
                autoComplete="new-password"
                placeholder="Create a strong password"
                disabled={loading}
                aria-invalid={Boolean(password) && !passwordIsValid}
                aria-describedby="register-password-guidance"
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
            <div id="register-password-guidance" className="auth-password-meter" aria-live="polite">
              <div className={`auth-strength-bars${passwordIsValid ? ' is-complete' : ''}`} aria-hidden="true">
                {[1, 2, 3, 4, 5].map((requirement) => <i key={requirement} className={requirement <= passwordScore ? 'is-active' : ''} />)}
              </div>
              <span>{password ? strengthLabel : '12–128 characters, upper/lowercase, number, and symbol'}</span>
            </div>
          </div>

          <div className="form-group auth-form-group">
            <label htmlFor="confirm" className="form-label">Confirm password</label>
            <div className="auth-input-shell">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                <rect x="4" y="10" width="16" height="11" rx="3" />
                <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
              </svg>
              <input
                id="confirm"
                type={showConfirm ? 'text' : 'password'}
                className="form-input auth-form-input auth-form-input--password"
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
                required
                maxLength={128}
                autoComplete="new-password"
                placeholder="Re-enter your password"
                disabled={loading}
                aria-invalid={Boolean(confirm) && !passwordsMatch}
                aria-describedby="confirm-guidance"
              />
              <button
                type="button"
                className="auth-password-toggle"
                onClick={() => setShowConfirm((visible) => !visible)}
                aria-label={showConfirm ? 'Hide confirmed password' : 'Show confirmed password'}
                aria-pressed={showConfirm}
              >
                {showConfirm ? (
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
            <span id="confirm-guidance" className={`auth-field-hint${confirm ? (passwordsMatch ? ' is-valid' : ' is-invalid') : ''}`} aria-live="polite">
              {confirm ? (passwordsMatch ? 'Passwords match' : 'Passwords do not match yet') : 'Enter the same password again'}
            </span>
          </div>

          <button type="submit" disabled={loading} className="btn btn-green auth-submit auth-submit--register">
            <span>{loading ? 'Creating your account…' : 'Create my free account'}</span>
            {!loading && (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M5 12h14M14 7l5 5-5 5" />
              </svg>
            )}
          </button>
        </form>

        <p className="auth-switch-copy">
          Already have an account? <Link to={`/login${fromDesktop ? '?desktop=1' : ''}`}>Sign in <span aria-hidden="true">→</span></Link>
        </p>
      </AuthExperience>
      <Footer />
    </>
  );
}
