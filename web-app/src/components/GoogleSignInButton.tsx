import { useEffect, useRef } from 'react';

/**
 * "Continue with Google" button backed by Google Identity Services (GIS).
 *
 * Loads the GIS script, renders Google's official button, and hands the
 * resulting ID token (a signed JWT) back to the parent via `onCredential`.
 * The parent posts that token to the backend `/auth/google` endpoint.
 *
 * Requires VITE_GOOGLE_CLIENT_ID (the public OAuth Web client ID). When it is
 * not configured the component renders nothing and reports via `onError`.
 */

const GIS_SRC = 'https://accounts.google.com/gsi/client';

function loadGoogleScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const w = window as unknown as { google?: { accounts?: { id?: unknown } } };
    if (w.google?.accounts?.id) {
      resolve();
      return;
    }
    const existing = document.querySelector(`script[src="${GIS_SRC}"]`) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('Google script failed to load')));
      return;
    }
    const s = document.createElement('script');
    s.src = GIS_SRC;
    s.async = true;
    s.defer = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Google script failed to load'));
    document.head.appendChild(s);
  });
}

interface GoogleSignInButtonProps {
  onCredential: (idToken: string) => void;
  onError?: (message: string) => void;
  disabled?: boolean;
}

export default function GoogleSignInButton({ onCredential, onError, disabled }: GoogleSignInButtonProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const clientId = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;

  // Keep the latest callbacks in refs so the GIS init effect runs only once.
  const onCredentialRef = useRef(onCredential);
  const onErrorRef = useRef(onError);
  useEffect(() => {
    onCredentialRef.current = onCredential;
    onErrorRef.current = onError;
  });

  useEffect(() => {
    if (!clientId) {
      onErrorRef.current?.('Google sign-in is not configured (missing VITE_GOOGLE_CLIENT_ID).');
      return;
    }
    let cancelled = false;
    let resizeObserver: ResizeObserver | null = null;
    loadGoogleScript()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const google = (window as unknown as { google: any }).google;
        google.accounts.id.initialize({
          client_id: clientId,
          callback: (resp: { credential?: string }) => {
            if (resp && resp.credential) onCredentialRef.current(resp.credential);
            else onErrorRef.current?.('No credential returned from Google.');
          },
        });

        const renderButton = () => {
          const container = containerRef.current;
          if (cancelled || !container) return;
          const availableWidth = Math.floor(container.getBoundingClientRect().width);
          const buttonWidth = Math.min(360, Math.max(200, availableWidth || 320));
          container.innerHTML = '';
          google.accounts.id.renderButton(container, {
            theme: 'outline',
            size: 'large',
            type: 'standard',
            text: 'continue_with',
            shape: 'rectangular',
            logo_alignment: 'left',
            width: buttonWidth,
          });
        };

        renderButton();
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(renderButton);
          resizeObserver.observe(containerRef.current);
        }
      })
      .catch(() => onErrorRef.current?.('Could not load Google sign-in. Check your connection.'));
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
    };
  }, [clientId]);

  if (!clientId) return null;

  return (
    <div
      className="google-signin-button"
      aria-disabled={disabled || undefined}
      style={{
        opacity: disabled ? 0.6 : 1,
        pointerEvents: disabled ? 'none' : 'auto',
      }}
    >
      <div ref={containerRef} className="google-signin-button-host" />
    </div>
  );
}
