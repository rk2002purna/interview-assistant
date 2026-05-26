import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { isAuthSession, isAdminSession, getCurrentUser, getDisplayName } from '../api/client';
import { logout } from '../api/client';

const navLinks = [
  { to: '/#features', label: 'Features' },
  { to: '/#how-it-works', label: 'How It Works' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/download', label: 'Download' },
];

export default function Header() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const user = getCurrentUser();
  const displayName = getDisplayName();
  const isAdmin = isAdminSession();

  const isLanding = location.pathname === '/';

  async function handleLogout() {
    await logout();
    window.location.href = '/';
  }

  return (
    <header style={styles.header}>
      <div style={styles.inner}>
        <Link to="/" style={styles.logo}>
          <img src="/upnod_logo_dark.svg" alt="UpNod" style={{ height: 36, objectFit: 'contain' }} />
        </Link>

        <nav style={{ ...styles.nav, ...(menuOpen ? styles.navOpen : {}) }}>
          {isLanding && navLinks.map((link) => (
            <a key={link.to} href={link.to} style={styles.navLink}>{link.label}</a>
          ))}
          {!isLanding && (
            <>
              <Link to="/" style={styles.navLink}>Home</Link>
              <Link to="/pricing" style={styles.navLink}>Pricing</Link>
              <Link to="/download" style={styles.navLink}>Download</Link>
            </>
          )}

          <div style={styles.navRight}>
            {user ? (
              <>
                {isAdmin && <Link to="/admin" style={styles.navLink}>Dashboard</Link>}
                <span style={styles.userLabel}>{displayName || user.sub}</span>
                <button onClick={handleLogout} style={styles.navBtn}>Sign Out</button>
              </>
            ) : (
              <>
                <Link to="/login" style={styles.navBtnOutline}>Sign In</Link>
                <Link to="/register" style={styles.navBtn}>Get Started</Link>
              </>
            )}
          </div>
        </nav>

        <button style={styles.hamburger} onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle menu">
          <span style={{ ...styles.hamburgerLine, ...(menuOpen ? styles.hamburgerOpen1 : {}) }} />
          <span style={{ ...styles.hamburgerLine, ...(menuOpen ? styles.hamburgerOpen2 : {}) }} />
          <span style={{ ...styles.hamburgerLine, ...(menuOpen ? styles.hamburgerOpen3 : {}) }} />
        </button>
      </div>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  header: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 100,
    background: 'rgba(10, 14, 23, 0.8)',
    backdropFilter: 'blur(16px)',
    borderBottom: '1px solid rgba(99, 179, 237, 0.08)',
  },
  inner: {
    maxWidth: 1200,
    margin: '0 auto',
    padding: '0 24px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    height: 64,
  },
  logo: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    textDecoration: 'none',
    color: 'inherit',
    flexShrink: 0,
  },
  logoIcon: {
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    color: 'white',
    width: 36,
    height: 36,
    borderRadius: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontWeight: 800,
    fontSize: 14,
  },
  logoText: {
    fontWeight: 700,
    fontSize: 16,
    color: '#f1f5f9',
  },
  nav: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  navOpen: {} as React.CSSProperties,
  navLink: {
    color: '#94a3b8',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
    padding: '6px 12px',
    borderRadius: 8,
    transition: 'color 0.2s',
    whiteSpace: 'nowrap',
    cursor: 'pointer',
  },
  navRight: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    marginLeft: 16,
    paddingLeft: 16,
    borderLeft: '1px solid rgba(255,255,255,0.08)',
  },
  userLabel: {
    fontSize: 13,
    color: '#94a3b8',
    maxWidth: 120,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  navBtn: {
    padding: '8px 16px',
    background: '#3b82f6',
    color: 'white',
    border: 'none',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    display: 'inline-block',
  },
  navBtnOutline: {
    padding: '8px 16px',
    background: 'transparent',
    color: '#94a3b8',
    border: '1px solid rgba(255,255,255,0.12)',
    borderRadius: 8,
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    whiteSpace: 'nowrap',
    textDecoration: 'none',
    display: 'inline-block',
  },
  hamburger: {
    display: 'none',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 8,
    flexDirection: 'column',
    gap: 4,
  },
  hamburgerLine: {
    display: 'block',
    width: 22,
    height: 2,
    background: '#94a3b8',
    borderRadius: 1,
    transition: 'all 0.2s',
  },
  hamburgerOpen1: { transform: 'rotate(45deg) translate(4px, 4px)' },
  hamburgerOpen2: { opacity: 0 },
  hamburgerOpen3: { transform: 'rotate(-45deg) translate(4px, -4px)' },
};

if (typeof document !== 'undefined') {
  const style = document.createElement('style');
  style.textContent = `
    @media (max-width: 768px) {
      header nav { display: none !important; flex-direction: column; position: absolute; top: 64px; left: 0; right: 0; background: rgba(10,14,23,0.95); backdrop-filter: blur(16px); padding: 20px; border-bottom: 1px solid rgba(99,179,237,0.08); gap: 4px; }
      header nav > a, header nav > div { width: 100%; text-align: left; }
      header nav > div { border-left: none !important; margin-left: 0 !important; padding-left: 0 !important; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; margin-top: 8px; }
      button[aria-label="Toggle menu"] { display: flex !important; }
    }
  `;
  document.head.appendChild(style);
}
