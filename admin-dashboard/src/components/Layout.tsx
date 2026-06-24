import { NavLink, useNavigate } from 'react-router-dom';
import { logout } from '../api/client';

const NAV_ITEMS = [
  { to: '/users',            label: '👥 Users' },
  { to: '/provider-keys',   label: '🔑 Provider Keys' },
  { to: '/model-routing',   label: '🤖 Model Routing' },
  { to: '/usage-analytics', label: '📊 Usage Analytics' },
  { to: '/packs',           label: '📦 Packs' },
  { to: '/welcome-offer',   label: '🎁 Welcome Offer' },
  { to: '/rate-limits',     label: '⚡ Rate Limits' },
  { to: '/audit-log',       label: '📋 Audit Log' },
];

export default function Layout({ children }: { children: React.ReactNode }) {
  const navigate = useNavigate();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div style={styles.shell}>
      {/* Sidebar */}
      <nav style={styles.sidebar}>
        <div style={styles.brand}>UpNod<span style={styles.brandSub}>Admin</span></div>
        <ul style={styles.navList}>
          {NAV_ITEMS.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                style={({ isActive }) => ({
                  ...styles.navLink,
                  ...(isActive ? styles.navLinkActive : {}),
                })}
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
        <button style={styles.logoutBtn} onClick={handleLogout}>
          🚪 Sign Out
        </button>
      </nav>

      {/* Main content */}
      <main style={styles.main}>{children}</main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  shell: {
    display: 'flex',
    minHeight: '100vh',
    backgroundColor: '#f9fafb',
  },
  sidebar: {
    width: 220,
    flexShrink: 0,
    backgroundColor: '#1e293b',
    display: 'flex',
    flexDirection: 'column',
    padding: '1.25rem 0',
    position: 'sticky' as const,
    top: 0,
    height: '100vh',
    overflowY: 'auto',
  },
  brand: {
    fontSize: '1.125rem',
    fontWeight: 700,
    color: '#f1f5f9',
    padding: '0 1.25rem 1.25rem',
    borderBottom: '1px solid rgba(255,255,255,0.08)',
    marginBottom: '0.75rem',
    letterSpacing: '-0.01em',
  },
  brandSub: {
    fontSize: '0.7rem',
    fontWeight: 400,
    color: '#94a3b8',
    marginLeft: 4,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  navList: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    flex: 1,
  },
  navLink: {
    display: 'block',
    padding: '0.6rem 1.25rem',
    fontSize: '0.875rem',
    color: '#94a3b8',
    textDecoration: 'none',
    borderLeft: '3px solid transparent',
    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
  },
  navLinkActive: {
    color: '#f1f5f9',
    borderLeftColor: '#3b82f6',
    backgroundColor: 'rgba(255,255,255,0.06)',
  },
  logoutBtn: {
    margin: '0.75rem 1.25rem 0',
    padding: '0.5rem 0.75rem',
    background: 'rgba(239,68,68,0.12)',
    border: '1px solid rgba(239,68,68,0.25)',
    borderRadius: 6,
    color: '#fca5a5',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    textAlign: 'left' as const,
  },
  main: {
    flex: 1,
    overflowY: 'auto',
    minWidth: 0,
  },
};
