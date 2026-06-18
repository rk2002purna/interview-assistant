import { useState, useEffect, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { register, isAuthSession, getStoredTokens } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';

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

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    if (password !== confirm) { setError('Passwords do not match.'); return; }
    if (password.length < 12) { setError('Password must be at least 12 characters with uppercase, lowercase, number, and symbol.'); return; }

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
      <Header />
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.iconWrap}>
            <span style={styles.icon}>🚀</span>
          </div>
          <h1 style={styles.title}>Create Your Account</h1>
          <p style={styles.subtitle}>
            Get 3 free interview sessions when you sign up
          </p>

          <form onSubmit={handleSubmit}>
            {error && <div style={styles.error}>{error}</div>}
            {success && <div style={styles.success}>{success}</div>}

            <div className="form-group">
              <label htmlFor="displayName" className="form-label">Name</label>
              <input id="displayName" type="text" className="form-input"
                value={displayName} onChange={(e) => setDisplayName(e.target.value)}
                autoComplete="name" placeholder="Your full name"
                disabled={loading} />
            </div>

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
                required autoComplete="new-password" placeholder="Create a strong password"
                disabled={loading} />
              <span style={styles.hint}>12+ characters with uppercase, lowercase, number, and symbol</span>
            </div>

            <div className="form-group">
              <label htmlFor="confirm" className="form-label">Confirm Password</label>
              <input id="confirm" type="password" className="form-input"
                value={confirm} onChange={(e) => setConfirm(e.target.value)}
                required autoComplete="new-password" placeholder="Re-enter your password"
                disabled={loading} />
            </div>

            <button type="submit" disabled={loading} className="btn btn-green" style={{ width: '100%', marginTop: 8 }}>
              {loading ? 'Creating Account...' : 'Create Free Account'}
            </button>
          </form>

          <p style={styles.footer}>
            Already have an account? <Link to={`/login${fromDesktop ? '?desktop=1' : ''}`}>Sign in</Link>
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
    background: 'rgba(34, 197, 94, 0.1)',
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
  success: {
    background: 'rgba(34, 197, 94, 0.1)',
    border: '1px solid rgba(34, 197, 94, 0.3)',
    color: '#86efac',
    padding: '10px 14px',
    borderRadius: 8,
    fontSize: 13,
    marginBottom: 16,
  },
  hint: { fontSize: 11, color: '#475569', marginTop: 4, display: 'block' },
  footer: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 24 },
};
