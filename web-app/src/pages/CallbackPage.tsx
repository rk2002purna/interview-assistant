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
      <div style={styles.container}>
        <div style={styles.card}>
          <h2 style={styles.title}>Session Not Found</h2>
          <p style={styles.subtitle}>Please sign in first.</p>
          <a href="/login?desktop=1" style={styles.link}>Go to Sign In</a>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.checkmark}>✓</div>
        <h2 style={styles.title}>Signed In Successfully</h2>
        <p style={styles.subtitle}>
          {autoTriggered
            ? 'The app should open automatically. If not, click below.'
            : 'Click below to return to the app.'}
        </p>
        <a
          href={callbackUrl!}
          style={styles.openBtn}
          onClick={() => setAutoTriggered(true)}
        >
          Open UpNod
        </a>
        <p style={styles.fallback}>
          If the app doesn't launch, make sure it's running and{' '}
          <a href="/download" style={{ color: '#60a5fa' }}>download it here</a>.
        </p>
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
    textAlign: 'center' as const,
    maxWidth: 400,
  },
  checkmark: {
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
  title: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 },
  subtitle: { fontSize: 14, color: '#94a3b8', marginBottom: 24 },
  openBtn: {
    display: 'inline-block',
    padding: '12px 28px',
    background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
    color: '#fff',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    textDecoration: 'none',
    cursor: 'pointer',
    boxShadow: '0 2px 16px rgba(59,130,246,0.3)',
  },
  link: {
    color: '#60a5fa',
    fontSize: 14,
    textDecoration: 'none',
  },
  fallback: { fontSize: 13, color: '#64748b', marginTop: 20 },
};
