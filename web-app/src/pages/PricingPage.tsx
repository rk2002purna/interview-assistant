import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { listPacks, isAuthSession } from '../api/client';

export default function PricingPage() {
  const [packs, setPacks] = useState<any[]>([]);

  useEffect(() => { listPacks().then(setPacks); }, []);

  const displayPacks = packs.length > 0
    ? packs.map((p: any) => ({
        slug: p.slug,
        name: p.display_name || p.slug,
        sessions: p.lifetime ? 'Unlimited' : `${p.session_count || 5}`,
        mrp: p.mrp || 29900,
        price: p.effective_price || p.mrp || 29900,
        lifetime: p.lifetime || false,
        popular: p.slug === 'pro',
        hasDiscount: p.effective_price && p.effective_price < p.mrp,
      }))
    : [
        { slug: 'starter', name: 'Starter', sessions: '5', mrp: 29900, price: 19900, lifetime: false, popular: false, hasDiscount: true },
        { slug: 'pro', name: 'Pro', sessions: '20', mrp: 99900, price: 69900, lifetime: false, popular: true, hasDiscount: true },
        { slug: 'lifetime', name: 'Lifetime', sessions: 'Unlimited', mrp: 499900, price: 299900, lifetime: true, popular: false, hasDiscount: true },
      ];

  return (
    <>
      <Header />
      <main style={{ padding: '120px 24px 80px' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <span className="section-label">Pricing</span>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 16, letterSpacing: '-0.02em' }}>
            Simple, One-Time Pricing
          </h1>
          <p style={{ fontSize: '1.1rem', color: '#94a3b8', maxWidth: 500, margin: '0 auto' }}>
            Buy a pack of interview sessions. Use them anytime. No subscriptions, no recurring fees.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24, maxWidth: 960, margin: '0 auto' }}>
          {displayPacks.map((p) => (
            <div key={p.slug} style={{
              background: p.popular ? 'rgba(59,130,246,0.05)' : 'rgba(255,255,255,0.025)',
              border: `1px solid ${p.popular ? 'rgba(59,130,246,0.3)' : 'rgba(255,255,255,0.08)'}`,
              borderRadius: 16, padding: '48px 32px', textAlign: 'center', position: 'relative', display: 'flex', flexDirection: 'column' }}>
              {p.popular && <div style={{ position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', color: 'white', padding: '4px 14px', borderRadius: 100, fontSize: 12, fontWeight: 600 }}>Most Popular</div>}
              <h3 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 4 }}>{p.name}</h3>
              <p style={{ fontSize: '2.4rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 4 }}>{p.sessions}</p>
              <p style={{ fontSize: 14, color: '#94a3b8', marginBottom: 28 }}>Interview Sessions</p>
              <div style={{ marginBottom: 8 }}>
                <span style={{ fontSize: '2.2rem', fontWeight: 800, color: '#22c55e' }}>₹{(p.price / 100).toLocaleString('en-IN')}</span>
              </div>
              {p.hasDiscount && (
                <>
                  <span style={{ fontSize: 16, color: '#64748b', textDecoration: 'line-through', marginBottom: 4 }}>₹{(p.mrp / 100).toLocaleString('en-IN')}</span>
                  <span style={{ display: 'block', fontSize: 13, color: '#f59e0b', marginBottom: 20, fontWeight: 600 }}>
                    Save {Math.floor((p.mrp - p.price) / p.mrp * 100)}%
                  </span>
                </>
              )}
              <div style={{ flex: 1 }} />
              {isAuthSession() ? (
                <Link to={`/checkout?pack=${p.slug}`} className={`btn ${p.popular ? 'btn-green' : 'btn-outline'}`} style={{ width: '100%' }}>
                  Buy Now — ₹{(p.price / 100).toLocaleString('en-IN')}
                </Link>
              ) : (
                <Link to={`/register?redirect=/checkout%3Fpack%3D${p.slug}`} className={`btn ${p.popular ? 'btn-green' : 'btn-outline'}`} style={{ width: '100%' }}>
                  Get Started
                </Link>
              )}
            </div>
          ))}
        </div>

        <div style={{ maxWidth: 500, margin: '60px auto 0', textAlign: 'center' }}>
          <h3 style={{ fontSize: 17, fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>All packs include:</h3>
          <ul style={{ listStyle: 'none', padding: 0, fontSize: 14, color: '#94a3b8', lineHeight: 2 }}>
            <li>✓ 90-minute interview sessions</li>
            <li>✓ All 3 modes: Manual, Passive, Screen Analyzer</li>
            <li>✓ Advanced AI with real-time responses</li>
            <li>✓ Context-aware answers (resume + job description)</li>
            <li>✓ Sessions never expire</li>
          </ul>
        </div>
      </main>
      <Footer />
    </>
  );
}
