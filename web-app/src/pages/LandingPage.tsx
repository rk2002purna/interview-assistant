import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from 'react';
import { Link } from 'react-router-dom';
import Header from '../components/Header';
import Footer from '../components/Footer';
import { DownloadContent } from './DownloadPage';
import { isAuthSession } from '../api/client';

type IconName =
  | 'mic'
  | 'listen'
  | 'screen'
  | 'shield'
  | 'spark'
  | 'context'
  | 'download'
  | 'account'
  | 'modes'
  | 'bolt';

function LineIcon({ name, size = 24 }: { name: IconName; size?: number }) {
  const props = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.8,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  switch (name) {
    case 'mic':
      return <svg {...props}><rect x="9" y="2" width="6" height="12" rx="3" /><path d="M5.5 10a6.5 6.5 0 0 0 13 0M12 16.5V22M8.5 22h7" /></svg>;
    case 'listen':
      return <svg {...props}><path d="M4 12a8 8 0 0 1 16 0M4 12v5a2 2 0 0 0 2 2h2v-7H4ZM20 12v5a2 2 0 0 1-2 2h-2v-7h4ZM16 19c0 1.7-1.8 3-4 3" /></svg>;
    case 'screen':
      return <svg {...props}><rect x="3" y="4" width="18" height="13" rx="2" /><path d="M8 21h8M12 17v4M8 9h8M8 12h5" /></svg>;
    case 'shield':
      return <svg {...props}><path d="M12 3 20 6v5c0 5.2-3.4 8.4-8 10-4.6-1.6-8-4.8-8-10V6l8-3Z" /><path d="m9 12 2 2 4-4" /></svg>;
    case 'spark':
      return <svg {...props}><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4L12 3ZM18.5 14l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM6 14l.9 2.6 2.6.9-2.6.9L6 21l-.9-2.6-2.6-.9 2.6-.9L6 14Z" /></svg>;
    case 'context':
      return <svg {...props}><path d="M8 4h8M9 2v4M15 2v4" /><rect x="4" y="5" width="16" height="16" rx="3" /><path d="M8 10h8M8 14h5M8 18h3" /></svg>;
    case 'download':
      return <svg {...props}><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" /></svg>;
    case 'account':
      return <svg {...props}><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></svg>;
    case 'modes':
      return <svg {...props}><rect x="3" y="3" width="7" height="7" rx="2" /><rect x="14" y="3" width="7" height="7" rx="2" /><rect x="3" y="14" width="7" height="7" rx="2" /><path d="M17.5 14v7M14 17.5h7" /></svg>;
    case 'bolt':
      return <svg {...props}><path d="m13 2-8 12h7l-1 8 8-12h-7l1-8Z" /></svg>;
  }
}

export default function LandingPage() {
  return (
    <>
      <Header />
      <main className="landing-page">
        <HeroSection />
        <FeaturesSection />
        <HowItWorksSection />
        <DemoSection />
        <PricingSection />
        <PrivateSection />
        <section id="download" className="section download-section">
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

function HeroSection() {
  const authed = isAuthSession();
  const line1 = 'Walk in prepared.';
  const line2 = 'Answer with confidence.';
  const fullLength = line1.length + line2.length;
  const prefersReducedMotion =
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [charIndex, setCharIndex] = useState(prefersReducedMotion ? fullLength : 0);

  useEffect(() => {
    if (charIndex >= fullLength) return;
    const timeout = window.setTimeout(() => setCharIndex((current) => current + 1), 38);
    return () => window.clearTimeout(timeout);
  }, [charIndex, fullLength]);

  const displayedLine1 = line1.slice(0, Math.min(charIndex, line1.length));
  const displayedLine2 = charIndex > line1.length ? line2.slice(0, charIndex - line1.length) : '';
  const showCursor = charIndex < fullLength;

  return (
    <section className="hero-section">
      <div className="hero-grid-pattern" aria-hidden="true" />
      <div className="hero-glow hero-glow-one" aria-hidden="true" />
      <div className="hero-glow hero-glow-two" aria-hidden="true" />

      <div className="container hero-layout">
        <div className="hero-copy">
          <div className="eyebrow-pill">
            <span className="status-dot" />
            Your calm, real-time interview co-pilot
          </div>
          <h1 className="hero-title" aria-label={`${line1} ${line2}`}>
            <span aria-hidden="true">
              {displayedLine1}
              {showCursor && charIndex <= line1.length && <span className="typing-cursor">|</span>}
              {charIndex > line1.length && <br />}
              {displayedLine2 && <span className="hero-title-accent">{displayedLine2}</span>}
              {showCursor && charIndex > line1.length && <span className="typing-cursor">|</span>}
            </span>
          </h1>
          <p className="hero-subtitle">
            Cueviq listens, understands, and turns interview questions into clear, role-aware guidance in seconds—without interrupting your flow.
          </p>
          <div className="hero-actions">
            <Link to="/download" className="btn btn-primary btn-lg">
              Download for free
              <span aria-hidden="true">→</span>
            </Link>
            <Link to={authed ? '/wallet' : '/register'} className="btn btn-quiet btn-lg">
              {authed ? 'Open my wallet' : 'Create an account'}
            </Link>
          </div>
          <div className="hero-note">
            <span className="hero-note-check">✓</span>
            Windows &amp; macOS
            <span className="hero-note-separator" />
            ₹50 starter credit
            <span className="hero-note-separator" />
            No card required
          </div>
        </div>

        <div className="hero-visual" role="img" aria-label="Illustration of a Cueviq interview session">
          <div className="hero-panel-orbit" aria-hidden="true" />
          <div className="assistant-panel">
            <div className="assistant-topbar">
              <div className="assistant-brand">
                <span className="assistant-mark"><LineIcon name="spark" size={16} /></span>
                <span>Cueviq session</span>
              </div>
              <div className="live-pill"><span /> Live</div>
            </div>

            <div className="mode-row" aria-label="Passive mode is active">
              <span className="mode-chip mode-chip-active"><LineIcon name="listen" size={14} /> Passive</span>
              <span className="mode-chip">Manual</span>
              <span className="mode-chip">Screen</span>
            </div>

            <div className="transcript-card">
              <div className="speaker-row">
                <span className="speaker-avatar">IN</span>
                <div>
                  <strong>Interviewer</strong>
                  <span>Just now</span>
                </div>
              </div>
              <p>“How would you design a system that stays reliable as traffic grows?”</p>
              <div className="waveform" aria-hidden="true">
                <span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span /><span />
              </div>
            </div>

            <div className="answer-card">
              <div className="answer-heading">
                <span><LineIcon name="spark" size={16} /> Suggested approach</span>
                <span className="latency-pill">1.8s</span>
              </div>
              <p>
                Start with clear reliability targets, then separate stateless services from durable data. Add caching and queues where they reduce pressure…
              </p>
              <div className="answer-tags">
                <span>Structured</span>
                <span>Role-aware</span>
                <span>Concise</span>
              </div>
            </div>
          </div>

          <div className="floating-card floating-card-context" aria-hidden="true">
            <span><LineIcon name="context" size={17} /></span>
            Resume context on
          </div>
          <div className="floating-card floating-card-speed" aria-hidden="true">
            <strong>&lt; 2 sec</strong>
            response time
          </div>
        </div>
      </div>

      <div className="container hero-proof" aria-label="Cueviq product highlights">
        <div><strong>3</strong><span>focused modes</span></div>
        <div><strong>&lt;2s</strong><span>typical response</span></div>
        <div><strong>24/7</strong><span>ready when you are</span></div>
        <div><strong>₹5</strong><span>per active minute</span></div>
      </div>
    </section>
  );
}

function FeaturesSection() {
  const features: Array<{ icon: IconName; title: string; desc: string; tone: string }> = [
    {
      icon: 'mic',
      title: 'Ask on your terms',
      desc: 'Use Manual Mode for a direct question and receive a clear answer in seconds.',
      tone: 'lime',
    },
    {
      icon: 'listen',
      title: 'Stay in the conversation',
      desc: 'Passive Mode listens to system audio and prepares guidance while you stay present.',
      tone: 'blue',
    },
    {
      icon: 'screen',
      title: 'Understand what is on screen',
      desc: 'Turn coding tasks, SQL prompts, and technical questions into structured solutions.',
      tone: 'violet',
    },
    {
      icon: 'context',
      title: 'Make every answer sound like you',
      desc: 'Add your resume and target role so suggestions match your experience and vocabulary.',
      tone: 'orange',
    },
    {
      icon: 'bolt',
      title: 'Move at interview speed',
      desc: 'Streaming responses appear as they are generated, so useful context arrives without a pause.',
      tone: 'pink',
    },
    {
      icon: 'shield',
      title: 'Keep your workspace private',
      desc: 'A discreet desktop overlay is designed to stay out of shared screens and recordings.',
      tone: 'teal',
    },
  ];

  return (
    <section id="features" className="section features-section">
      <div className="container">
        <div className="section-heading section-heading-split">
          <div>
            <span className="section-label">Built for the moment</span>
            <h2 className="section-title">Less noise. More useful thinking.</h2>
          </div>
          <p className="section-subtitle">
            Everything is designed to keep you focused on the person in front of you—not on another complicated tool.
          </p>
        </div>

        <div className="feature-grid">
          {features.map((feature, index) => (
            <article className={`feature-card feature-card-${index + 1}`} key={feature.title}>
              <div className={`feature-icon feature-icon-${feature.tone}`}><LineIcon name={feature.icon} /></div>
              <div>
                <h3>{feature.title}</h3>
                <p>{feature.desc}</p>
              </div>
              <span className="feature-index">0{index + 1}</span>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function HowItWorksSection() {
  const steps: Array<{ icon: IconName; title: string; desc: string }> = [
    { icon: 'download', title: 'Install Cueviq', desc: 'Choose Windows or macOS and finish the one-click setup.' },
    { icon: 'account', title: 'Add your context', desc: 'Create your account, then add the resume and role you are targeting.' },
    { icon: 'modes', title: 'Pick a mode', desc: 'Use Manual, Passive, or Screen Analyzer for the interview in front of you.' },
    { icon: 'bolt', title: 'Stay in flow', desc: 'Get concise, context-aware guidance while you keep the conversation natural.' },
  ];

  return (
    <section id="how-it-works" className="section process-section">
      <div className="container">
        <div className="section-heading centered-heading">
          <span className="section-label">Simple by design</span>
          <h2 className="section-title">Ready before your next call.</h2>
          <p className="section-subtitle">Four small steps. No complicated configuration or learning curve.</p>
        </div>

        <div className="process-grid">
          {steps.map((step, index) => (
            <article className="process-card" key={step.title}>
              <div className="process-topline">
                <span className="process-icon"><LineIcon name={step.icon} /></span>
                <span className="process-number">0{index + 1}</span>
              </div>
              <h3>{step.title}</h3>
              <p>{step.desc}</p>
              {index < steps.length - 1 && <span className="process-connector" aria-hidden="true">→</span>}
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

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

  const formatTime = (seconds: number) => {
    if (!Number.isFinite(seconds)) return '0:00';
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.floor(seconds % 60);
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  };

  const segments = chapters.map((chapter, index) => ({
    ...chapter,
    end: index < chapters.length - 1 ? chapters[index + 1]!.start : duration,
  }));
  const activeChapter = segments.reduce(
    (active, segment, index) => (currentTime >= segment.start ? index : active),
    0,
  );

  const resetHideTimer = () => {
    setShowControls(true);
    if (hideTimer.current) clearTimeout(hideTimer.current);
    if (playing) hideTimer.current = setTimeout(() => setShowControls(false), 3000);
  };

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handleTimeUpdate = () => {
      setCurrentTime(video.currentTime);
      if (video.buffered.length && video.duration) {
        setBuffered((video.buffered.end(video.buffered.length - 1) / video.duration) * 100);
      }
    };
    const handleMetadata = () => setDuration(video.duration);
    const handleEnded = () => {
      setPlaying(false);
      setShowControls(true);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('loadedmetadata', handleMetadata);
    video.addEventListener('ended', handleEnded);
    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('loadedmetadata', handleMetadata);
      video.removeEventListener('ended', handleEnded);
      if (hideTimer.current) clearTimeout(hideTimer.current);
    };
  }, []);

  useEffect(() => {
    const handleFullscreen = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', handleFullscreen);
    return () => document.removeEventListener('fullscreenchange', handleFullscreen);
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      void video.play();
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
      setShowControls(true);
    }
    resetHideTimer();
  };

  const seekTo = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.max(0, Math.min(time, video.duration || time));
  };

  const seekInSegment = (event: MouseEvent<HTMLDivElement>, segment: { start: number; end: number }) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = (event.clientX - rect.left) / rect.width;
    seekTo(segment.start + fraction * (segment.end - segment.start));
  };

  const changeVolume = (event: ChangeEvent<HTMLInputElement>) => {
    const nextVolume = Number(event.target.value);
    setVolume(nextVolume);
    if (videoRef.current) videoRef.current.volume = nextVolume;
    setMuted(nextVolume === 0);
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;
    const nextMuted = !muted;
    setMuted(nextMuted);
    video.muted = nextMuted;
  };

  const changeSpeed = (nextSpeed: number) => {
    setSpeed(nextSpeed);
    if (videoRef.current) videoRef.current.playbackRate = nextSpeed;
    setShowSpeed(false);
  };

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) void containerRef.current.requestFullscreen();
    else void document.exitFullscreen();
  };

  const volumeIcon = muted || volume === 0 ? '🔇' : volume < 0.5 ? '🔉' : '🔊';

  return (
    <div
      ref={containerRef}
      className={`video-player${fullscreen ? ' is-fullscreen' : ''}`}
      onMouseMove={resetHideTimer}
      onMouseLeave={() => playing && setShowControls(false)}
    >
      <video
        ref={videoRef}
        src={src}
        poster={poster}
        preload="metadata"
        onClick={togglePlay}
        className="video-element"
      />

      {!playing && (
        <button className="video-play-overlay" onClick={togglePlay} aria-label="Play the Cueviq product tour">
          <span className="video-play-button">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
          </span>
          <span>Watch product tour</span>
        </button>
      )}

      {chapters.length > 0 && (
        <div className="video-chapter-badge" style={{ opacity: showControls ? 1 : 0 }}>
          {chapters[activeChapter]?.title}
        </div>
      )}

      <div className="video-controls" style={{ opacity: showControls ? 1 : 0 }}>
        <div className="video-segments">
          {(duration ? segments : [{ title: '', start: 0, end: duration }]).map((segment, index) => {
            const segmentLength = segment.end - segment.start || 1;
            const fill = Math.max(0, Math.min(1, (currentTime - segment.start) / segmentLength)) * 100;
            const bufferedFill = Math.max(
              0,
              Math.min(1, ((buffered / 100) * duration - segment.start) / segmentLength),
            ) * 100;
            const hovered = hoverChapter === index;

            return (
              <div
                key={`${segment.title}-${index}`}
                className="video-segment"
                onClick={(event) => seekInSegment(event, segment)}
                onMouseEnter={() => setHoverChapter(index)}
                onMouseLeave={() => setHoverChapter(null)}
                style={{ flexGrow: segmentLength }}
                title={segment.title}
              >
                <div className="video-segment-track" style={{ height: hovered ? 6 : 4 }}>
                  <div className="video-segment-buffer" style={{ width: `${bufferedFill}%` }} />
                  <div className="video-segment-fill" style={{ width: `${fill}%` }} />
                </div>
                {hovered && segment.title && <div className="video-segment-tooltip">{segment.title}</div>}
              </div>
            );
          })}
        </div>

        <div className="video-controls-row">
          <button onClick={togglePlay} className="video-control-button" aria-label={playing ? 'Pause' : 'Play'}>
            {playing ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 19h4V5H6zm8-14v14h4V5z" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>
            )}
          </button>

          <div
            className="video-volume-control"
            onMouseEnter={() => setShowVolume(true)}
            onMouseLeave={() => setShowVolume(false)}
          >
            <button onClick={toggleMute} className="video-control-button" aria-label="Mute or unmute">{volumeIcon}</button>
            {showVolume && (
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={muted ? 0 : volume}
                onChange={changeVolume}
                className="video-volume-slider"
                aria-label="Video volume"
              />
            )}
          </div>

          <span className="video-time">{formatTime(currentTime)} / {formatTime(duration)}</span>
          {chapters.length > 0 && <span className="video-current-chapter">• {chapters[activeChapter]?.title}</span>}
          <span className="video-controls-spacer" />

          <div className="video-speed-control">
            <button
              onClick={() => setShowSpeed((open) => !open)}
              className="video-control-button video-speed-button"
              aria-label="Playback speed"
              aria-expanded={showSpeed}
            >
              {speed}x
            </button>
            {showSpeed && (
              <div className="video-speed-menu">
                {SPEEDS.map((option) => (
                  <button
                    key={option}
                    onClick={() => changeSpeed(option)}
                    className={option === speed ? 'is-active' : ''}
                  >
                    {option === 1 ? 'Normal' : `${option}x`}
                  </button>
                ))}
              </div>
            )}
          </div>

          <button onClick={toggleFullscreen} className="video-control-button" aria-label={fullscreen ? 'Exit fullscreen' : 'Enter fullscreen'}>
            {fullscreen ? (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M5 16h3v3h2v-5H5zm3-8H5v2h5V5H8zm6 11h2v-3h3v-2h-5zm2-11V5h-2v5h5V8z" /></svg>
            ) : (
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 14H5v5h5v-2H7zm-2-4h2V7h3V5H5zm12 7h-3v2h5v-5h-2zM14 5v2h3v3h2V5z" /></svg>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

function DemoSection() {
  const chapters: Chapter[] = [
    { title: 'Installation on Windows', start: 0 },
    { title: 'Installation on Mac', start: 57 },
    { title: 'Getting Started', start: 172 },
  ];

  return (
    <section className="section demo-section">
      <div className="container">
        <div className="section-heading centered-heading">
          <span className="section-label">See the flow</span>
          <h2 className="section-title">A quiet tool in a high-pressure moment.</h2>
          <p className="section-subtitle">Take a quick tour of setup, the three modes, and a real Cueviq workflow.</p>
        </div>

        <div className="demo-frame">
          <div className="demo-frame-bar">
            <div className="window-dots" aria-hidden="true"><span /><span /><span /></div>
            <span>Cueviq product tour</span>
            <span className="demo-frame-meta">Windows + macOS</span>
          </div>
          <VideoPlayer
            src="/videos/setup-guide.mp4"
            poster="/videos/setup-guide-poster.svg"
            chapters={chapters}
          />
        </div>
      </div>
    </section>
  );
}

function PricingSection() {
  const authed = isAuthSession();
  const ratePerMinute = 5;
  const signupBonus = 50;
  const topups = [
    { rupees: 100, popular: false },
    { rupees: 300, popular: true },
    { rupees: 500, popular: false },
  ];

  return (
    <section id="pricing" className="section pricing-section">
      <div className="container">
        <div className="section-heading section-heading-split pricing-heading">
          <div>
            <span className="section-label">Honest pricing</span>
            <h2 className="section-title">Pay for interview time. Nothing else.</h2>
          </div>
          <div className="price-rate-card">
            <span>One clear rate</span>
            <div><strong>₹{ratePerMinute}</strong><small>/ active minute</small></div>
            <p>Wallet credit never expires.</p>
          </div>
        </div>

        <div className="pricing-grid">
          {topups.map((topup) => {
            const minutes = Math.floor(topup.rupees / ratePerMinute);
            return (
              <article className={`pricing-card${topup.popular ? ' is-popular' : ''}`} key={topup.rupees}>
                {topup.popular && <span className="popular-badge">Most chosen</span>}
                <div className="pricing-card-head">
                  <span>Wallet top-up</span>
                  <h3>₹{topup.rupees.toLocaleString('en-IN')}</h3>
                </div>
                <div className="pricing-minute-row">
                  <strong>{minutes}</strong>
                  <span>interview minutes</span>
                </div>
                <ul>
                  <li><span>✓</span> No subscription</li>
                  <li><span>✓</span> Use across Windows &amp; Mac</li>
                  <li><span>✓</span> Credit never expires</li>
                </ul>
                <Link to={`/pricing?amount=${topup.rupees}`} className={topup.popular ? 'btn btn-primary' : 'btn btn-quiet'}>
                  {authed ? `Add ₹${topup.rupees.toLocaleString('en-IN')}` : 'Get started'}
                </Link>
              </article>
            );
          })}
        </div>

        <div className="pricing-note">
          <span className="pricing-note-icon"><LineIcon name="spark" size={17} /></span>
          New accounts receive ₹{signupBonus} in starter credit. Each started minute is rounded up, and sessions stop automatically if your wallet runs out.
        </div>
      </div>
    </section>
  );
}

function PrivateSection() {
  return (
    <section className="section private-section">
      <div className="container private-layout">
        <div className="private-copy">
          <span className="section-label">Private by design</span>
          <h2 className="section-title">Your workspace stays yours.</h2>
          <p className="section-subtitle">
            Cueviq is built as a discreet desktop overlay with content protection, no taskbar interruption, and a transparent interface that stays out of your shared screen.
          </p>
          <div className="private-points">
            <span><i>✓</i> Content-protected window</span>
            <span><i>✓</i> No dock or taskbar clutter</span>
            <span><i>✓</i> Works with major meeting tools</span>
          </div>
        </div>

        <div className="private-visual" role="img" aria-label="Private workspace illustration">
          <div className="share-window">
            <div className="share-window-bar">
              <div className="window-dots" aria-hidden="true"><span /><span /><span /></div>
              <span>Screen preview</span>
              <span className="share-live"><i /> Sharing</span>
            </div>
            <div className="share-window-body">
              <div className="share-avatar">YOU</div>
              <div className="share-lines"><span /><span /><span /></div>
              <div className="share-hidden-card">
                <LineIcon name="shield" size={22} />
                <div><strong>Visible only to you</strong><span>Protected from screen capture</span></div>
              </div>
            </div>
          </div>
          <div className="meeting-tools" aria-hidden="true">
            <span>Zoom</span><span>Meet</span><span>Teams</span><span>Recordings</span>
          </div>
        </div>
      </div>
    </section>
  );
}

function FAQSection() {
  const faqs = [
    {
      question: 'Does Cueviq appear during screen sharing?',
      answer: 'Cueviq uses desktop content-protection APIs and a discreet transparent overlay designed to stay out of Zoom, Teams, Google Meet, and common screen recordings.',
    },
    {
      question: 'How quickly do answers appear?',
      answer: 'Typical response time is under two seconds. Answers stream as they are generated, so you can start reading useful context immediately.',
    },
    {
      question: 'Can answers use my own experience?',
      answer: 'Yes. Add your resume and target job description to receive guidance that reflects your background, role, and experience level.',
    },
    {
      question: 'What does Passive Mode do?',
      answer: 'Passive Mode captures system audio, detects an interviewer question, transcribes it, and prepares an answer without requiring manual input.',
    },
    {
      question: 'Can I try Cueviq before paying?',
      answer: 'Yes. Every new account receives ₹50 in starter wallet credit, with no payment card required to begin.',
    },
    {
      question: 'Can one account work on Windows and Mac?',
      answer: 'Yes. Cueviq supports Windows 10/11 and macOS 12+. Your account and wallet credit work across both platforms.',
    },
  ];

  return (
    <section id="faq" className="section faq-section">
      <div className="container faq-layout">
        <div className="faq-heading">
          <span className="section-label">Questions, answered</span>
          <h2 className="section-title">Everything you need to know.</h2>
          <p className="section-subtitle">Still unsure? Email us at <a href="mailto:upnodsupport@gmail.com">upnodsupport@gmail.com</a>.</p>
        </div>
        <div className="faq-list">
          {faqs.map((faq, index) => (
            <details className="faq-item" key={faq.question} open={index === 0}>
              <summary><span>{faq.question}</span><i aria-hidden="true" /></summary>
              <p>{faq.answer}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function CTASection() {
  const authed = isAuthSession();

  return (
    <section className="section final-cta-section">
      <div className="container">
        <div className="final-cta-card">
          <div className="final-cta-glow" aria-hidden="true" />
          <div className="final-cta-copy">
            <span className="section-label">Your next interview</span>
            <h2>Less second-guessing.<br />More confident answers.</h2>
            <p>Download Cueviq, add your context, and walk into the conversation ready.</p>
          </div>
          <div className="final-cta-actions">
            <Link to="/download" className="btn btn-dark btn-lg">Download Cueviq <span aria-hidden="true">→</span></Link>
            <Link to={authed ? '/wallet' : '/register'} className="cta-text-link">
              {authed ? 'Open my wallet' : 'Create a free account'}
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}
