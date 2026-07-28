import { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  isAdminSession,
  getCurrentUser,
  getDisplayName,
  getWallet,
  logout,
  type WalletInfo,
} from '../api/client';

/** Build up-to-two-letter initials from a display name or email. */
function getInitials(nameOrEmail: string): string {
  if (!nameOrEmail) return 'U';
  const base = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0]! : nameOrEmail;
  const parts = base.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

const navLinks = [
  { to: '/#features', label: 'Features' },
  { to: '/#how-it-works', label: 'How It Works' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/download', label: 'Download' },
];

export default function Header() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const acctRef = useRef<HTMLDivElement>(null);
  const user = getCurrentUser();
  const displayName = getDisplayName();
  const isAdmin = isAdminSession();

  const isLanding = location.pathname === '/';

  // Load the wallet balance for the account menu (only when signed in).
  useEffect(() => {
    if (!user) return;
    let active = true;
    getWallet().then((w) => { if (active) setWallet(w); });
    return () => { active = false; };
  }, [user?.sub]);

  // Close the account dropdown on outside click.
  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (acctRef.current && !acctRef.current.contains(e.target as Node)) setAcctOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  // Close menus on navigation.
  useEffect(() => {
    setAcctOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  async function handleLogout() {
    await logout();
    window.location.href = '/';
  }

  const accountLabel = displayName || user?.sub || '';
  const initials = getInitials(accountLabel);
  const balanceLabel =
    wallet != null
      ? '₹' + (wallet.balance_paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })
      : null;

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
              <div ref={acctRef} className="hdr-account" style={styles.account}>
                <Link to="/wallet" className="hdr-wallet-pill" style={styles.walletPill} title="Your wallet balance">
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
                    <path d="M16 12h.01" />
                  </svg>
                  <span>{balanceLabel ?? 'Wallet'}</span>
                </Link>

                <button
                  onClick={() => setAcctOpen((o) => !o)}
                  className="hdr-avatar-btn"
                  style={styles.avatarBtn}
                  aria-haspopup="menu"
                  aria-expanded={acctOpen}
                  aria-label="Account menu"
                >
                  <span style={styles.avatar}>{initials}</span>
                  <svg style={{ transform: acctOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </button>

                {acctOpen && (
                  <div className="hdr-acct-dropdown" style={styles.dropdown} role="menu">
                    <div style={styles.dropdownHeader}>
                      <div style={styles.avatarLg}>{initials}</div>
                      <div style={{ minWidth: 0 }}>
                        <div style={styles.ddName}>{displayName || 'Account'}</div>
                        <div style={styles.ddSub} title={user.sub}>{user.sub}</div>
                      </div>
                    </div>
                    <div style={styles.ddDivider} />
                    <Link to="/wallet" className="hdr-dd-item" style={styles.ddItem} role="menuitem">
                      <span>My Wallet</span>
                      {balanceLabel && <span style={styles.ddItemValue}>{balanceLabel}</span>}
                    </Link>
                    {isAdmin && (
                      <Link to="/admin" className="hdr-dd-item" style={styles.ddItem} role="menuitem">
                        <span>Admin Dashboard</span>
                      </Link>
                    )}
                    <div style={styles.ddDivider} />
                    <button onClick={handleLogout} className="hdr-dd-signout" style={styles.ddSignOut} role="menuitem">
                      Sign out
                    </button>
                  </div>
                )}
              </div>
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
  account: {
    position: 'relative',
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  walletPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '6px 12px',
    background: 'rgba(34,197,94,0.1)',
    border: '1px solid rgba(34,197,94,0.25)',
    color: '#86efac',
    borderRadius: 100,
    fontSize: 13,
    fontWeight: 700,
    textDecoration: 'none',
    whiteSpace: 'nowrap',
    transition: 'background 0.2s',
  },
  avatarBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    padding: 3,
    borderRadius: 100,
    transition: 'background 0.2s',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 13,
    fontWeight: 700,
    letterSpacing: '0.02em',
  },
  dropdown: {
    position: 'absolute',
    top: 'calc(100% + 10px)',
    right: 0,
    minWidth: 240,
    background: 'rgba(17, 23, 36, 0.98)',
    backdropFilter: 'blur(16px)',
    border: '1px solid rgba(255,255,255,0.1)',
    borderRadius: 14,
    padding: 8,
    boxShadow: '0 16px 40px rgba(0,0,0,0.5)',
    zIndex: 200,
  },
  dropdownHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '10px 12px',
  },
  avatarLg: {
    width: 40,
    height: 40,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3b82f6, #8b5cf6)',
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 15,
    fontWeight: 700,
    flexShrink: 0,
  },
  ddName: {
    fontSize: 14,
    fontWeight: 700,
    color: '#f1f5f9',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  ddSub: {
    fontSize: 12,
    color: '#64748b',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: 170,
  },
  ddDivider: {
    height: 1,
    background: 'rgba(255,255,255,0.08)',
    margin: '6px 0',
  },
  ddItem: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    padding: '10px 12px',
    borderRadius: 8,
    color: '#cbd5e1',
    textDecoration: 'none',
    fontSize: 14,
    fontWeight: 500,
    cursor: 'pointer',
  },
  ddItemValue: {
    fontSize: 13,
    fontWeight: 700,
    color: '#86efac',
  },
  ddSignOut: {
    width: '100%',
    textAlign: 'left',
    padding: '10px 12px',
    borderRadius: 8,
    background: 'transparent',
    border: 'none',
    color: '#f87171',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
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
    .hdr-wallet-pill:hover { background: rgba(34,197,94,0.18) !important; }
    .hdr-avatar-btn:hover { background: rgba(255,255,255,0.06) !important; }
    .hdr-dd-item:hover { background: rgba(255,255,255,0.06); }
    .hdr-dd-signout:hover { background: rgba(248,113,113,0.12); }
    @media (max-width: 768px) {
      header nav { display: none !important; flex-direction: column; position: absolute; top: 64px; left: 0; right: 0; background: rgba(10,14,23,0.95); backdrop-filter: blur(16px); padding: 20px; border-bottom: 1px solid rgba(99,179,237,0.08); gap: 4px; }
      header nav > a, header nav > div { width: 100%; text-align: left; }
      header nav > div { border-left: none !important; margin-left: 0 !important; padding-left: 0 !important; border-top: 1px solid rgba(255,255,255,0.08); padding-top: 12px; margin-top: 8px; }
      button[aria-label="Toggle menu"] { display: flex !important; }
      .hdr-account { flex-direction: column; align-items: stretch !important; width: 100%; gap: 12px !important; }
      .hdr-acct-dropdown { position: static !important; min-width: 0 !important; box-shadow: none !important; border: none !important; background: transparent !important; backdrop-filter: none !important; padding: 0 !important; }
      button[aria-label="Account menu"] { align-self: flex-start; }
    }
  `;
  document.head.appendChild(style);
}
