import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { getStoredTokens, isAuthSession } from '../api/client';

/**
 * DesktopAuthPage — auto-login bridge for the Electron desktop app.
 *
 * Opened by the Electron app's "Sign In with Browser" flow. If the user
 * already has valid tokens in browser localStorage, this page immediately
 * redirects to the interview-assistant:// protocol URL, which the Electron
 * app intercepts to complete sign-in. If no tokens are found, the user is
 * sent to /login?desktop=1 (or /register?desktop=1 if intent=register).
 *
 * No user interaction needed — the page redirects on mount.
 */
export default function DesktopAuthPage() {
  const [searchParams] = useSearchParams();
  const intent = searchParams.get('intent'); // 'register' or null
  const [status, setStatus] = useState<'checking' | 'redirecting' | 'no_session'>('checking');

  useEffect(() => {
    try {
      if (isAuthSession()) {
        setStatus('redirecting');
        const tokens = getStoredTokens()!;
        const callbackUrl = `interview-assistant://callback?access_token=${encodeURIComponent(tokens.accessToken)}&refresh_token=${encodeURIComponent(tokens.refreshToken)}`;
        window.location.href = callbackUrl;
      } else {
        setStatus('no_session');
        const fallbackPath = intent === 'register' ? '/register?desktop=1' : '/login?desktop=1';
        // Brief delay so the user sees the transition
        setTimeout(() => {
          window.location.href = fallbackPath;
        }, 800);
      }
    } catch {
      setStatus('no_session');
      const fallbackPath = intent === 'register' ? '/register?desktop=1' : '/login?desktop=1';
      setTimeout(() => {
        window.location.href = fallbackPath;
      }, 800);
    }
  }, [intent]);

  return (
    <main style={styles.wrapper}>
      <div style={styles.card}>
        <div style={{ marginBottom: 20, textAlign: 'center' as const }}>
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 36" width="120" height="44"><text x="0" y="26" fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" fontSize="24" fontWeight="800" letterSpacing="-0.5"><tspan fill="#3b82f6">Up</tspan><tspan fill="#ffffff">Nod</tspan></text></svg>
        </div>
        <p style={styles.subtitle}>
          {status === 'checking' && 'Checking for existing session...'}
          {status === 'redirecting' && 'Session found! Redirecting to desktop app...'}
          {status === 'no_session' && 'No active session. Redirecting to sign in...'}
        </p>
      </div>
    </main>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '100vh',
    padding: '100px 24px 60px',
    background: '#0f0f19',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(99, 179, 237, 0.12)',
    borderRadius: 16,
    padding: '40px 32px',
    width: '100%',
    maxWidth: 420,
    textAlign: 'center',
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
    margin: '0 auto 20px',
  },
  icon: { fontSize: 28 },
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 },
  subtitle: { fontSize: 14, color: '#94a3b8' },
};
