import { useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { requestPasswordReset } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    await requestPasswordReset(email.trim());
    // The endpoint always returns success to prevent email enumeration.
    setSent(true);
    setLoading(false);
  }

  return (
    <>
      <Header />
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <div style={styles.iconWrap}><span style={styles.icon}>🔑</span></div>
          <h1 style={styles.title}>Reset your password</h1>
          <p style={styles.subtitle}>
            Enter your account email and we'll send you a link to set a new password.
          </p>

          {sent ? (
            <>
              <div style={styles.success}>
                If an account exists for <strong>{email}</strong>, a password reset link is on its way.
                Check your inbox (and spam folder). The link expires in 60 minutes.
              </div>
              <p style={styles.footer}>
                <Link to="/login">Back to sign in</Link>
              </p>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <div className="form-group">
                <label htmlFor="email" className="form-label">Email</label>
                <input id="email" type="email" className="form-input"
                  value={email} onChange={(e) => setEmail(e.target.value)}
                  required autoComplete="email" placeholder="you@example.com"
                  disabled={loading} />
              </div>
              <button type="submit" disabled={loading} className="btn btn-primary" style={{ width: '100%', marginTop: 8 }}>
                {loading ? 'Sending…' : 'Send reset link'}
              </button>
              <p style={styles.footer}>
                Remembered it? <Link to="/login">Back to sign in</Link>
              </p>
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
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#94a3b8', marginBottom: 28 },
  success: {
    background: 'rgba(34, 197, 94, 0.1)', border: '1px solid rgba(34, 197, 94, 0.3)',
    color: '#86efac', padding: '12px 14px', borderRadius: 8, fontSize: 13, lineHeight: 1.6,
  },
  footer: { fontSize: 14, color: '#64748b', textAlign: 'center', marginTop: 24 },
};
