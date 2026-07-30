import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  isAuthSession,
  getDisplayName,
  getWallet,
  createWalletTopup,
  verifyPayment,
  ApiClientError,
} from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';

const RATE_PER_MINUTE = 5;
const MIN_TOPUP = 1;
const MAX_TOPUP = 100000;
const DEFAULT_TOPUP = 300;
const PRESETS = [100, 300, 500, 1000];
const RAZORPAY_SCRIPT = 'https://checkout.razorpay.com/v1/checkout.js';
const SUPPORT_EMAIL = 'upnodsupport@gmail.com';

/** Parse and clamp the ?amount= query (rupees) to a valid top-up amount. */
function parseAmount(raw: string | null): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return DEFAULT_TOPUP;
  if (n < MIN_TOPUP) return MIN_TOPUP;
  if (n > MAX_TOPUP) return MAX_TOPUP;
  return n;
}

/** Inject the Razorpay Checkout script once; resolve when it's ready. */
function loadRazorpayScript(): Promise<boolean> {
  return new Promise((resolve) => {
    if ((window as any).Razorpay) {
      resolve(true);
      return;
    }
    const existing = document.querySelector(`script[src="${RAZORPAY_SCRIPT}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(true));
      existing.addEventListener('error', () => resolve(false));
      return;
    }
    const script = document.createElement('script');
    script.src = RAZORPAY_SCRIPT;
    script.onload = () => resolve(true);
    script.onerror = () => resolve(false);
    document.body.appendChild(script);
  });
}

type Status = 'idle' | 'creating' | 'checkout' | 'verifying' | 'done';

export default function CheckoutPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  // Amount is a free-form, editable value (in rupees). Seeded from the
  // ?amount= query when present, then fully customizable on this page.
  const [amountText, setAmountText] = useState<string>(
    () => String(parseAmount(searchParams.get('amount'))),
  );
  const amount = Number(amountText);
  const amountValid =
    Number.isInteger(amount) && amount >= MIN_TOPUP && amount <= MAX_TOPUP;
  const minutes = amountValid ? Math.floor(amount / RATE_PER_MINUTE) : 0;

  const [status, setStatus] = useState<Status>('idle');
  const [error, setError] = useState('');
  const baselineBalance = useRef<number>(0);
  const authed = isAuthSession();

  useEffect(() => {
    // Warm up the Razorpay script and capture the pre-payment balance.
    loadRazorpayScript();
    getWallet().then((w) => {
      if (w) baselineBalance.current = w.balance_paise;
    });
  }, []);

  // Poll the wallet until the webhook credits it (or the window elapses).
  async function pollWalletCredited(tries = 12): Promise<boolean> {
    for (let i = 0; i < tries; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      const w = await getWallet();
      if (w && w.balance_paise > baselineBalance.current) return true;
    }
    return false;
  }

  async function handlePay() {
    setError('');

    if (!amountValid) {
      setError(
        `Enter a whole amount between ₹${MIN_TOPUP} and ₹${MAX_TOPUP.toLocaleString('en-IN')}.`,
      );
      return;
    }

    // Guests create an account first (₹50 signup bonus), then return here
    // with the same amount preserved.
    if (!authed) {
      const redirect = `/pricing?amount=${encodeURIComponent(String(amount))}`;
      window.location.href = `/register?redirect=${encodeURIComponent(redirect)}`;
      return;
    }

    setStatus('creating');

    let order;
    try {
      order = await createWalletTopup(amount * 100);
    } catch (err) {
      setStatus('idle');
      if (err instanceof ApiClientError) {
        setError(
          err.status === 404
            ? 'Online payments are not enabled yet. Please contact support.'
            : err.message,
        );
      } else {
        setError('Could not start checkout. Please try again.');
      }
      return;
    }

    const ready = await loadRazorpayScript();
    if (!ready || !(window as any).Razorpay) {
      setStatus('idle');
      setError('Could not load the payment window. Check your connection and try again.');
      return;
    }

    const displayName = getDisplayName();
    const checkoutThemeColor =
      document.documentElement.dataset.theme === 'light' ? '#47751f' : '#22c55e';
    const options: Record<string, unknown> = {
      key: order.key_id,
      order_id: order.order_id,
      amount: order.amount,
      currency: order.currency,
      name: 'Cueviq',
      description: `Wallet top-up ₹${amount.toLocaleString('en-IN')}`,
      theme: { color: checkoutThemeColor },
      prefill: displayName ? { name: displayName } : {},
      handler: async (resp: {
        razorpay_order_id?: string;
        razorpay_payment_id?: string;
        razorpay_signature?: string;
      }) => {
        setStatus('verifying');
        // Verify the signature server-side, which credits the wallet instantly.
        try {
          const res = await verifyPayment({
            razorpay_order_id: resp.razorpay_order_id ?? '',
            razorpay_payment_id: resp.razorpay_payment_id ?? '',
            razorpay_signature: resp.razorpay_signature ?? '',
          });
          if (res.verified) {
            setStatus('done');
            navigate('/wallet');
            return;
          }
        } catch {
          // Verification failed or unreachable — fall back to the webhook,
          // which credits the wallet independently. Poll until it lands.
        }
        await pollWalletCredited();
        setStatus('done');
        navigate('/wallet');
      },
      modal: {
        ondismiss: () => {
          setStatus('idle');
          setError('Payment window closed before completing. You can try again.');
        },
      },
    };

    const rzp = new (window as any).Razorpay(options);
    rzp.on('payment.failed', () => {
      setStatus('idle');
      setError('Payment failed. No money was deducted — please try again.');
    });
    setStatus('checkout');
    rzp.open();
  }

  const busy = status === 'creating' || status === 'checkout' || status === 'verifying';

  return (
    <>
      <Header />
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <h2 style={styles.title}>Top up your wallet</h2>
          <p style={styles.subtitle}>
            Pay-as-you-go · ₹{RATE_PER_MINUTE}/min · ₹50 free on signup · credits never expire
          </p>

          <div style={styles.badgeRow}>
            <span style={styles.badge}>Wallet Top-up</span>
            <span style={styles.badgeMuted}>≈ {minutes} min</span>
          </div>

          <label htmlFor="topup-amount" style={styles.inputLabel}>Enter amount to add</label>
          <div style={styles.amountInputWrap}>
            <span style={styles.rupee}>₹</span>
            <input
              id="topup-amount"
              type="number"
              inputMode="numeric"
              min={MIN_TOPUP}
              max={MAX_TOPUP}
              step={1}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              disabled={busy}
              placeholder={String(DEFAULT_TOPUP)}
              aria-label="Top-up amount in rupees"
              style={styles.amountInput}
            />
          </div>
          <p style={styles.priceLabel}>
            {amountValid
              ? `≈ ${minutes} minute${minutes === 1 ? '' : 's'} · ₹${RATE_PER_MINUTE}/min · never expires`
              : `Enter a whole amount from ₹${MIN_TOPUP} to ₹${MAX_TOPUP.toLocaleString('en-IN')}`}
          </p>

          <div style={styles.presetRow}>
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setAmountText(String(p))}
                disabled={busy}
                style={{ ...styles.presetChip, ...(amount === p ? styles.presetChipActive : {}) }}
              >
                ₹{p.toLocaleString('en-IN')}
              </button>
            ))}
          </div>

          <div style={styles.divider} />

          {error && <div role="alert" style={styles.error}>{error}</div>}

          {status === 'verifying' ? (
            <div style={styles.info}>
              Payment received. Updating your wallet…
            </div>
          ) : (
            <button onClick={handlePay} disabled={busy || !amountValid} className="btn btn-primary" style={{ width: '100%' }}>
              {status === 'creating'
                ? 'Starting…'
                : status === 'checkout'
                ? 'Opening payment…'
                : !amountValid
                ? 'Enter an amount'
                : authed
                ? `Pay ₹${amount.toLocaleString('en-IN')} with UPI / Card`
                : `Get Started — Add ₹${amount.toLocaleString('en-IN')}`}
            </button>
          )}

          <p style={styles.secure}>🔒 Secure payment via Razorpay · UPI, cards, net-banking</p>

          <div style={styles.divider} />

          <p style={styles.contact}>
            Type any amount above — from ₹{MIN_TOPUP} up. Credits are added to your wallet instantly.
          </p>
          <p style={styles.contactSmall}>
            Need help? <a href={`mailto:${SUPPORT_EMAIL}`} style={styles.emailLink}>{SUPPORT_EMAIL}</a>
          </p>
        </div>
      </main>
      <Footer />
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minHeight: '100vh', padding: '100px 24px 60px', background: '#0a0e17',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.03)', border: '1px solid rgba(99, 179, 237, 0.12)',
    borderRadius: 16, padding: '40px 32px', width: '100%', maxWidth: 440,
    textAlign: 'center', backdropFilter: 'blur(8px)',
  },
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 },
  subtitle: { fontSize: 13, color: '#94a3b8', marginBottom: 20, lineHeight: 1.5 },
  badgeRow: { display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12, marginBottom: 8 },
  badge: {
    background: 'rgba(59,130,246,0.15)', border: '1px solid rgba(59,130,246,0.3)', color: '#93c5fd',
    padding: '4px 12px', borderRadius: 100, fontSize: 13, fontWeight: 600,
  },
  badgeMuted: {
    background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.2)', color: '#86efac',
    padding: '4px 12px', borderRadius: 100, fontSize: 13, fontWeight: 500,
  },
  priceLabel: { fontSize: 13, color: '#64748b', marginTop: 10 },
  inputLabel: { display: 'block', fontSize: 13, color: '#94a3b8', marginBottom: 8, textAlign: 'left' },
  amountInputWrap: {
    display: 'flex', alignItems: 'center', gap: 6,
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(99,179,237,0.25)',
    borderRadius: 12, padding: '10px 16px',
  },
  rupee: { fontSize: '1.8rem', fontWeight: 800, color: '#22c55e' },
  amountInput: {
    flex: 1, width: '100%', minWidth: 0, background: 'transparent', border: 'none',
    outline: 'none', color: '#f1f5f9', fontSize: '2rem', fontWeight: 800,
  },
  presetRow: { display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 14, justifyContent: 'center' },
  presetChip: {
    background: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.12)',
    color: '#cbd5e1', borderRadius: 100, padding: '6px 14px', fontSize: 13, fontWeight: 600, cursor: 'pointer',
  },
  presetChipActive: {
    background: 'rgba(34,197,94,0.15)', border: '1px solid rgba(34,197,94,0.5)', color: '#86efac',
  },
  divider: { height: 1, background: 'rgba(255,255,255,0.06)', margin: '24px 0' },
  error: {
    background: 'rgba(239, 68, 68, 0.1)', border: '1px solid rgba(239, 68, 68, 0.3)',
    color: '#fca5a5', padding: '10px 14px', borderRadius: 8, fontSize: 13, marginBottom: 16,
  },
  info: {
    background: 'rgba(59, 130, 246, 0.1)', border: '1px solid rgba(59, 130, 246, 0.3)',
    color: '#93c5fd', padding: '12px 14px', borderRadius: 8, fontSize: 14,
  },
  secure: { fontSize: 12, color: '#64748b', marginTop: 14 },
  contact: { fontSize: 13, color: '#94a3b8' },
  contactSmall: { fontSize: 12, color: '#64748b', marginTop: 6 },
  linkBtn: {
    background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer',
    fontSize: 13, padding: 0, textDecoration: 'underline',
  },
  emailLink: { color: '#60a5fa', textDecoration: 'none' },
};
