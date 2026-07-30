import { useEffect, useState } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';

export const DOWNLOAD_URLS = {
  windows: 'https://github.com/rk2002purna/interview-assistant/releases/download/windows/UpNod.Setup.1.0.0.exe',
  macArm: 'https://github.com/rk2002purna/interview-assistant/releases/download/UpNodForMacNew/UpNod-1.0.0-arm64.dmg',
  macIntel: 'https://github.com/rk2002purna/interview-assistant/releases/download/UpNodForMacOld/UpNod-1.0.0.dmg',
};

export const APP_VERSION = '1.0.0';

type MacChip = 'arm64' | 'x64';
type Platform = 'windows' | 'mac' | 'other';

function detectPlatform(): Platform {
  if (typeof navigator === 'undefined') return 'other';
  const userAgent = (navigator.userAgent || '').toLowerCase();
  if (/macintosh|mac os x/i.test(userAgent)) return 'mac';
  if (/windows|win32|win64/i.test(userAgent)) return 'windows';
  return 'other';
}

function detectMobile(): boolean {
  if (typeof navigator === 'undefined') return false;
  const userAgent = navigator.userAgent || '';
  if (/Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile|Silk/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && typeof document !== 'undefined' && 'ontouchend' in document;
}

function PlatformIcon({ platform }: { platform: 'windows' | 'mac' }) {
  if (platform === 'windows') {
    return (
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 4.6 10.5 3.5v7.7H3V4.6Zm8.5-1.2L21 2v9.2h-9.5V3.4ZM3 12.2h7.5v7.7L3 18.8v-6.6Zm8.5 0H21V22l-9.5-1.4v-8.4Z" />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="12" rx="2" />
      <path d="M2.5 20h19M9.5 16l-.7 4M14.5 16l.7 4" />
    </svg>
  );
}

function DownloadIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12m0 0 4-4m-4 4-4-4M5 21h14" />
    </svg>
  );
}

function Step({ number, children }: { number: number; children: string }) {
  return (
    <li className="install-step">
      <span>{number}</span>
      <p>{children}</p>
    </li>
  );
}

function Requirement({ children }: { children: string }) {
  return <li><span aria-hidden="true">✓</span>{children}</li>;
}

export function DownloadContent({ compact = false }: { compact?: boolean }) {
  const [selectedChip, setSelectedChip] = useState<MacChip>('arm64');
  const [userPlatform, setUserPlatform] = useState<Platform>('other');
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    setUserPlatform(detectPlatform());
    setIsMobile(detectMobile());
  }, []);

  const macDownloadUrl = selectedChip === 'arm64' ? DOWNLOAD_URLS.macArm : DOWNLOAD_URLS.macIntel;
  const macChipLabel = selectedChip === 'arm64' ? 'Apple Silicon' : 'Intel Mac';
  const downloadPageUrl = typeof window === 'undefined'
    ? '/download'
    : new URL('/download', window.location.origin).toString();
  const mobileEmailHref = `mailto:?subject=${encodeURIComponent('Download Cueviq')}&body=${encodeURIComponent(
    `Open this page on your computer to download Cueviq: ${downloadPageUrl}`,
  )}`;

  if (isMobile) {
    return (
      <div className="mobile-download-notice">
        <span className="section-label">Desktop app</span>
        <div className="mobile-download-card">
          <div className="mobile-desktop-icon"><PlatformIcon platform="mac" /></div>
          <h2>Continue on your computer</h2>
          <p>
            Cueviq runs on Windows and macOS, so it cannot be installed on a phone or tablet. Open this page on your computer when you are ready.
          </p>
          <div className="supported-platforms">
            <span><PlatformIcon platform="windows" /> Windows 10 / 11</span>
            <span><PlatformIcon platform="mac" /> macOS 12+</span>
          </div>
          <a className="email-download-link" href={mobileEmailHref}>
            Email this link to myself →
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className={`download-content${compact ? ' is-compact' : ''}`}>
      <div className="download-heading">
        <span className="section-label">Download</span>
        {compact ? <h2 className="section-title">Meet your desktop co-pilot.</h2> : <h1>Get Cueviq for desktop.</h1>}
        <p>Choose your platform and get started with ₹50 in wallet credit. No payment card required.</p>
      </div>

      <div className="platform-grid">
        <article className={`platform-card${userPlatform === 'windows' ? ' is-recommended' : ''}`}>
          {userPlatform === 'windows' && <span className="recommended-pill">Best match for this device</span>}
          <div className="platform-card-head">
            <span className="platform-icon platform-icon-windows"><PlatformIcon platform="windows" /></span>
            <div><h3>Windows</h3><p>Windows 10 / 11 · x64</p></div>
          </div>

          <ol className="install-steps">
            <Step number={1}>Download the .exe installer</Step>
            <Step number={2}>Run the one-click setup</Step>
            <Step number={3}>Open the installed UpNod app</Step>
            <Step number={4}>Sign in through your browser</Step>
          </ol>

          <a href={DOWNLOAD_URLS.windows} className="btn btn-primary btn-lg platform-download-button">
            <DownloadIcon /> Download for Windows
          </a>
          <p className="download-meta">Version {APP_VERSION} · ~90 MB · .exe</p>
        </article>

        <article className={`platform-card${userPlatform === 'mac' ? ' is-recommended' : ''}`}>
          {userPlatform === 'mac' && <span className="recommended-pill">Best match for this device</span>}
          <div className="platform-card-head">
            <span className="platform-icon platform-icon-mac"><PlatformIcon platform="mac" /></span>
            <div><h3>macOS</h3><p>macOS 12+ · Apple or Intel</p></div>
          </div>

          <fieldset className="chip-selector">
            <legend>Which Mac do you have?</legend>
            <div className="chip-options">
              <button
                type="button"
                className={selectedChip === 'arm64' ? 'is-selected' : ''}
                onClick={() => setSelectedChip('arm64')}
                aria-pressed={selectedChip === 'arm64'}
              >
                <span className="chip-symbol">M</span>
                <strong>Apple Silicon</strong>
                <small>M1 · M2 · M3 · M4</small>
                <i>Most common</i>
              </button>
              <button
                type="button"
                className={selectedChip === 'x64' ? 'is-selected' : ''}
                onClick={() => setSelectedChip('x64')}
                aria-pressed={selectedChip === 'x64'}
              >
                <span className="chip-symbol">i</span>
                <strong>Intel</strong>
                <small>Usually 2019 or earlier</small>
                <i>Legacy chip</i>
              </button>
            </div>
          </fieldset>

          <ol className="install-steps install-steps-mac">
            <Step number={1}>Download the .dmg image</Step>
            <Step number={2}>Drag the UpNod app to Applications</Step>
            <Step number={3}>Right-click and open once</Step>
            <Step number={4}>Sign in through your browser</Step>
          </ol>

          <a href={macDownloadUrl} className="btn btn-primary btn-lg platform-download-button">
            <DownloadIcon /> Download for {macChipLabel}
          </a>
          <p className="download-meta">Version {APP_VERSION} · ~95 MB · .dmg</p>
        </article>
      </div>

      <div className="gatekeeper-notice">
        <span className="notice-icon" aria-hidden="true">!</span>
        <div>
          <h3>Opening the current Cueviq desktop build on macOS</h3>
          <p>
            The desktop download is temporarily packaged as UpNod. macOS may show a Gatekeeper warning because it is distributed outside the App Store. If it says the app cannot be opened, run this once in Terminal:
          </p>
          <code>xattr -cr /Applications/UpNod.app</code>
        </div>
      </div>

      <div className="requirements-grid">
        <article className="requirements-card">
          <div className="requirements-head"><PlatformIcon platform="windows" /><h3>Windows requirements</h3></div>
          <ul>
            <Requirement>Windows 10 or 11 (x64)</Requirement>
            <Requirement>4 GB RAM minimum</Requirement>
            <Requirement>About 90 MB disk space</Requirement>
            <Requirement>Internet connection for AI</Requirement>
          </ul>
        </article>
        <article className="requirements-card">
          <div className="requirements-head"><PlatformIcon platform="mac" /><h3>macOS requirements</h3></div>
          <ul>
            <Requirement>macOS 12 or newer</Requirement>
            <Requirement>Intel or Apple Silicon</Requirement>
            <Requirement>4 GB RAM minimum</Requirement>
            <Requirement>Internet connection for AI</Requirement>
          </ul>
        </article>
      </div>
    </div>
  );
}

export default function DownloadPage() {
  return (
    <>
      <Header />
      <main className="download-page-main">
        <div className="container"><DownloadContent /></div>
      </main>
      <Footer />
    </>
  );
}
