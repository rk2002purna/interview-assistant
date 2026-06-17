import { useState, useEffect } from 'react';
import Header from '../components/Header';
import Footer from '../components/Footer';

// ─── Download URLs — GitHub Releases (public, no login required) ─────────────
export const DOWNLOAD_URLS = {
  windows: 'https://github.com/rk2002purna/interview-assistant/releases/download/windows/UpNod.Setup.1.0.0.exe',
  macArm:  'https://github.com/rk2002purna/interview-assistant/releases/download/UpNodForMacNew/UpNod-1.0.0-arm64.dmg',
  macIntel:'https://github.com/rk2002purna/interview-assistant/releases/download/UpNodForMacOld/UpNod-1.0.0.dmg',
};

export const APP_VERSION = '1.0.0';

type MacChip = 'arm64' | 'x64';

// ─── Detect user's platform ──────────────────────────────────────────────
function detectPlatform(): 'windows' | 'mac' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const ua = (navigator.userAgent || '').toLowerCase();
  // macOS
  if (/macintosh|mac os x/i.test(ua)) return 'mac';
  // Windows
  if (/windows|win32|win64/i.test(ua)) return 'windows';
  return 'other';
}

// ─── Shared sub-components ──────────────────────────────────────────────
function Step({ num, label }: { num: number; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 24, height: 24, borderRadius: '50%',
        background: 'rgba(59,130,246,0.2)', color: '#60a5fa',
        fontSize: 12, fontWeight: 700, flexShrink: 0,
      }}>{num}</span>
      <span style={{ fontSize: 14, color: '#e2e8f0' }}>{label}</span>
    </div>
  );
}

function ReqItem({ label }: { label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, color: '#3b82f6' }}>●</span>
      <span style={{ fontSize: 13, color: '#94a3b8' }}>{label}</span>
    </div>
  );
}

// ─── Download content (shared between Landing page and /download page) ────
export function DownloadContent({ compact = false }: { compact?: boolean }) {
  const [selectedChip, setSelectedChip] = useState<MacChip>('arm64');
  const [userPlatform, setUserPlatform] = useState<'windows' | 'mac' | 'other'>('other');

  useEffect(() => {
    setUserPlatform(detectPlatform());
  }, []);

  const macDownloadUrl = selectedChip === 'arm64' ? DOWNLOAD_URLS.macArm : DOWNLOAD_URLS.macIntel;
  const macChipLabel = selectedChip === 'arm64' ? 'Apple Silicon (M1/M2/M3/M4)' : 'Intel (x64)';

  return (
    <div>
      {/* Header */}
      <div style={{ textAlign: 'center', marginBottom: compact ? 40 : 56 }}>
        {compact ? (
          <>
            <span className="section-label">Download</span>
            <h2 className="section-title" style={{ maxWidth: 600, margin: '0 auto 16px' }}>
              Get UpNod
            </h2>
            <p className="section-subtitle" style={{ margin: '0 auto 40px' }}>
              Available for Windows and macOS. Free download with 3 starter sessions included.
            </p>
          </>
        ) : (
          <>
            <span className="section-label">Download</span>
            <h1 style={{ fontSize: '2.5rem', fontWeight: 800, color: '#f1f5f9', marginBottom: 14, letterSpacing: '-0.02em' }}>
              Get UpNod for Desktop
            </h1>
            <p style={{ fontSize: '1.05rem', color: '#94a3b8', maxWidth: 480, margin: '0 auto' }}>
              Download for Windows or macOS. Free to start — 3 sessions included.
            </p>
          </>
        )}
      </div>

      {/* Platform cards */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 28,
        alignItems: 'start',
        maxWidth: 900,
        margin: '0 auto',
      }}>

        {/* ── Windows ── */}
        <div style={{
          background: userPlatform === 'windows'
            ? 'rgba(59,130,246,0.05)'
            : 'rgba(255,255,255,0.02)',
          border: userPlatform === 'windows'
            ? '2px solid rgba(59,130,246,0.25)'
            : '1px solid rgba(255,255,255,0.06)',
          borderRadius: 16, padding: '36px 32px',
          position: 'relative',
        }}>
          {userPlatform === 'windows' && (
            <span style={{
              position: 'absolute', top: -12, right: 24,
              background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
              color: '#fff', fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 100,
            }}>Recommended for you</span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: 'rgba(0,166,255,0.12)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24,
            }}>🪟</div>
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>Windows</h2>
              <p style={{ fontSize: 13, color: '#64748b' }}>Windows 10 / 11 • x64</p>
            </div>
          </div>

          <div style={{
            background: 'rgba(255,255,255,0.025)', borderRadius: 10,
            padding: '18px 20px', marginBottom: 22,
          }}>
            <Step num={1} label="Download the .exe installer" />
            <Step num={2} label="Run the installer — one click" />
            <Step num={3} label="Launch UpNod from Start Menu" />
            <Step num={4} label="Sign in through your browser" />
          </div>

          <a
            href={DOWNLOAD_URLS.windows}
            className="btn btn-primary btn-lg"
            style={{ width: '100%', marginBottom: 10 }}
          >
            ⬇ Download for Windows
          </a>
          <p style={{ fontSize: 12, color: '#475569', textAlign: 'center' }}>
            Version {APP_VERSION} • ~90 MB • .exe installer
          </p>
        </div>

        {/* ── macOS ── */}
        <div style={{
          background: userPlatform === 'mac'
            ? 'rgba(59,130,246,0.05)'
            : 'rgba(255,255,255,0.025)',
          border: userPlatform === 'mac'
            ? '2px solid rgba(59,130,246,0.25)'
            : '1px solid rgba(255,255,255,0.08)',
          borderRadius: 16, padding: '36px 32px',
          position: 'relative',
        }}>
          {userPlatform === 'mac' && (
            <span style={{
              position: 'absolute', top: -12, right: 24,
              background: 'linear-gradient(135deg, #3b82f6, #2563eb)',
              color: '#fff', fontSize: 11, fontWeight: 600,
              padding: '3px 10px', borderRadius: 100,
            }}>Recommended for you</span>
          )}

          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
            <div style={{
              width: 48, height: 48, borderRadius: 12,
              background: 'rgba(255,255,255,0.06)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 24,
            }}>🍎</div>
            <div>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: '#f1f5f9' }}>macOS</h2>
              <p style={{ fontSize: 13, color: '#64748b' }}>macOS 12+ • Universal</p>
            </div>
          </div>

          {/* Chip Selector */}
          <p style={{
            fontSize: 13, fontWeight: 600, color: '#94a3b8',
            marginBottom: 10, letterSpacing: '0.03em',
          }}>
            Select your Mac type
          </p>

          <div style={{
            display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8,
            marginBottom: 20,
          }}>
            <button
              onClick={() => setSelectedChip('arm64')}
              style={{
                background: selectedChip === 'arm64'
                  ? 'rgba(59,130,246,0.15)'
                  : 'rgba(255,255,255,0.03)',
                border: selectedChip === 'arm64'
                  ? '1.5px solid rgba(59,130,246,0.5)'
                  : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10, padding: '14px 12px',
                cursor: 'pointer', textAlign: 'center',
                transition: 'all 0.2s',
                fontFamily: 'inherit', color: 'inherit',
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 4 }}>💻</div>
              <div style={{
                fontSize: 13, fontWeight: 700,
                color: selectedChip === 'arm64' ? '#60a5fa' : '#94a3b8',
                marginBottom: 2,
              }}>Apple Silicon</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>M1 · M2 · M3 · M4</div>
              {selectedChip === 'arm64' && (
                <span style={{
                  display: 'inline-block', marginTop: 6,
                  fontSize: 10, fontWeight: 600, color: '#22c55e',
                  background: 'rgba(34,197,94,0.12)',
                  padding: '2px 8px', borderRadius: 100,
                }}>✓ Most common</span>
              )}
            </button>

            <button
              onClick={() => setSelectedChip('x64')}
              style={{
                background: selectedChip === 'x64'
                  ? 'rgba(139,92,246,0.15)'
                  : 'rgba(255,255,255,0.03)',
                border: selectedChip === 'x64'
                  ? '1.5px solid rgba(139,92,246,0.5)'
                  : '1px solid rgba(255,255,255,0.08)',
                borderRadius: 10, padding: '14px 12px',
                cursor: 'pointer', textAlign: 'center',
                transition: 'all 0.2s',
                fontFamily: 'inherit', color: 'inherit',
              }}
            >
              <div style={{ fontSize: 18, marginBottom: 4 }}>🖥️</div>
              <div style={{
                fontSize: 13, fontWeight: 700,
                color: selectedChip === 'x64' ? '#a78bfa' : '#94a3b8',
                marginBottom: 2,
              }}>Intel</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>2019 or earlier</div>
              {selectedChip === 'x64' && (
                <span style={{
                  display: 'inline-block', marginTop: 6,
                  fontSize: 10, fontWeight: 600, color: '#a78bfa',
                  background: 'rgba(139,92,246,0.12)',
                  padding: '2px 8px', borderRadius: 100,
                }}>Legacy chip</span>
              )}
            </button>
          </div>

          <div style={{
            background: 'rgba(255,255,255,0.025)', borderRadius: 10,
            padding: '18px 20px', marginBottom: 22,
          }}>
            <Step num={1} label="Download the .dmg disk image" />
            <Step num={2} label="Drag UpNod to Applications" />
            <Step num={3} label="Right-click → Open on first launch" />
            <Step num={4} label="Sign in through your browser" />
          </div>

          <a
            href={macDownloadUrl}
            className="btn btn-green btn-lg"
            style={{ width: '100%', marginBottom: 10 }}
          >
            ⬇ Download for {macChipLabel}
          </a>
          <p style={{ fontSize: 12, color: '#475569', textAlign: 'center' }}>
            Version {APP_VERSION} • ~95 MB • .dmg disk image
          </p>
        </div>
      </div>

      {/* Gatekeeper notice */}
      <div style={{
        maxWidth: 900, margin: '28px auto 0',
        background: 'rgba(245,158,11,0.04)',
        border: '1px solid rgba(245,158,11,0.15)',
        borderRadius: 12, padding: '20px 28px',
      }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
          <span style={{ fontSize: 20, flexShrink: 0 }}>🔐</span>
          <div>
            <h3 style={{ fontSize: 14, fontWeight: 600, color: '#f59e0b', marginBottom: 6 }}>
              macOS may show a security warning on first launch
            </h3>
            <p style={{ fontSize: 13, color: '#94a3b8', lineHeight: 1.7, marginBottom: 10 }}>
              This is Gatekeeper — Apple's notarization check. The app is safe, just from outside the App Store.
              If you see <em>"UpNod is damaged and can't be opened"</em>, run this in Terminal:
            </p>
            <div style={{
              background: 'rgba(0,0,0,0.35)', borderRadius: 8,
              padding: '10px 16px', fontFamily: 'SF Mono, Menlo, monospace',
              fontSize: 13, color: '#68d391',
              display: 'inline-block', userSelect: 'all',
            }}>
              xattr -cr /Applications/UpNod.app
            </div>
          </div>
        </div>
      </div>

      {/* System requirements */}
      <div style={{
        maxWidth: 900, margin: '28px auto 0',
        display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 28,
      }}>
        <div style={{
          background: 'rgba(59,130,246,0.04)',
          border: '1px solid rgba(59,130,246,0.1)',
          borderRadius: 12, padding: '24px 28px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>🪟</span>
            <h4 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>Windows Requirements</h4>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ReqItem label="Windows 10 or 11 (x64)" />
            <ReqItem label="4 GB RAM minimum" />
            <ReqItem label="~50 MB disk space" />
            <ReqItem label="Internet connection for AI" />
          </div>
        </div>
        <div style={{
          background: 'rgba(59,130,246,0.04)',
          border: '1px solid rgba(59,130,246,0.1)',
          borderRadius: 12, padding: '24px 28px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
            <span style={{ fontSize: 20 }}>🍎</span>
            <h4 style={{ fontSize: 15, fontWeight: 600, color: '#f1f5f9' }}>macOS Requirements</h4>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <ReqItem label="macOS 12 (Monterey) or newer" />
            <ReqItem label="Intel or Apple Silicon" />
            <ReqItem label="4 GB RAM minimum" />
            <ReqItem label="Internet connection for AI" />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Full download page (with Header/Footer for /download route) ─────────
export default function DownloadPage() {
  return (
    <>
      <Header />
      <main style={{ padding: '120px 24px 80px' }}>
        <DownloadContent />
      </main>
      <Footer />
    </>
  );
}
