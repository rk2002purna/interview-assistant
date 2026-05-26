import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

export default function VerifyEmailPage() {
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token');
  const [status, setStatus] = useState<'loading' | 'success' | 'error'>('loading');
  const [message, setMessage] = useState('Verifying your email…');

  useEffect(() => {
    if (!token) {
      setStatus('error');
      setMessage('No verification token found. Please check your email link and try again.');
      return;
    }

    let cancelled = false;

    async function verify() {
      try {
        const resp = await fetch(`/api/auth/verify-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token }),
        });

        const data = await resp.json() as { verified?: boolean; error?: { code: string; message: string } };

        if (cancelled) return;

        if (resp.ok && data.verified) {
          setStatus('success');
          setMessage('Your email has been verified! You can now sign in to your account.');
        } else if (data.error?.code === 'token_expired') {
          setStatus('error');
          setMessage('This verification link has expired. Please sign in to request a new one.');
        } else {
          setStatus('error');
          setMessage(data.error?.message ?? 'Verification failed. The link may be invalid or already used.');
        }
      } catch {
        if (!cancelled) {
          setStatus('error');
          setMessage('Network error. Please check your connection and try again.');
        }
      }
    }

    verify();
    return () => { cancelled = true; };
  }, [token]);

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={status === 'success' ? styles.iconSuccess : status === 'error' ? styles.iconError : styles.iconLoading}>
          {status === 'success' ? '✓' : status === 'error' ? '✗' : '…'}
        </div>
        <h2 style={styles.title}>
          {status === 'success' ? 'Email Verified' : status === 'error' ? 'Verification Failed' : 'Verifying…'}
        </h2>
        <p style={styles.message}>{message}</p>
        {status === 'success' && (
          <Link to="/login" style={styles.btn}>Sign In</Link>
        )}
        {status === 'error' && (
          <>
            <Link to="/login" style={styles.btn}>Go to Sign In</Link>
            <p style={styles.hint}>
              If you haven't received a verification email,{' '}
              <Link to="/login" style={{ color: '#60a5fa' }}>sign in</Link> to request a new one.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    background: '#0a0e17',
    padding: 24,
  },
  card: {
    textAlign: 'center',
    maxWidth: 420,
    width: '100%',
  },
  iconSuccess: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'rgba(34, 197, 94, 0.15)',
    border: '2px solid rgba(34, 197, 94, 0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 28,
    color: '#22c55e',
    margin: '0 auto 20px',
    fontWeight: 700,
  },
  iconError: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'rgba(239, 68, 68, 0.15)',
    border: '2px solid rgba(239, 68, 68, 0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 28,
    color: '#ef4444',
    margin: '0 auto 20px',
    fontWeight: 700,
  },
  iconLoading: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'rgba(59, 130, 246, 0.15)',
    border: '2px solid rgba(59, 130, 246, 0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 28,
    color: '#60a5fa',
    margin: '0 auto 20px',
    fontWeight: 700,
  },
  title: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 },
  message: { fontSize: 14, color: '#94a3b8', marginBottom: 24, lineHeight: 1.6 },
  btn: {
    display: 'inline-block',
    padding: '12px 28px',
    background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
    color: '#fff',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    textDecoration: 'none',
    boxShadow: '0 2px 16px rgba(59,130,246,0.3)',
  },
  hint: { fontSize: 13, color: '#64748b', marginTop: 20 },
};
