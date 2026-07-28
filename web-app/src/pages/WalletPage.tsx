import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { getWallet, listTopups, type WalletInfo, type TopupItem } from '../api/client';

const TOPUP_AMOUNTS = [100, 300, 500, 1000];
const MIN_TOPUP = 1;
const MAX_TOPUP = 100000;

function formatPaise(paise: number): string {
  return '₹' + (paise / 100).toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

export default function WalletPage() {
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const [topups, setTopups] = useState<TopupItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [customAmount, setCustomAmount] = useState('');
  const navigate = useNavigate();

  useEffect(() => {
    let active = true;
    (async () => {
      const [w, t] = await Promise.all([getWallet(), listTopups()]);
      if (!active) return;
      setWallet(w);
      setTopups(t);
      setLoading(false);
    })();
    return () => { active = false; };
  }, []);

  const balancePaise = wallet?.balance_paise ?? 0;
  const ratePaise = wallet?.rate_per_minute_paise ?? 500;
  const minutes = Math.floor(balancePaise / ratePaise);
  const customRupees = Number(customAmount);
  const customValid =
    Number.isInteger(customRupees) && customRupees >= MIN_TOPUP && customRupees <= MAX_TOPUP;

  return (
    <>
      <Header />
      <main style={{ padding: '110px 24px 80px', maxWidth: 720, margin: '0 auto' }}>
        <h1 style={{ fontSize: '1.8rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 4 }}>My Wallet</h1>
        <p style={{ color: '#94a3b8', fontSize: 14, marginBottom: 28 }}>
          Interview time is billed at {formatPaise(ratePaise)}/minute from your wallet.
        </p>

        {/* Balance card */}
        <div style={{
          background: 'rgba(34,197,94,0.06)', border: '1px solid rgba(34,197,94,0.25)',
          borderRadius: 16, padding: '28px', marginBottom: 32, textAlign: 'center',
        }}>
          <p style={{ fontSize: 13, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 1, margin: 0 }}>Current Balance</p>
          <p style={{ fontSize: '2.8rem', fontWeight: 800, color: '#22c55e', margin: '6px 0 0' }}>
            {loading ? '…' : formatPaise(balancePaise)}
          </p>
          <p style={{ fontSize: 14, color: '#94a3b8', margin: 0 }}>
            {loading ? '' : `≈ ${minutes} minutes of interview time remaining`}
          </p>
        </div>

        {/* Add money */}
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>Add Money</h2>
        <p style={{ fontSize: 13, color: '#94a3b8', marginBottom: 14 }}>
          Enter any amount from ₹{MIN_TOPUP} to ₹{MAX_TOPUP.toLocaleString('en-IN')} — even ₹1.
        </p>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (customValid) navigate(`/pricing?amount=${customRupees}`);
          }}
          style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginBottom: 8 }}
        >
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6, flex: '1 1 220px',
            background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(99,179,237,0.25)',
            borderRadius: 12, padding: '12px 16px',
          }}>
            <span style={{ fontSize: '1.3rem', fontWeight: 800, color: '#22c55e' }}>₹</span>
            <input
              type="number"
              inputMode="numeric"
              min={MIN_TOPUP}
              max={MAX_TOPUP}
              step={1}
              value={customAmount}
              onChange={(e) => setCustomAmount(e.target.value)}
              placeholder="Enter amount"
              aria-label="Custom top-up amount in rupees"
              style={{
                flex: 1, minWidth: 0, background: 'transparent', border: 'none',
                outline: 'none', color: '#f1f5f9', fontSize: '1.3rem', fontWeight: 800,
              }}
            />
          </div>
          <button
            type="submit"
            disabled={!customValid}
            className="btn btn-green"
            style={{ flex: '0 0 auto', opacity: customValid ? 1 : 0.5, cursor: customValid ? 'pointer' : 'not-allowed' }}
          >
            Add money
          </button>
        </form>
        <p style={{ fontSize: 12, color: '#64748b', minHeight: 16, marginBottom: 22 }}>
          {customAmount === ''
            ? ''
            : customValid
            ? `≈ ${Math.floor((customRupees * 100) / ratePaise)} minutes of interview time`
            : `Enter a whole number between ₹${MIN_TOPUP} and ₹${MAX_TOPUP.toLocaleString('en-IN')}`}
        </p>

        <p style={{ fontSize: 12, color: '#64748b', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 10 }}>Or pick a quick amount</p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 36 }}>
          {TOPUP_AMOUNTS.map((rupees) => (
            <Link
              key={rupees}
              to={`/pricing?amount=${rupees}`}
              style={{
                display: 'block', textAlign: 'center', textDecoration: 'none',
                background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(99,179,237,0.18)',
                borderRadius: 12, padding: '18px 12px',
              }}
            >
              <div style={{ fontSize: '1.4rem', fontWeight: 800, color: '#f1f5f9' }}>₹{rupees.toLocaleString('en-IN')}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>≈ {Math.floor((rupees * 100) / ratePaise)} min</div>
            </Link>
          ))}
        </div>

        {/* History */}
        <h2 style={{ fontSize: '1.2rem', fontWeight: 700, color: '#f1f5f9', marginBottom: 12 }}>Top-up History</h2>
        {loading ? (
          <p style={{ color: '#64748b', fontSize: 14 }}>Loading…</p>
        ) : topups.length === 0 ? (
          <p style={{ color: '#64748b', fontSize: 14 }}>No top-ups yet.</p>
        ) : (
          <div style={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, overflow: 'hidden' }}>
            {topups.map((t, i) => (
              <div key={t.id} style={{
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                padding: '12px 16px', fontSize: 14,
                borderTop: i === 0 ? 'none' : '1px solid rgba(255,255,255,0.06)',
              }}>
                <div>
                  <div style={{ color: '#f1f5f9', fontWeight: 600 }}>{formatPaise(t.amount_paise)}</div>
                  <div style={{ color: '#64748b', fontSize: 12 }}>{new Date(t.created_at).toLocaleString('en-IN')}</div>
                </div>
                <span style={{
                  fontSize: 12, fontWeight: 600, padding: '3px 10px', borderRadius: 100,
                  background:
                    t.status === 'completed' ? 'rgba(34,197,94,0.12)'
                    : t.status === 'failed' ? 'rgba(239,68,68,0.12)'
                    : t.status === 'expired' ? 'rgba(148,163,184,0.12)'
                    : 'rgba(234,179,8,0.12)',
                  color:
                    t.status === 'completed' ? '#86efac'
                    : t.status === 'failed' ? '#fca5a5'
                    : t.status === 'expired' ? '#94a3b8'
                    : '#fde68a',
                }}>
                  {t.status}
                </span>
              </div>
            ))}
          </div>
        )}

        <p style={{ color: '#64748b', fontSize: 12, marginTop: 24 }}>
          Payments are verified manually within 24 hours and credited to your wallet.
        </p>
      </main>
      <Footer />
    </>
  );
}
