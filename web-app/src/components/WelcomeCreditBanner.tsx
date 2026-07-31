import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  acknowledgeWelcomeCreditNotice,
  claimWelcomeCreditNotice,
  isAuthSession,
  type WelcomeCreditNotice,
} from '../api/client';
import './WelcomeCreditBanner.css';

const AUTH_FLOW_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/password-reset',
  '/verify-email',
  '/callback',
  '/desktop-auth',
];

const CLAIM_TOKEN_STORAGE_KEY = 'upnod_welcome_credit_claim_token';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// React StrictMode intentionally remounts effects in development. Reusing the
// in-flight reservation lets the visible mount receive the same replayable
// response instead of issuing a competing claim.
let welcomeCreditClaim: { token: string; promise: Promise<WelcomeCreditNotice | null> } | null = null;

function getClaimToken(): string {
  try {
    const existing = window.sessionStorage.getItem(CLAIM_TOKEN_STORAGE_KEY);
    if (existing && UUID_PATTERN.test(existing)) return existing;
    const token = window.crypto.randomUUID();
    window.sessionStorage.setItem(CLAIM_TOKEN_STORAGE_KEY, token);
    return token;
  } catch {
    return window.crypto.randomUUID();
  }
}

function clearClaimToken(token: string): void {
  try {
    if (window.sessionStorage.getItem(CLAIM_TOKEN_STORAGE_KEY) === token) {
      window.sessionStorage.removeItem(CLAIM_TOKEN_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable in privacy-restricted browsing contexts.
  }
}

function getWelcomeCreditClaim(token: string): Promise<WelcomeCreditNotice | null> {
  if (welcomeCreditClaim?.token === token) return welcomeCreditClaim.promise;

  const promise = claimWelcomeCreditNotice(token);
  welcomeCreditClaim = { token, promise };
  void promise.finally(() => {
    window.setTimeout(() => {
      if (welcomeCreditClaim?.promise === promise) welcomeCreditClaim = null;
    }, 0);
  });
  return promise;
}

async function acknowledgeRenderedClaim(token: string): Promise<void> {
  if (await acknowledgeWelcomeCreditNotice(token)) clearClaimToken(token);
}

function isAuthFlowPath(pathname: string): boolean {
  return AUTH_FLOW_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

function formatCredit(amountPaise: number): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(amountPaise / 100);
}

export default function WelcomeCreditBanner() {
  const { pathname } = useLocation();
  const isExcludedRoute = isAuthFlowPath(pathname);
  const authFlowRef = useRef(isExcludedRoute);
  const attemptedRef = useRef(false);
  const claimTokenRef = useRef<string | null>(null);
  const acknowledgementFrameRef = useRef<number | null>(null);
  const removalTimerRef = useRef<number | null>(null);
  const [notice, setNotice] = useState<WelcomeCreditNotice | null>(null);
  const [isLeaving, setIsLeaving] = useState(false);

  authFlowRef.current = isExcludedRoute;

  const dismiss = useCallback(() => {
    if (claimTokenRef.current) void acknowledgeRenderedClaim(claimTokenRef.current);
    setIsLeaving(true);
    if (removalTimerRef.current !== null) window.clearTimeout(removalTimerRef.current);
    removalTimerRef.current = window.setTimeout(() => setNotice(null), 240);
  }, []);

  useEffect(() => {
    return () => {
      if (removalTimerRef.current !== null) window.clearTimeout(removalTimerRef.current);
      if (acknowledgementFrameRef.current !== null) {
        window.cancelAnimationFrame(acknowledgementFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (isExcludedRoute) {
      attemptedRef.current = false;
      setNotice(null);
      setIsLeaving(false);
      if (acknowledgementFrameRef.current !== null) {
        window.cancelAnimationFrame(acknowledgementFrameRef.current);
        acknowledgementFrameRef.current = null;
      }
      return;
    }

    if (attemptedRef.current || !isAuthSession()) return;
    attemptedRef.current = true;

    const claimToken = getClaimToken();
    claimTokenRef.current = claimToken;

    void getWelcomeCreditClaim(claimToken).then((result) => {
      if (!result) return;
      if (!result.show_banner) {
        clearClaimToken(claimToken);
        return;
      }
      if (authFlowRef.current) return;

      setIsLeaving(false);
      setNotice(result);

      // Acknowledge only after the browser has had an opportunity to paint the
      // live region. Background tabs defer requestAnimationFrame, preserving
      // the reservation until the user can actually see the notice.
      acknowledgementFrameRef.current = window.requestAnimationFrame(() => {
        if (authFlowRef.current) return;
        acknowledgementFrameRef.current = window.requestAnimationFrame(() => {
          acknowledgementFrameRef.current = null;
          if (!authFlowRef.current) void acknowledgeRenderedClaim(claimToken);
        });
      });
    });
  }, [isExcludedRoute, pathname]);

  if (!notice || isExcludedRoute) return null;

  const formattedCredit = formatCredit(notice.amount_paise);

  return (
    <aside
      className={`welcome-credit-banner${isLeaving ? ' is-leaving' : ''}`}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-label="Welcome credit notification"
    >
      <div className="welcome-credit-confetti" aria-hidden="true">
        <i /><i /><i /><i /><i />
      </div>

      <div className="welcome-credit-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
          <rect x="3" y="7" width="18" height="13" rx="3" />
          <path d="M3 11h18M16 15h2" />
          <path d="M8.2 7C6.1 7 5 5.9 5 4.7 5 3.8 5.7 3 6.7 3 8.5 3 10 5 12 7M15.8 7C17.9 7 19 5.9 19 4.7 19 3.8 18.3 3 17.3 3 15.5 3 14 5 12 7" />
        </svg>
        <span>+{formattedCredit}</span>
      </div>

      <div className="welcome-credit-copy">
        <span className="welcome-credit-kicker">
          <i aria-hidden="true" /> Welcome credit unlocked
        </span>
        <strong>{formattedCredit} has been credited to your account!</strong>
        <p>Your UpNod wallet is ready for your first interview session.</p>
        <Link to="/wallet" onClick={dismiss}>
          View wallet
          <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
            <path d="M4 10h12M11 5l5 5-5 5" />
          </svg>
        </Link>
      </div>

      <button type="button" className="welcome-credit-close" onClick={dismiss} aria-label="Dismiss welcome credit notification">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
          <path d="m5 5 10 10M15 5 5 15" />
        </svg>
      </button>
    </aside>
  );
}
