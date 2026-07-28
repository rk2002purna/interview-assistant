import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { confirmPasswordReset } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';

export default function ResetPasswordPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (password.length < 8) {
      setError('Password must be at least 8 characters.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }

    setLoading(true);
    const result = await confirmPasswordReset(token, password);
    setLoading(false);
    if (result.ok) {
      setDone(true);
    } else {
      setError(result.error);
    }
  }

  return (
    <>
      <Header />
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.iconWrap}><span style={styles.icon}>🔒</span></div>
          <h1 style={styles.title}>Set a new password</h1>

          {!token ? (
            <>
              <div style={styles.error}>
                This reset link is invalid or incomplete. Please request a new one.
              </div>
              <p style={styles.footer}><Link to="/forgot-password">Request a new link</Link></p>
            </>
          ) : done ? (
            <>
              <div style={styles.success}>
                Your password has been reset. You can now sign in with your new password.
              </div>
              <p style={styles.footer}><Link to="/login">Go to sign in</Link></p>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              {error && <div style={styles.error}>{error}</div>}
              <div className="form-group">
                <label htmlFor="password" className="form-label">New password</label>
                <input id="password" type="password" className="form-input"
                  value={password} onChange={(e) => setPassword(e.target.value)}
                  required autoComplete="new-password" placeholder="At least 8 characters"
                  disabled={loading} />
              </div>
              <div className="form-group">
                <label htmlFor="confirm" className="form-label">Confirm new password</label>
                <input id="confirm" type="password" className="form-input"
                  value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  required autoComplete="new-password" placeholder="Re-enter your new password"
                  disabled={loading} />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>
                {loading ? 'Resetting…' : 'Reset password'}
              </button>
            </form>
          )}
        </div>
      </main>
      <Footer />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: { display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', padding: '100px 24px 60px' },
  card: {
    background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(99, 179, 237, 0.12)',
    borderRadius: 16, padding: '40px 32px', width: '100%', maxWidth: 420, backdropFilter: 'blur(8px)',
  },
  iconWrap: {
    width: 56, height: 56, borderRadius: 14, background: 'rgba(59, 130, 246, 0.1)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 20,
  },
  icon: { fontSize: 28 },
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 20 },
  error: {
    background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
    color: '#fca5a5', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
  },
  success: {
    background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)',
    color: '#86efac', padding: '12px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
  },
  footer: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 24 },
};
