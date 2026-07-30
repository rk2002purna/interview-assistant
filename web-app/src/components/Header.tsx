import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import {
  getCurrentUser,
  getDisplayName,
  getWallet,
  isAdminSession,
  logout,
  type WalletInfo,
} from '../api/client';
import ThemeToggle from './ThemeToggle';

function getInitials(nameOrEmail: string): string {
  if (!nameOrEmail) return 'U';
  const base = nameOrEmail.includes('@') ? nameOrEmail.split('@')[0]! : nameOrEmail;
  const parts = base.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return base.slice(0, 2).toUpperCase();
}

const navLinks = [
  { to: '/#features', label: 'Features' },
  { to: '/#how-it-works', label: 'How it works' },
  { to: '/pricing', label: 'Pricing' },
  { to: '/download', label: 'Download' },
];

export default function Header() {
  const location = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [wallet, setWallet] = useState<WalletInfo | null>(null);
  const accountRef = useRef<HTMLDivElement>(null);
  const user = getCurrentUser();
  const displayName = getDisplayName();
  const isAdmin = isAdminSession();
  const isLanding = location.pathname === '/';

  useEffect(() => {
    if (!user) return;
    let active = true;
    getWallet()
      .then((nextWallet) => {
        if (active) setWallet(nextWallet);
      })
      .catch(() => {
        if (active) setWallet(null);
      });
    return () => {
      active = false;
    };
  }, [user?.sub]);

  useEffect(() => {
    const handleOutsideClick = (event: MouseEvent) => {
      if (accountRef.current && !accountRef.current.contains(event.target as Node)) {
        setAccountOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  useEffect(() => {
    setAccountOpen(false);
    setMenuOpen(false);
  }, [location.pathname]);

  async function handleLogout() {
    await logout();
    window.location.href = '/';
  }

  const closeMenu = () => setMenuOpen(false);
  const accountLabel = displayName || user?.sub || '';
  const initials = getInitials(accountLabel);
  const balanceLabel = wallet
    ? `₹${(wallet.balance_paise / 100).toLocaleString('en-IN', {
        minimumFractionDigits: 0,
        maximumFractionDigits: 2,
      })}`
    : null;

  return (
    <header className="site-header">
      <div className="site-header-shell">
        <Link to="/" className="site-logo" aria-label="Cueviq home" onClick={closeMenu}>
          <img className="theme-logo theme-logo-dark" src="/cueviq_logo_dark.svg" alt="Cueviq" />
          <img className="theme-logo theme-logo-light" src="/cueviq_logo_light.svg" alt="Cueviq" />
        </Link>

        <nav
          id="primary-navigation"
          className={`site-nav${menuOpen ? ' is-open' : ''}`}
          aria-label="Primary navigation"
        >
          <div className="site-nav-links">
            {isLanding ? (
              navLinks.map((link) => (
                <a key={link.to} href={link.to.replace('/#', '#')} onClick={closeMenu}>{link.label}</a>
              ))
            ) : (
              <>
                <Link to="/" onClick={closeMenu}>Home</Link>
                <Link to="/pricing" onClick={closeMenu}>Pricing</Link>
                <Link to="/download" onClick={closeMenu}>Download</Link>
              </>
            )}
          </div>

          <div className="site-nav-actions">
            {user ? (
              <div ref={accountRef} className="site-account">
                <Link to="/wallet" className="wallet-pill" title="Your wallet balance" onClick={closeMenu}>
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5" />
                    <path d="M16 12h.01" />
                  </svg>
                  <span>{balanceLabel ?? 'Wallet'}</span>
                </Link>

                <button
                  onClick={() => setAccountOpen((open) => !open)}
                  className="account-trigger"
                  aria-haspopup="menu"
                  aria-expanded={accountOpen}
                  aria-label="Account menu"
                >
                  <span className="account-avatar">{initials}</span>
                  <svg className={accountOpen ? 'is-rotated' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>

                {accountOpen && (
                  <div className="account-dropdown" role="menu">
                    <div className="account-dropdown-head">
                      <div className="account-avatar account-avatar-large">{initials}</div>
                      <div>
                        <strong>{displayName || 'Account'}</strong>
                        <span title={user.sub}>{user.sub}</span>
                      </div>
                    </div>
                    <div className="account-divider" />
                    <Link to="/wallet" role="menuitem" className="account-menu-item">
                      <span>My wallet</span>
                      {balanceLabel && <strong>{balanceLabel}</strong>}
                    </Link>
                    {isAdmin && (
                      <Link to="/admin" role="menuitem" className="account-menu-item">Admin dashboard</Link>
                    )}
                    <div className="account-divider" />
                    <button onClick={handleLogout} className="account-signout" role="menuitem">Sign out</button>
                  </div>
                )}
              </div>
            ) : (
              <>
                <Link to="/login" className="header-signin" onClick={closeMenu}>Sign in</Link>
                <Link to="/register" className="header-cta" onClick={closeMenu}>Get started <span aria-hidden="true">→</span></Link>
              </>
            )}
          </div>
        </nav>

        <div className="header-controls">
          <ThemeToggle />
          <button
            className={`menu-toggle${menuOpen ? ' is-open' : ''}`}
            onClick={() => setMenuOpen((open) => !open)}
            aria-label="Toggle navigation"
            aria-controls="primary-navigation"
            aria-expanded={menuOpen}
          >
            <span /><span /><span />
          </button>
        </div>
      </div>
    </header>
  );
}
