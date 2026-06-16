import Header from '../components/Header';
import Footer from '../components/Footer';

// ─── Download URLs — GitHub Releases (public, no login required) ─────────────
const DOWNLOAD_URLS = {
  windows: 'https://github.com/rk2002purna/interview-assistant/releases/download/windows/UpNod.Setup.1.0.0.exe',
  macArm:  'https://github.com/rk2002purna/interview-assistant/releases/latest/download/UpNod-1.0.0-arm64.dmg',
  macIntel:'https://github.com/rk2002purna/interview-assistant/releases/latest/download/UpNod-1.0.0.dmg',
};

const APP_VERSION = '1.0.0';
// ─────────────────────────────────────────────────────────────────────────────

export default function DownloadPage() {
  return (
    <>
      <Header />
      <main style={{ padding: '120px 24px 80px' }}>
        <div style={{ textAlign: 'center', marginBottom: 60 }}>
          <span className="section-label">Download</span>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 16, letterSpacing: '-0.02em' }}>
            Download UpNod
          </h1>
          <p style={{ fontSize: '1.1rem', color: '#94a3b8', maxWidth: 500, margin: '0 auto' }}>
            Get the desktop app for Windows or macOS. Free with 3 starter sessions.
          </p>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24, maxWidth: 760, margin: '0 auto' }}>

          {/* Windows */}
          <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '40px 28px', textAlign: 'center' }}>
            <span style={{ fontSize: 48, display: 'block', marginBottom: 20 }}>🪟</span>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>Windows</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>Windows 10 / 11 (x64)</p>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 16, marginBottom: 24 }}>
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7, textAlign: 'left' }}>
                • Download the .exe installer<br />
                • Run the installer<br />
                • Launch from Start Menu<br />
                • Sign in through your browser
              </p>
            </div>
            <a href={DOWNLOAD_URLS.windows} download className="btn btn-primary btn-lg" style={{ width: '100%', display: 'inline-block' }}>
              ⬇ Download for Windows
            </a>
            <p style={{ fontSize: 12, color: '#475569', marginTop: 12 }}>Version {APP_VERSION} • .exe installer</p>
          </div>

          {/* macOS */}
          <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '40px 28px', textAlign: 'center' }}>
            <span style={{ fontSize: 48, display: 'block', marginBottom: 20 }}>🍎</span>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>macOS</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 8 }}>macOS 12+</p>

            {/* Chip selector hint */}
            <div style={{ background: 'rgba(99,179,237,0.06)', border: '1px solid rgba(99,179,237,0.15)', borderRadius: 8, padding: '10px 14px', marginBottom: 20, fontSize: 12, color: '#94a3b8', textAlign: 'left' }}>
              💡 <strong style={{ color: '#63b3ed' }}>Not sure which to pick?</strong><br />
              M1 / M2 / M3 / M4 Mac → <strong style={{ color: '#e2e8f0' }}>Apple Silicon (arm64)</strong><br />
              Older Intel Mac → <strong style={{ color: '#e2e8f0' }}>Intel (x64)</strong>
            </div>

            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 16, marginBottom: 20 }}>
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7, textAlign: 'left' }}>
                • Download the .dmg file<br />
                • Drag to Applications folder<br />
                • <strong style={{ color: '#e2e8f0' }}>Right-click → Open</strong> on first launch<br />
                • Sign in through your browser
              </p>
            </div>

            {/* Apple Silicon */}
            <a href={DOWNLOAD_URLS.macArm} download className="btn btn-primary btn-lg" style={{ width: '100%', display: 'inline-block', marginBottom: 10 }}>
              ⬇ Download for Apple Silicon (M1/M2/M3)
            </a>

            {/* Intel */}
            <a href={DOWNLOAD_URLS.macIntel} download className="btn btn-outline btn-lg" style={{ width: '100%', display: 'inline-block' }}>
              ⬇ Download for Intel Mac
            </a>

            <p style={{ fontSize: 12, color: '#475569', marginTop: 12 }}>Version {APP_VERSION} • .dmg disk image</p>
          </div>
        </div>

        {/* First launch instructions for Mac */}
        <div style={{ maxWidth: 600, margin: '32px auto 0', background: 'rgba(245,158,11,0.05)', border: '1px solid rgba(245,158,11,0.2)', borderRadius: 12, padding: '20px 28px' }}>
          <h3 style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b', marginBottom: 10 }}>⚠️ macOS First Launch — Important</h3>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.8, marginBottom: 12 }}>
            macOS may show <em>"UpNod is damaged and can't be opened"</em> — this is a Gatekeeper security warning, not actual damage.
          </p>
          <p style={{ fontSize: 13, color: '#e2e8f0', fontWeight: 600, marginBottom: 6 }}>Fix it in 2 steps:</p>
          <div style={{ background: 'rgba(0,0,0,0.3)', borderRadius: 8, padding: '10px 14px', marginBottom: 10, fontFamily: 'monospace', fontSize: 13, color: '#68d391' }}>
            xattr -cr /Applications/UpNod.app
          </div>
          <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7 }}>
            1. Open <strong style={{ color: '#e2e8f0' }}>Terminal</strong> (search in Spotlight with ⌘+Space)<br />
            2. Paste the command above and press <strong style={{ color: '#e2e8f0' }}>Enter</strong><br />
            3. Open UpNod normally — done ✅
          </p>
        </div>

        {/* System requirements */}
        <div style={{ maxWidth: 600, margin: '24px auto 0', textAlign: 'center', background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 12, padding: '24px 32px' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>System Requirements</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, color: '#94a3b8', textAlign: 'left' }}>
            <div>
              <strong style={{ color: '#e2e8f0' }}>Windows:</strong><br />
              Windows 10/11 x64<br />4 GB RAM minimum<br />50 MB disk space
            </div>
            <div>
              <strong style={{ color: '#e2e8f0' }}>macOS:</strong><br />
              macOS 12+ (Intel or Apple Silicon)<br />4 GB RAM minimum<br />50 MB disk space
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
