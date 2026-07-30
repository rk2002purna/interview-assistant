import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { DownloadContent } from './DownloadPage';
import { isAuthSession } from '../api/client';

export default function LandingPage() {

  return (
    <>
      <Header />
      <main>
        <HeroSection />
        {/* <TrustedBySection /> */}
        <FeaturesSection />
        <HowItWorksSection />
        <DemoSection />
        <PricingSection />
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
  const authed = isAuthSession();
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
          <Link to={authed ? '/wallet' : '/register'} className="btn btn-outline btn-lg">
            {authed ? 'Go to My Wallet' : 'Get Started Online'}
          </Link>
        </div>
        <p style={hero.note}>Available for Windows & macOS. ₹50 free wallet credit on signup — no credit card required.</p>
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
    { step: '02', title: 'Create Account', desc: 'Register with your email. Get ₹50 free wallet credit to start — pay just ₹5/min after.' },
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
// A chapter marks WHERE (in seconds) a section starts within the single merged video.
type Chapter = { title: string; start: number };

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function VideoPlayer({ src, poster, chapters }: { src: string; poster?: string; chapters: Chapter[] }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [playing, setPlaying] = useState(false);
  const [buffered, setBuffered] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [showVolume, setShowVolume] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);
  const [hoverChapter, setHoverChapter] = useState<number | null>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fmt = (s: number) => {
    if (!isFinite(s)) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // Compute each chapter's [start, end] window along the timeline.
  const segments = chapters.map((ch, i) => ({
    ...ch,
    end: i < chapters.length - 1 ? chapters[i + 1]!.start : duration,
  }));

  const activeChapter = segments.reduce((acc, seg, i) => (currentTime >= seg.start ? i : acc), 0);

  const resetHideTimer = () => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setShowControls(false), 3000);
  };

  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onTime = () => {
      setCurrentTime(v.currentTime);
      if (v.buffered.length) setBuffered((v.buffered.end(v.buffered.length - 1) / v.duration) * 100);
    };
    const onMeta = () => setDuration(v.duration);
    const onEnd = () => { setPlaying(false); setShowControls(true); };
    v.addEventListener('timeupdate', onTime);
    v.addEventListener('loadedmetadata', onMeta);
    v.addEventListener('ended', onEnd);
    return () => { v.removeEventListener('timeupdate', onTime); v.removeEventListener('loadedmetadata', onMeta); v.removeEventListener('ended', onEnd); };
  }, []);

  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) { v.play(); setPlaying(true); } else { v.pause(); setPlaying(false); setShowControls(true); }
    resetHideTimer();
  };

  const seekTo = (t: number) => {
    const v = videoRef.current;
    if (!v) return;
    v.currentTime = Math.max(0, Math.min(t, v.duration || t));
  };

  // Click anywhere within a segment to seek to that exact position.
  const seekInSegment = (e: React.MouseEvent<HTMLDivElement>, seg: { start: number; end: number }) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = (e.clientX - rect.left) / rect.width;
    seekTo(seg.start + frac * (seg.end - seg.start));
  };

  const changeVolume = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = Number(e.target.value);
    setVolume(val);
    if (videoRef.current) videoRef.current.volume = val;
    setMuted(val === 0);
  };

  const toggleMute = () => {
    if (!videoRef.current) return;
    const next = !muted;
    setMuted(next);
    videoRef.current.muted = next;
  };

  const changeSpeed = (s: number) => {
    setSpeed(s);
    if (videoRef.current) videoRef.current.playbackRate = s;
    setShowSpeed(false);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) containerRef.current.requestFullscreen();
    else document.exitFullscreen();
  };

  const volIcon = muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';

  return (
    <div className="product-tour-shell" style={demo.videoWrap}>
      <div className="product-tour-banner">
        <div className="product-tour-banner-copy">
          <span className="product-tour-kicker"><i aria-hidden="true" /> Guided product tour</span>
          <h3>See UpNod from setup to your first session</h3>
          <p>A quick, chaptered walkthrough you can pause, replay, or watch at your own pace.</p>
        </div>
        <div className="product-tour-meta" aria-label="Video details">
          <span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
            {duration ? `${Math.max(1, Math.ceil(duration / 60))} min` : 'Quick tour'}
          </span>
          <span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M5 4h14v16H5zM9 4v16M15 4v16" /></svg>
            {chapters.length} chapters
          </span>
          <span className="product-tour-platforms">Windows + macOS</span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="product-tour-frame"
        onMouseMove={resetHideTimer}
        onMouseLeave={() => playing && setShowControls(false)}
        onTouchStart={resetHideTimer}
        onFocus={resetHideTimer}
        style={demo.playerWrap}
        role="region"
        aria-label="UpNod product tour video player"
      >
        <video
          ref={videoRef}
          className="product-tour-video"
          src={src}
          poster={poster}
          onClick={togglePlay}
          style={{ width: '100%', height: '100%', display: 'block', cursor: 'pointer', objectFit: 'contain', background: '#000' }}
        />

        {!playing && (
          <button type="button" onClick={togglePlay} className="product-tour-start" style={demo.bigPlay} aria-label="Play the UpNod product tour">
            <span className="product-tour-play-circle" style={demo.bigPlayCircle}>
              <svg width="32" height="32" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>
            </span>
            <span className="product-tour-play-copy">
              <strong>{currentTime > 0 ? 'Continue watching' : 'Play product tour'}</strong>
              <small>{currentTime > 0 ? `Resume at ${fmt(currentTime)}` : 'Setup, modes, and your first session'}</small>
            </span>
          </button>
        )}

        {chapters.length > 0 && (
          <div className="product-tour-current-chapter" style={{ ...demo.titleBadge, opacity: showControls ? 1 : 0 }}>
            <span>Chapter {String(activeChapter + 1).padStart(2, '0')}</span>
            <strong>{chapters[activeChapter]?.title}</strong>
          </div>
        )}

        <div className={`product-tour-controls${showControls ? ' is-visible' : ''}`} style={{ ...demo.controls, opacity: showControls ? 1 : 0, transition: 'opacity 0.3s' }}>
          <div className="product-tour-segments" style={demo.segmentBar}>
            {(duration ? segments : [{ title: '', start: 0, end: duration }]).map((seg, i) => {
              const segLen = seg.end - seg.start || 1;
              const fill = Math.max(0, Math.min(1, (currentTime - seg.start) / segLen)) * 100;
              const buf = Math.max(0, Math.min(1, ((buffered / 100) * duration - seg.start) / segLen)) * 100;
              const isHover = hoverChapter === i;
              return (
                <div
                  key={i}
                  className="product-tour-segment"
                  onClick={(e) => seekInSegment(e, seg)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      seekTo(seg.start);
                    }
                  }}
                  onMouseEnter={() => setHoverChapter(i)}
                  onMouseLeave={() => setHoverChapter(null)}
                  style={{ ...demo.segment, flexGrow: segLen }}
                  title={seg.title}
                  role="button"
                  tabIndex={0}
                  aria-label={seg.title ? `Jump to ${seg.title}` : 'Video progress'}
                >
                  <div style={{ ...demo.segTrack, height: isHover ? 6 : 4 }}>
                    <div style={{ ...demo.segBuf, width: `${buf}%` }} />
                    <div className="product-tour-segment-fill" style={{ ...demo.segFill, width: `${fill}%` }} />
                  </div>
                  {isHover && seg.title && <div className="product-tour-tooltip" style={demo.segTooltip}>{seg.title}</div>}
                </div>
              );
            })}
          </div>

          <div className="product-tour-controls-row" style={demo.controlsRow}>
            <button type="button" onClick={togglePlay} style={demo.ctrlBtn} title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause video' : 'Play video'}>
              {playing
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M6 19h4V5H6zm8-14v14h4V5z"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>}
            </button>

            <div className="product-tour-volume" style={{ display: 'flex', alignItems: 'center', gap: 6, position: 'relative' }}
              onMouseEnter={() => setShowVolume(true)} onMouseLeave={() => setShowVolume(false)}>
              <button type="button" onClick={toggleMute} style={demo.ctrlBtn} title="Mute/Unmute" aria-label={muted ? 'Unmute video' : 'Mute video'}>{volIcon}</button>
              {showVolume && (
                <input type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume}
                  onChange={changeVolume} style={demo.volSlider} aria-label="Video volume" />
              )}
            </div>

            <span className="product-tour-time" style={demo.timeLabel}>{fmt(currentTime)} / {fmt(duration)}</span>
            {chapters.length > 0 && <span className="product-tour-chapter-label" style={demo.chapterNowLabel}>• {chapters[activeChapter]?.title}</span>}

            <div style={{ flex: 1 }} />

            <div className="product-tour-speed" style={{ position: 'relative' }}>
              <button type="button" onClick={() => setShowSpeed((s) => !s)} style={{ ...demo.ctrlBtn, fontSize: 13, fontWeight: 600, color: '#fff' }} title="Playback speed" aria-label={`Playback speed ${speed}x`} aria-expanded={showSpeed}>
                {speed}x
              </button>
              {showSpeed && (
                <div className="product-tour-speed-menu" style={demo.speedMenu} role="menu" aria-label="Playback speed">
                  {SPEEDS.map((s) => (
                    <button type="button" key={s} onClick={() => changeSpeed(s)}
                      style={{ ...demo.speedItem, ...(s === speed ? demo.speedItemActive : {}) }} aria-pressed={s === speed}>
                      {s === 1 ? 'Normal' : `${s}x`}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <button type="button" onClick={toggleFullscreen} style={demo.ctrlBtn} title="Fullscreen" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
              {fullscreen
                ? <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z"/></svg>
                : <svg width="18" height="18" viewBox="0 0 24 24" fill="white" aria-hidden="true"><path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z"/></svg>}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function DemoSection() {
  // ⬇️ One merged video. `start` = seconds where each section begins.
  // Update these timestamps to match your merged file.
  const chapters: Chapter[] = [
    { title: 'Installation on Windows', start: 0 },
    { title: 'Installation on Mac', start: 57 },
    { title: 'Getting Started', start: 172 },
  ];

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

        <VideoPlayer
          src="/videos/setup-guide.mp4"
          poster="/videos/setup-guide-poster.svg"
          chapters={chapters}
        />
      </div>
    </section>
  );
}

const demo: Record<string, React.CSSProperties> = {
  videoWrap: {
    maxWidth: 860,
    margin: '0 auto',
    borderRadius: 16,
    overflow: 'hidden',
    border: '1px solid rgba(255,255,255,0.08)',
    background: '#000',
    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
  },
  playerWrap: {
    position: 'relative',
    width: '100%',
    aspectRatio: '16/9',
    background: '#000',
    userSelect: 'none',
  },
  titleBadge: {
    position: 'absolute', top: 0, left: 0, right: 0,
    padding: '14px 18px',
    background: 'linear-gradient(rgba(0,0,0,0.7), transparent)',
    color: '#fff', fontSize: 14, fontWeight: 600, textAlign: 'left',
    transition: 'opacity 0.3s', pointerEvents: 'none',
  },
  bigPlay: {
    position: 'absolute', inset: 0,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    cursor: 'pointer',
  },
  bigPlayCircle: {
    width: 72, height: 72, borderRadius: '50%',
    background: 'rgba(255,255,255,0.15)',
    backdropFilter: 'blur(8px)',
    border: '2px solid rgba(255,255,255,0.3)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transition: 'background 0.2s',
  },
  controls: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    background: 'linear-gradient(transparent, rgba(0,0,0,0.85))',
    padding: '32px 16px 12px',
  },
  segmentBar: {
    display: 'flex', alignItems: 'center', gap: 3,
    marginBottom: 10, height: 12,
  },
  segment: {
    position: 'relative', flexBasis: 0, height: '100%',
    display: 'flex', alignItems: 'center', cursor: 'pointer',
  },
  segTrack: {
    position: 'relative', width: '100%', borderRadius: 3,
    background: 'rgba(255,255,255,0.25)', overflow: 'hidden',
    transition: 'height 0.1s',
  },
  segBuf: {
    position: 'absolute', top: 0, left: 0, height: '100%',
    background: 'rgba(255,255,255,0.4)', pointerEvents: 'none',
  },
  segFill: {
    position: 'absolute', top: 0, left: 0, height: '100%',
    background: '#6366f1', pointerEvents: 'none',
  },
  segTooltip: {
    position: 'absolute', bottom: '160%', left: '50%',
    transform: 'translateX(-50%)', whiteSpace: 'nowrap',
    background: 'rgba(20,20,25,0.97)', color: '#fff',
    padding: '5px 10px', borderRadius: 6, fontSize: 12, fontWeight: 600,
    pointerEvents: 'none', boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  },
  chapterNowLabel: {
    color: 'rgba(255,255,255,0.85)', fontSize: 12, fontWeight: 600,
    marginLeft: 8, whiteSpace: 'nowrap', overflow: 'hidden',
    textOverflow: 'ellipsis', maxWidth: 200,
  },
  controlsRow: {
    display: 'flex', alignItems: 'center', gap: 4,
  },
  ctrlBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    padding: '4px 6px', display: 'flex', alignItems: 'center', justifyContent: 'center',
    opacity: 0.9, fontSize: 16,
  },
  timeLabel: {
    color: 'rgba(255,255,255,0.75)', fontSize: 12, fontFamily: 'monospace', marginLeft: 4,
  },
  volSlider: {
    width: 72, accentColor: '#6366f1', cursor: 'pointer',
  },
  speedMenu: {
    position: 'absolute', bottom: '130%', right: 0,
    background: 'rgba(20,20,25,0.97)', borderRadius: 8,
    border: '1px solid rgba(255,255,255,0.1)',
    padding: 4, display: 'flex', flexDirection: 'column',
    minWidth: 96, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
  },
  speedItem: {
    background: 'none', border: 'none', color: 'rgba(255,255,255,0.8)',
    padding: '7px 12px', textAlign: 'left', cursor: 'pointer',
    fontSize: 13, borderRadius: 6, whiteSpace: 'nowrap',
  },
  speedItemActive: {
    background: 'rgba(99,102,241,0.25)', color: '#fff', fontWeight: 600,
  },
};

/* ===== Pricing ===== */
function PricingSection() {
  const authed = isAuthSession();
  const RATE_PER_MINUTE = 5;
  const SIGNUP_BONUS = 50;
  const topups = [
    { rupees: 100, popular: false },
    { rupees: 300, popular: true },
    { rupees: 500, popular: false },
  ];

  return (
    <section id="pricing" className="section" style={{ background: 'rgba(255,255,255,0.015)' }}>
      <div className="container" style={{ textAlign: 'center' as const }}>
        <span className="section-label">Pricing</span>
        <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
          Pay Only for the Minutes You Use
        </h2>
        <p className="section-subtitle" style={{ margin: '0 auto 40px' }}>
          No subscriptions, no packs. A flat ₹{RATE_PER_MINUTE}/minute, charged only while an interview
          session is running. New accounts get ₹{SIGNUP_BONUS} free to start.
        </p>

        <div style={pricingGrid.grid}>
          {topups.map((t) => {
            const minutes = Math.floor(t.rupees / RATE_PER_MINUTE);
            return (
              <div key={t.rupees} style={{ ...pricingGrid.card, ...(t.popular ? pricingGrid.cardPopular : {}) }}>
                {t.popular && <div style={pricingGrid.popularBadge}>Most Popular</div>}
                <h3 style={pricingGrid.name}>Top up ₹{t.rupees.toLocaleString('en-IN')}</h3>
                <p style={pricingGrid.sessions}>{minutes} min</p>
                <p style={pricingGrid.desc}>at ₹{RATE_PER_MINUTE}/minute · never expires</p>
                <div style={pricingGrid.priceRow}>
                  <span style={pricingGrid.price}>₹{t.rupees.toLocaleString('en-IN')}</span>
                </div>
                <Link
                  to={`/pricing?amount=${t.rupees}`}
                  className="btn btn-primary"
                  style={{ width: '100%', marginTop: 20 }}
                >
                  {authed ? `Add ₹${t.rupees.toLocaleString('en-IN')}` : 'Get Started'}
                </Link>
              </div>
            );
          })}
        </div>
        <p style={{ fontSize: 13, color: '#64748b', marginTop: 24 }}>
          Each started minute is rounded up. Sessions stop automatically when your wallet runs out.
        </p>
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
  const authed = isAuthSession();
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
            <Link to={authed ? '/wallet' : '/register'} className="btn btn-outline btn-lg">
              {authed ? 'Go to My Wallet' : 'Create Free Account'}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
