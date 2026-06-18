import { useSearchParams } from 'react-router-dom';
import { isAuthSession } from '../api/client';
import Header from '../components/Header';
import Footer from '../components/Footer';

const PACK_DETAILS: Record<string, { name: string; sessions: string; price: number }> = {
  starter: { name: 'Starter', sessions: '5', price: 199 },
  pro: { name: 'Pro', sessions: '20', price: 699 },
  lifetime: { name: 'Lifetime', sessions: 'Unlimited', price: 2999 },
};

const UPI_ID = 'myibl7842-1@indie';
const GOOGLE_FORM_URL = 'https://forms.gle/iFwBLLLHFX9dHfyt7';
const SUPPORT_EMAIL = 'upnodsupport@gmail.com';

export default function CheckoutPage() {
  const [searchParams] = useSearchParams();
  const packSlug = searchParams.get('pack') || 'pro';
  const pack: { name: string; sessions: string; price: number } = PACK_DETAILS[packSlug] ?? PACK_DETAILS.pro!;

  if (!isAuthSession()) {
    const redirect = `/checkout?pack=${encodeURIComponent(packSlug)}`;
    window.location.href = `/login?redirect=${encodeURIComponent(redirect)}`;
    return null;
  }

  return (
    <>
      <Header />
      <main style={styles.wrapper}>
        <div style={styles.card}>
          <h2 style={styles.title}>Complete Your Payment</h2>

          {/* Pack summary */}
          <div style={styles.packBadge}>
            <span style={styles.packName}>{pack.name} Pack</span>
            <span style={styles.packSessions}>{pack.sessions} Sessions</span>
          </div>
          <p style={styles.price}>₹{pack.price}</p>
          <p style={styles.priceLabel}>One-time payment</p>

          <div style={styles.divider} />

          {/* QR Code */}
          <div style={styles.qrWrapper}>
            <img
              src="/upi-qr.jpeg"
              alt="UPI QR Code"
              style={styles.qrImage}
              onError={(e) => {
                const el = e.currentTarget;
                el.style.display = 'none';
                const placeholder = document.getElementById('qr-placeholder');
                if (placeholder) placeholder.style.display = 'flex';
              }}
            />
            <div id="qr-placeholder" style={{ ...styles.qrImage, display: 'none', alignItems: 'center', justifyContent: 'center', background: '#e2e8f0', color: '#0a0e17', fontSize: 13, fontWeight: 600, flexDirection: 'column', gap: 4 }}>
              <span>QR Code</span>
              <span style={{ fontSize: 11, fontWeight: 400 }}>Add upi-qr.png to web-app/public/</span>
            </div>
          </div>
          <p style={styles.qrHint}>Scan this QR code with any UPI app</p>

          {/* UPI ID */}
          <div style={styles.upiBox}>
            <span style={styles.upiLabel}>UPI ID</span>
            <span style={styles.upiId}>{UPI_ID}</span>
          </div>
          <button
            style={styles.copyBtn}
            onClick={() => {
              navigator.clipboard.writeText(UPI_ID).catch(() => {});
              const btn = document.getElementById('copy-btn');
              if (btn) { btn.textContent = 'Copied!'; setTimeout(() => { btn.textContent = 'Copy UPI ID'; }, 2000); }
            }}
            id="copy-btn"
          >
            Copy UPI ID
          </button>

          <div style={styles.divider} />

          {/* Steps */}
          <ol style={styles.steps}>
            <li>Send <strong>₹{pack.price}</strong> to the UPI ID above or scan the QR code</li>
            <li>Take a screenshot of your payment confirmation</li>
            <li>Fill out the form below with your payment details</li>
          </ol>

          <a href={GOOGLE_FORM_URL} target="_blank" rel="noopener noreferrer" style={styles.formBtn}>
            Submit Payment Details &amp; Screenshot
          </a>
          <p style={styles.formHint}>
            After submitting, we'll verify your payment within 24 hours and add sessions to your account.
          </p>

          <div style={styles.divider} />

          <p style={styles.contact}>
            Questions? Contact us at{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`} style={styles.emailLink}>{SUPPORT_EMAIL}</a>
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
    background: '#0a0e17',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.03)',
    border: '1px solid rgba(99, 179, 237, 0.12)',
    borderRadius: 16,
    padding: '40px 32px',
    width: '100%',
    maxWidth: 440,
    textAlign: 'center',
    backdropFilter: 'blur(8px)',
  },
  title: { fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 20 },
  packBadge: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
    marginBottom: 8,
  },
  packName: {
    background: 'rgba(59,130,246,0.15)',
    border: '1px solid rgba(59,130,246,0.3)',
    color: '#93c5fd',
    padding: '4px 12px',
    borderRadius: 100,
    fontSize: 13,
    fontWeight: 600,
    textTransform: 'capitalize',
  },
  packSessions: {
    background: 'rgba(34,197,94,0.1)',
    border: '1px solid rgba(34,197,94,0.2)',
    color: '#86efac',
    padding: '4px 12px',
    borderRadius: 100,
    fontSize: 13,
    fontWeight: 500,
  },
  price: { fontSize: '2.8rem', fontWeight: 800, color: '#22c55e', margin: 0 },
  priceLabel: { fontSize: 13, color: '#64748b', marginTop: 2 },

  divider: { height: 1, background: 'rgba(255,255,255,0.06)', margin: '24px 0' },

  qrWrapper: {
    display: 'inline-block',
    padding: 16,
    background: '#fff',
    borderRadius: 12,
    marginBottom: 12,
  },
  qrImage: { width: 200, height: 200, display: 'block' },
  qrHint: { fontSize: 13, color: '#94a3b8', marginBottom: 20 },

  upiBox: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
    background: 'rgba(255,255,255,0.04)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 10,
    padding: '14px 20px',
    marginBottom: 12,
  },
  upiLabel: { fontSize: 11, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1 },
  upiId: { fontSize: 17, fontWeight: 700, color: '#f1f5f9', fontFamily: 'monospace', userSelect: 'all' },

  copyBtn: {
    padding: '8px 20px',
    background: 'rgba(59,130,246,0.12)',
    border: '1px solid rgba(59,130,246,0.25)',
    color: '#93c5fd',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
  },

  steps: {
    textAlign: 'left',
    color: '#94a3b8',
    fontSize: 14,
    lineHeight: 2,
    paddingLeft: 20,
    marginBottom: 20,
  },

  formBtn: {
    display: 'inline-block',
    padding: '14px 28px',
    background: 'linear-gradient(135deg, #22c55e, #16a34a)',
    color: '#fff',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 700,
    textDecoration: 'none',
    boxShadow: '0 2px 20px rgba(34,197,94,0.3)',
    marginBottom: 12,
  },
  formHint: { fontSize: 12, color: '#64748b', lineHeight: 1.6 },

  contact: { fontSize: 13, color: '#64748b' },
  emailLink: { color: '#60a5fa', textDecoration: 'none' },
};
