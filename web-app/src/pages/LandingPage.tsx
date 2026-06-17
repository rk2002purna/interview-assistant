import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { listPacks } from '../api/client';
import { DownloadContent } from './DownloadPage';

export default function LandingPage() {
  const [packs, setPacks] = useState<any[]>([]);

  useEffect(() => {
    listPacks().then(setPacks);
  }, []);

  return (
    <>
      <Header />
      <main>
        <HeroSection />
        {/* <TrustedBySection /> */}
        <FeaturesSection />
        <HowItWorksSection />
        <DemoSection />
        <PricingSection packs={packs} />
        <InvisibleSection />
        {/* <TestimonialsSection /> */}
        <section id="download" className="section">
          <div className="container">
            <DownloadContent compact />
          </div>
        </section>
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
    </>
  );
}

/* ===== Hero ===== */
function HeroSection() {
  const line1 = 'Ace Every Interview';
  const line2 = 'Before the Interviewer Finishes the Question';
  const fullLength = line1.length + line2.length;
  const [charIndex, setCharIndex] = useState(0);

  useEffect(() => {
    if (charIndex < fullLength) {
      const timeout = setTimeout(() => {
        setCharIndex(charIndex + 1);
      }, 45);
      return () => clearTimeout(timeout);
    }
  }, [charIndex]);

  const displayedLine1 = line1.slice(0, Math.min(charIndex, line1.length));
  const displayedLine2 = charIndex > line1.length ? line2.slice(0, charIndex - line1.length) : '';
  const showCursor = charIndex < fullLength;

  return (
    <section style={hero.container}>
      <div style={hero.glow1} />
      <div style={hero.glow2} />
      <div style={hero.content}>
        <span style={hero.badge}>AI-Powered Interview Co-Pilot</span>
        <h1 style={hero.title}>
          {displayedLine1}
          {showCursor && charIndex <= line1.length && <span style={{ color: '#3b82f6', animation: 'blink 1s step-end infinite' }}>|</span>}
          {charIndex > line1.length && <br />}
          {displayedLine2 && <span style={hero.gradientText}>{displayedLine2}</span>}
          {showCursor && charIndex > line1.length && <span style={{ color: '#3b82f6', animation: 'blink 1s step-end infinite' }}>|</span>}
        </h1>
        <p style={hero.subtitle}>
          Real-time AI answers delivered in under 2 seconds. Works invisibly during screen sharing,
          listens passively to interviewer questions, and even analyzes coding problems from your screen.
        </p>
        <div style={hero.buttons}>
          <Link to="/download" className="btn btn-green btn-lg">
            Download Free
          </Link>
          <Link to="/register" className="btn btn-outline btn-lg">
            Get Started Online
          </Link>
        </div>
        <p style={hero.note}>Available for Windows & macOS. No credit card required for first 3 sessions.</p>
      </div>
    </section>
  );
}

const hero: Record<string, React.CSSProperties> = {
  container: {
    position: 'relative',
    padding: '140px 24px 100px',
    textAlign: 'center',
    overflow: 'hidden',
    background: 'radial-gradient(ellipse 80% 60% at 50% -20%, rgba(59, 130, 246, 0.15), transparent 70%), radial-gradient(ellipse 60% 50% at 80% 80%, rgba(139, 92, 246, 0.1), transparent 70%)',
  },
  glow1: {
    position: 'absolute',
    top: '-200px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 600,
    height: 400,
    background: 'radial-gradient(circle, rgba(59, 130, 246, 0.15), transparent 70%)',
    pointerEvents: 'none',
  },
  glow2: {
    position: 'absolute',
    bottom: '-100px',
    left: '20%',
    width: 500,
    height: 300,
    background: 'radial-gradient(circle, rgba(139, 92, 246, 0.1), transparent 70%)',
    pointerEvents: 'none',
  },
  content: {
    position: 'relative',
    maxWidth: 800,
    margin: '0 auto',
  },
  badge: {
    display: 'inline-block',
    fontSize: 13,
    fontWeight: 600,
    color: '#60a5fa',
    background: 'rgba(59, 130, 246, 0.12)',
    padding: '6px 16px',
    borderRadius: 100,
    marginBottom: 24,
    letterSpacing: '0.02em',
  },
  title: {
    fontSize: 'clamp(2.4rem, 5vw, 3.8rem)',
    fontWeight: 900,
    lineHeight: 1.1,
    color: '#f1f5f9',
    marginBottom: 24,
    letterSpacing: '-0.025em',
  },
  gradientText: {
    background: 'linear-gradient(135deg, #38bdf8 0%, #818cf8 40%, #c084fc 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    backgroundClip: 'text',
  },
  subtitle: {
    fontSize: '1.15rem',
    color: '#94a3b8',
    maxWidth: 620,
    margin: '0 auto 36px',
    lineHeight: 1.7,
  },
  buttons: {
    display: 'flex',
    gap: 14,
    justifyContent: 'center',
    flexWrap: 'wrap' as const,
    marginBottom: 20,
  },
  note: {
    fontSize: 13,
    color: '#64748b',
  },
};

/* ===== Trusted By ===== */
// function TrustedBySection() {
//   return (
//     <section style={trusted.container}>
//       <p style={trusted.label}>Trusted by 10,000+ job seekers worldwide</p>
//       <div style={trusted.stats}>
//         {[
//           { value: '10K+', label: 'Users' },
//           { value: '50K+', label: 'Interviews Cracked' },
//           { value: '2s', label: 'Avg Response Time' },
//           { value: '98%', label: 'Success Rate' },
//         ].map((s) => (
//           <div key={s.label} style={trusted.stat}>
//             <span style={trusted.statValue}>{s.value}</span>
//             <span style={trusted.statLabel}>{s.label}</span>
//           </div>
//         ))}
//       </div>
//     </section>
//   );
// }

// const trusted: Record<string, React.CSSProperties> = {
//   container: {
//     padding: '40px 24px',
//     textAlign: 'center',
//     borderTop: '1px solid rgba(255,255,255,0.04)',
//     borderBottom: '1px solid rgba(255,255,255,0.04)',
//     background: 'rgba(255,255,255,0.01)',
//   },
//   label: { fontSize: 14, color: '#64748b', marginBottom: 28 },
//   stats: {
//     display: 'flex',
//     justifyContent: 'center',
//     gap: 60,
//     flexWrap: 'wrap' as const,
//   },
//   stat: { display: 'flex', flexDirection: 'column' as const, alignItems: 'center', gap: 4 },
//   statValue: { fontSize: '1.8rem', fontWeight: 800, color: '#f1f5f9' },
//   statLabel: { fontSize: 13, color: '#64748b' },
// };

/* ===== Features ===== */
function FeaturesSection() {
  const features = [
    {
      icon: '🎙️',
      title: 'Manual Mode',
      desc: 'Speak a question and get an instant AI answer within 2 seconds. Perfect for behavioral and technical rounds.',
      color: '#3b82f6',
      bg: 'rgba(59, 130, 246, 0.08)',
    },
    {
      icon: '👁️',
      title: 'Passive Mode',
      desc: 'The app listens to the interviewer\'s questions through system audio and automatically provides answers — no input needed.',
      color: '#8b5cf6',
      bg: 'rgba(139, 92, 246, 0.08)',
    },
    {
      icon: '🖥️',
      title: 'Screen Analyzer',
      desc: 'Capture screenshots of coding problems, SQL questions, or MCQs on your screen and get complete solutions instantly.',
      color: '#14b8a6',
      bg: 'rgba(20, 184, 166, 0.08)',
    },
    {
      icon: '🔒',
      title: '100% Undetectable',
      desc: 'Invisible during screen sharing and screen recording. Works on all platforms — Zoom, Teams, Google Meet, HackerRank, and more.',
      color: '#f59e0b',
      bg: 'rgba(245, 158, 11, 0.08)',
    },
    {
      icon: '🧠',
      title: 'Advanced AI',
      desc: 'State-of-the-art reasoning and real-time response generation tuned for technical and behavioral interview scenarios.',
      color: '#ec4899',
      bg: 'rgba(236, 72, 153, 0.08)',
    },
    {
      icon: '⚡',
      title: 'Context-Aware',
      desc: 'Upload your resume and job description. Every answer is tailored to your experience and the target role for maximum relevance.',
      color: '#22c55e',
      bg: 'rgba(34, 197, 94, 0.08)',
    },
  ];

  return (
    <section id="features" className="section">
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">Features</span>
        <h2 className="section-title" style={{ maxWidth: 700, margin: '0 auto 16px' }}>
          Everything You Need to Win Interviews
        </h2>
        <p className="section-subtitle" style={{ margin: '0 auto 60px' }}>
          Three powerful modes. One invisible assistant. No interviewer will ever know.
        </p>

        <div style={featuresGrid.grid}>
          {features.map((f, i) => (
            <div key={i} style={{ ...featuresGrid.card, borderColor: `${f.color}20` }}>
              <div style={{ ...featuresGrid.iconWrap, background: f.bg, color: f.color }}>
                <span style={featuresGrid.iconEmoji}>{f.icon}</span>
              </div>
              <h3 style={featuresGrid.cardTitle}>{f.title}</h3>
              <p style={featuresGrid.cardDesc}>{f.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const featuresGrid: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
    gap: 24,
    maxWidth: 1000,
    margin: '0 auto',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.02)',
    border: '1px solid',
    borderRadius: 14,
    padding: '36px 28px',
    textAlign: 'left' as const,
    transition: 'border-color 0.2s, transform 0.2s',
  },
  iconWrap: {
    width: 48,
    height: 48,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 20,
    fontSize: 24,
  },
  iconEmoji: { lineHeight: 1 },
  cardTitle: { fontSize: 17, fontWeight: 700, color: '#f1f5f9', marginBottom: 10 },
  cardDesc: { fontSize: 14, color: '#94a3b8', lineHeight: 1.65 },
};

/* ===== How It Works ===== */
function HowItWorksSection() {
  const steps = [
    { step: '01', title: 'Download & Install', desc: 'Get the app for Windows or macOS. One-click install, no configuration needed.' },
    { step: '02', title: 'Create Account', desc: 'Register with your email. Get 3 free interview sessions on your Starter pack.' },
    { step: '03', title: 'Choose Your Mode', desc: 'Pick Manual, Passive, or Screen Analyzer based on the interview format.' },
    { step: '04', title: 'Get AI Answers', desc: 'The AI listens or reads your screen and delivers answers in under 2 seconds — invisible to the interviewer.' },
  ];

  return (
    <section id="how-it-works" className="section" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">How It Works</span>
        <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
          Start Cracking Interviews in 4 Steps
        </h2>
        <p className="section-subtitle" style={{ margin: '0 auto 60px' }}>
          No complex setup. Download, sign up, and you're ready for your next interview.
        </p>

        <div style={how.grid}>
          {steps.map((s, i) => (
            <div key={i} style={how.card}>
              <span style={how.step}>{s.step}</span>
              <h3 style={how.title}>{s.title}</h3>
              <p style={how.desc}>{s.desc}</p>
              {i < steps.length - 1 && <div style={how.connector}>→</div>}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const how: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
    gap: 32,
    maxWidth: 1000,
    margin: '0 auto',
  },
  card: {
    position: 'relative',
    background: 'rgba(255, 255, 255, 0.025)',
    border: '1px solid rgba(255, 255, 255, 0.06)',
    borderRadius: 14,
    padding: '40px 24px 32px',
    textAlign: 'center' as const,
  },
  step: { display: 'block', fontSize: '2rem', fontWeight: 900, color: '#3b82f6', marginBottom: 16, opacity: 0.7 },
  title: { fontSize: 17, fontWeight: 700, color: '#f1f5f9', marginBottom: 10 },
  desc: { fontSize: 14, color: '#94a3b8', lineHeight: 1.6 },
  connector: { display: 'none' },
};

/* ===== Demo Video ===== */
function DemoSection() {
  return (
    <section className="section">
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">See It In Action</span>
        <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
          Watch How UpNod Works
        </h2>
        <p className="section-subtitle" style={{ margin: '0 auto 48px' }}>
          See all three modes — Manual, Passive, and Screen Analyzer — in a real interview scenario.
        </p>

        <div style={demo.videoWrap}>
          <div style={demo.placeholder}>
            <div style={demo.playBtn}>▶</div>
            <p style={demo.playText}>Watch Demo (2:30)</p>
          </div>
        </div>
      </div>
    </section>
  );
}

const demo: Record<string, React.CSSProperties> = {
  videoWrap: {
    maxWidth: 800,
    margin: '0 auto',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.06)',
    background: 'rgba(0,0,0,0.4)',
    aspectRatio: '16/9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholder: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'center',
    gap: 16,
    color: '#64748b',
  },
  playBtn: {
    width: 72,
    height: 72,
    borderRadius: '50%',
    background: 'rgba(59,130,246,0.2)',
    border: '2px solid rgba(59,130,246,0.4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 28,
    color: '#60a5fa',
    cursor: 'pointer',
    transition: 'all 0.2s',
  },
  playText: { fontSize: 14, color: '#64748b' },
};

/* ===== Pricing ===== */
function PricingSection({ packs }: { packs: any[] }) {
  const defaults = [
    { slug: 'starter', name: 'Starter', desc: 'Perfect for first-time interview prep', sessions: '5 Sessions', mrp: 29900, price: 19900, lifetime: false, popular: false },
    { slug: 'pro', name: 'Pro', desc: 'For serious job seekers', sessions: '20 Sessions', mrp: 99900, price: 69900, lifetime: false, popular: true },
    { slug: 'lifetime', name: 'Lifetime', desc: 'One-time purchase. Unlimited forever.', sessions: 'Unlimited', mrp: 499900, price: 299900, lifetime: true, popular: false },
  ];

  const displayPacks = packs.length > 0
    ? packs.map((p: any) => ({
        slug: p.slug,
        name: p.display_name || p.slug,
        desc: p.lifetime ? 'One-time. Unlimited forever.' : p.session_count ? `${p.session_count} Sessions` : '',
        sessions: p.lifetime ? 'Unlimited' : `${p.session_count || 5} Sessions`,
        mrp: p.mrp || 29900,
        price: p.effective_price || p.mrp || 29900,
        lifetime: p.lifetime || false,
        popular: p.slug === 'pro',
        hasDiscount: p.effective_price && p.effective_price < p.mrp,
      }))
    : defaults;

  return (
    <section id="pricing" className="section" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">Pricing</span>
        <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
          Pay Once. Use Forever.
        </h2>
        <p className="section-subtitle" style={{ margin: '0 auto 48px' }}>
          No subscriptions. No recurring fees. Buy a pack of sessions and use them whenever you need.
        </p>

        <div style={pricingGrid.grid}>
          {displayPacks.map((p: any) => (
            <div key={p.slug} style={{ ...pricingGrid.card, ...(p.popular ? pricingGrid.cardPopular : {}) }}>
              {p.popular && <div style={pricingGrid.popularBadge}>Most Popular</div>}
              <h3 style={pricingGrid.name}>{p.name}</h3>
              <p style={pricingGrid.sessions}>{p.sessions}</p>
              <p style={pricingGrid.desc}>{p.desc}</p>
              <div style={pricingGrid.priceRow}>
                {p.hasDiscount ? (
                  <>
                    <span style={pricingGrid.mrpStrike}>₹{(p.mrp / 100).toLocaleString('en-IN')}</span>
                    <span style={pricingGrid.price}>₹{(p.price / 100).toLocaleString('en-IN')}</span>
                  </>
                ) : (
                  <span style={pricingGrid.price}>₹{(p.price / 100).toLocaleString('en-IN')}</span>
                )}
              </div>
              {p.hasDiscount && <span style={pricingGrid.discount}>Welcome Offer — Save {Math.floor((p.mrp - p.price) / p.mrp * 100)}%</span>}
              <Link to="/register" className="btn btn-primary" style={{ width: '100%', marginTop: 20 }}>
                Get Started
              </Link>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

const pricingGrid: Record<string, React.CSSProperties> = {
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: 24,
    maxWidth: 900,
    margin: '0 auto',
  },
  card: {
    background: 'rgba(255, 255, 255, 0.025)',
    border: '1px solid rgba(255, 255, 255, 0.08)',
    borderRadius: 16,
    padding: '40px 28px',
    textAlign: 'center' as const,
    position: 'relative',
    display: 'flex',
    flexDirection: 'column' as const,
  },
  cardPopular: {
    borderColor: 'rgba(59, 130, 246, 0.3)',
    background: 'rgba(59, 130, 246, 0.05)',
    transform: 'scale(1.03)',
  },
  popularBadge: {
    position: 'absolute',
    top: -12,
    left: '50%',
    transform: 'translateX(-50%)',
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    color: 'white',
    padding: '4px 14px',
    borderRadius: 100,
    fontSize: 12,
    fontWeight: 600,
  },
  name: { fontSize: 20, fontWeight: 700, color: '#f1f5f9', marginBottom: 6 },
  sessions: { fontSize: 2.2 + 'rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 6 },
  desc: { fontSize: 14, color: '#94a3b8', marginBottom: 20 },
  priceRow: { display: 'flex', alignItems: 'baseline', justifyContent: 'center', gap: 10, flexWrap: 'wrap' as const },
  mrpStrike: { fontSize: 18, color: '#64748b', textDecoration: 'line-through' },
  price: { fontSize: '2.2rem', fontWeight: 800, color: '#22c55e' },
  discount: { display: 'block', fontSize: 13, color: '#f59e0b', marginTop: 8, fontWeight: 600 },
};

/* ===== Invisible ===== */
function InvisibleSection() {
  return (
    <section className="section">
      <div className="container" style={{ textAlign: 'center' as const, maxWidth: 700, margin: '0 auto' }}>
        <span style={{ fontSize: 56, display: 'block', marginBottom: 24 }}>🫥</span>
        <h2 className="section-title" style={{ marginBottom: 20 }}>
          Invisible. Undetectable. Unstoppable.
        </h2>
        <p style={{ fontSize: '1.1rem', color: '#94a3b8', lineHeight: 1.7 }}>
          The app is designed from the ground up to be invisible during screen sharing and recording.
          No taskbar icon. No dock presence. 100% transparent overlay. Content protection enabled.
          Even when sharing your full screen on Zoom, Teams, or Google Meet — the interviewer sees nothing.
        </p>
      </div>
    </section>
  );
}

/* ===== Testimonials ===== */
// function TestimonialsSection() {
//   const testimonials = [
//     { quote: 'Got my dream job at Google thanks to UpNod. The passive mode caught every question the interviewer asked.', name: 'Rahul S.', role: 'Software Engineer at Google', avatar: 'RS' },
//     { quote: 'The Screen Analyzer mode solved a LeetCode hard in under 30 seconds. I would have never solved it on my own.', name: 'Priya M.', role: 'Senior Developer at Amazon', avatar: 'PM' },
//     { quote: 'Used it for 5 interviews. Got 4 offers. The context-aware answers that match your resume are a game changer.', name: 'Alex K.', role: 'Full Stack at Microsoft', avatar: 'AK' },
//   ];

//   return (
//     <section className="section" style={{ background: 'rgba(255,255,255,0.015)' }}>
//       <div className="container" style={{ textAlign: 'center' as const }}>
//         <span className="section-label">Testimonials</span>
//         <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
//           Loved by Job Seekers Worldwide
//         </h2>
//         <p className="section-subtitle" style={{ margin: '0 auto 48px' }}>
//           Real stories from real users who landed their dream jobs.
//         </p>

//         <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24, maxWidth: 960, margin: '0 auto' }}>
//           {testimonials.map((t, i) => (
//             <div key={i} style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 14, padding: '32px 24px', textAlign: 'left' as const }}>
//               <p style={{ fontSize: 14, color: '#cbd5e1', lineHeight: 1.7, fontStyle: 'italic', marginBottom: 20 }}>"{t.quote}"</p>
//               <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
//                 <div style={{ width: 40, height: 40, borderRadius: '50%', background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: 'white' }}>{t.avatar}</div>
//                 <div>
//                   <div style={{ fontSize: 14, fontWeight: 600, color: '#f1f5f9' }}>{t.name}</div>
//                   <div style={{ fontSize: 12, color: '#64748b' }}>{t.role}</div>
//                 </div>
//               </div>
//             </div>
//           ))}
//         </div>
//       </div>
//     </section>
//   );
// }

/* ===== FAQ ===== */
function FAQSection() {
  const faqs = [
    { q: 'Is UpNod detectable during screen sharing?', a: 'No. The app uses content protection APIs, hides from the taskbar, and renders as a transparent overlay. It is invisible in Zoom, Teams, Google Meet, and all major screen-sharing and recording tools.' },
    { q: 'How fast are the AI responses?', a: 'Average response time is under 2 seconds. The app uses streaming AI models that deliver answers token-by-token as they are generated.' },
    { q: 'How accurate are the AI answers?', a: 'The AI delivers highly accurate, context-aware responses by analyzing your resume and the job description. Answers are tailored to match the role and your experience level.' },
    { q: 'How does Passive Mode work?', a: 'Passive Mode captures system audio output, detects when the interviewer asks a question, transcribes it automatically, and generates an answer — all without you touching the app.' },
    { q: 'Is there a free trial?', a: 'Yes. Every new account includes a Welcome Offer with discounted pricing on the Starter pack. You also get 3 free sessions when you sign up.' },
    { q: 'Can I use it on both Windows and Mac?', a: 'Yes, UpNod supports Windows 10/11 and macOS 12+. Your account and purchased sessions work across both platforms.' },
  ];

  return (
    <section id="faq" className="section" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">FAQ</span>
        <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
          Frequently Asked Questions
        </h2>
        <div style={{ maxWidth: 700, margin: '48px auto 0', textAlign: 'left' as const }}>
          {faqs.map((f, i) => (
            <details key={i} style={faq.item}>
              <summary style={faq.question}>{f.q}</summary>
              <p style={faq.answer}>{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

const faq: Record<string, React.CSSProperties> = {
  item: {
    borderBottom: '1px solid rgba(255,255,255,0.06)',
    padding: '16px 0',
    cursor: 'pointer',
  },
  question: { fontSize: 16, fontWeight: 600, color: '#e2e8f0', padding: '8px 0', listStyle: 'none' },
  answer: { fontSize: 14, color: '#94a3b8', padding: '8px 0 16px', lineHeight: 1.65 },
};

/* ===== CTA ===== */
function CTASection() {
  return (
    <section className="section">
      <div style={{ maxWidth: 700, margin: '0 auto', textAlign: 'center' as const, padding: '0 24px' }}>
        <div style={{ background: 'linear-gradient(135deg, rgba(59,130,246,0.1), rgba(139,92,246,0.1))', border: '1px solid rgba(139,92,246,0.2)', borderRadius: 20, padding: '60px 40px' }}>
          <h2 style={{ fontSize: '2rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 16, letterSpacing: '-0.02em' }}>
            Ready to Crack Your Next Interview?
          </h2>
          <p style={{ fontSize: '1.1rem', color: '#94a3b8', marginBottom: 32, maxWidth: 500, margin: '0 auto 32px' }}>
            Join 10,000+ professionals who landed their dream jobs with UpNod.
          </p>
          <div style={{ display: 'flex', gap: 14, justifyContent: 'center', flexWrap: 'wrap' as const }}>
            <Link to="/download" className="btn btn-green btn-lg">Download Now</Link>
            <Link to="/register" className="btn btn-outline btn-lg">Create Free Account</Link>
          </div>
        </div>
      </div>
    </section>
  );
}
