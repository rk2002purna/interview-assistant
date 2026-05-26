import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer style={styles.footer}>
      <div style={styles.grid}>
        <div style={styles.brand}>
          <div style={styles.logo}>
            <img src="/upnod_logo_dark.svg" alt="UpNod" style={{ height: 36, objectFit: 'contain' }} />
          </div>
          <p style={styles.desc}>AI-powered interview co-pilot. Crack technical, behavioral, and coding interviews with real-time AI assistance.</p>
        </div>
        <div>
          <h4 style={styles.heading}>Product</h4>
          <Link to="/#features" style={styles.link}>Features</Link>
          <Link to="/#how-it-works" style={styles.link}>How It Works</Link>
          <Link to="/pricing" style={styles.link}>Pricing</Link>
          <Link to="/download" style={styles.link}>Download</Link>
        </div>
        <div>
          <h4 style={styles.heading}>Resources</h4>
          <Link to="/login" style={styles.link}>Sign In</Link>
          <Link to="/register" style={styles.link}>Create Account</Link>
          <Link to="/#faq" style={styles.link}>FAQ</Link>
        </div>
        <div>
          <h4 style={styles.heading}>Contact</h4>
          <a href="mailto:upnodsupport@gmail.com" style={styles.link}>upnodsupport@gmail.com</a>
          <span style={{ ...styles.link, fontSize: 12, color: '#475569' }}>Support &amp; Payment Queries</span>
        </div>
        <div>
          <h4 style={styles.heading}>Legal</h4>
          <span style={styles.link}>Privacy Policy</span>
          <span style={styles.link}>Terms of Service</span>
        </div>
      </div>
      <div style={styles.bottom}>
        <p>&copy; {new Date().getFullYear()} UpNod. All rights reserved.</p>
      </div>
    </footer>
  );
}

const styles: Record<string, React.CSSProperties> = {
  footer: {
    borderTop: '1px solid rgba(99, 179, 237, 0.08)',
    background: 'rgba(17, 24, 39, 0.5)',
    padding: '64px 24px 32px',
  },
  grid: {
    maxWidth: 1200,
    margin: '0 auto',
    display: 'grid',
    gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
    gap: 40,
  },
  brand: { display: 'flex', flexDirection: 'column', gap: 16 },
  logo: { display: 'flex', alignItems: 'center', gap: 10 },
  logoIcon: {
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    color: 'white',
    width: 32,
    height: 32,
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 13,
  },
  logoText: { fontWeight: 700, fontSize: 15, color: '#f1f5f9' },
  desc: { fontSize: 13, color: '#64748b', lineHeight: 1.6, maxWidth: 320 },
  heading: { fontSize: 13, fontWeight: 600, color: '#94a3b8', marginBottom: 16, textTransform: 'uppercase', letterSpacing: '0.05em' },
  link: { display: 'block', fontSize: 14, color: '#64748b', marginBottom: 10, textDecoration: 'none', cursor: 'pointer', transition: 'color 0.2s' },
  bottom: { maxWidth: 1200, margin: '0 auto', paddingTop: 32, marginTop: 48, borderTop: '1px solid rgba(255,255,255,0.06)', fontSize: 13, color: '#475569', textAlign: 'center' as const },
};
