import Header from '../components/Header';
import Footer from '../components/Footer';

// ─── Update these URLs after each GitHub Release ────────────────────────────
// Go to: https://github.com/YOUR-ORG/YOUR-REPO/releases
// Copy the direct asset download links and paste below.
const DOWNLOAD_URLS = {
  windows: 'https://github.com/YOUR-ORG/YOUR-REPO/releases/latest/download/UpNod-Setup.exe',
  mac: 'https://github.com/YOUR-ORG/YOUR-REPO/releases/latest/download/UpNod.dmg',
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

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))', gap: 24, maxWidth: 700, margin: '0 auto' }}>
          {/* Windows */}
          <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '48px 32px', textAlign: 'center' }}>
            <span style={{ fontSize: 48, display: 'block', marginBottom: 20 }}>🪟</span>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>Windows</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>Windows 10 / 11 (x64)</p>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7, textAlign: 'left' }}>
                • Download the .exe installer<br />
                • Run the installer<br />
                • Launch from Start Menu<br />
                • Sign in through your browser
              </p>
            </div>
            <a
              href={DOWNLOAD_URLS.windows}
              download
              className="btn btn-primary btn-lg"
              style={{ width: '100%', display: 'inline-block' }}
            >
              ⬇ Download for Windows
            </a>
            <p style={{ fontSize: 12, color: '#475569', marginTop: 12 }}>Version {APP_VERSION} • .exe installer</p>
          </div>

          {/* macOS */}
          <div style={{ background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 16, padding: '48px 32px', textAlign: 'center' }}>
            <span style={{ fontSize: 48, display: 'block', marginBottom: 20 }}>🍎</span>
            <h2 style={{ fontSize: 22, fontWeight: 700, color: '#f1f5f9', marginBottom: 8 }}>macOS</h2>
            <p style={{ fontSize: 14, color: '#64748b', marginBottom: 24 }}>macOS 12+ (Apple Silicon & Intel)</p>
            <div style={{ background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 20, marginBottom: 24 }}>
              <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7, textAlign: 'left' }}>
                • Download the .dmg file<br />
                • Drag to Applications folder<br />
                • Right-click → Open (first launch)<br />
                • Sign in through your browser
              </p>
            </div>
            <a
              href={DOWNLOAD_URLS.mac}
              download
              className="btn btn-primary btn-lg"
              style={{ width: '100%', display: 'inline-block' }}
            >
              ⬇ Download for macOS
            </a>
            <p style={{ fontSize: 12, color: '#475569', marginTop: 12 }}>Version {APP_VERSION} • .dmg disk image</p>
          </div>
        </div>

        <div style={{ maxWidth: 600, margin: '60px auto 0', textAlign: 'center', background: 'rgba(59,130,246,0.05)', border: '1px solid rgba(59,130,246,0.15)', borderRadius: 12, padding: '24px 32px' }}>
          <h3 style={{ fontSize: 16, fontWeight: 600, color: '#f1f5f9', marginBottom: 8 }}>System Requirements</h3>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, fontSize: 13, color: '#94a3b8', textAlign: 'left' }}>
            <div>
              <strong style={{ color: '#e2e8f0' }}>Windows:</strong><br />
              Windows 10/11 x64<br />4 GB RAM minimum<br />50 MB disk space
            </div>
            <div>
              <strong style={{ color: '#e2e8f0' }}>macOS:</strong><br />
              macOS 12+<br />4 GB RAM minimum<br />50 MB disk space
            </div>
          </div>
        </div>
      </main>
      <Footer />
    </>
  );
}
