import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { logout, getCurrentUser } from '../../api/client';

const NAV_ITEMS = [
  { to: '/admin/users',            label: '👥 Users' },
  { to: '/admin/usage-analytics',  label: '📊 Usage Analytics' },
  { to: '/admin/provider-keys',    label: '🔑 Provider Keys' },
  { to: '/admin/model-routing',    label: '🤖 Model Routing' },
  { to: '/admin/packs',            label: '📦 Packs' },
  { to: '/admin/welcome-offer',    label: '🎁 Welcome Offer' },
  { to: '/admin/rate-limits',      label: '⚡ Rate Limits' },
  { to: '/admin/audit-log',        label: '📋 Audit Log' },
];

export default function AdminLayout() {
  const navigate = useNavigate();
  const user = getCurrentUser();

  async function handleLogout() {
    await logout();
    navigate('/login', { replace: true });
  }

  return (
    <div style={styles.wrapper}>
      <aside style={styles.sidebar}>
        <div style={styles.sidebarHeader}>
          <NavLink to="/" style={styles.logo}>IA Admin</NavLink>
        </div>
        <nav style={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/admin'}
              style={({ isActive }) => ({
                ...styles.navLink,
                ...(isActive ? styles.navLinkActive : {}),
              })}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div style={styles.sidebarFooter}>
          {user && <span style={styles.userEmail}>{user.sub}</span>}
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign Out</button>
        </div>
      </aside>
      <main style={styles.content}>
        <Outlet />
      </main>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrapper: {
    display: 'flex',
    minHeight: '100vh',
    background: '#0a0e17',
  },
  sidebar: {
    width: 240,
    background: 'rgba(255,255,255,0.02)',
    borderRight: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    flexDirection: 'column',
    position: 'sticky',
    top: 0,
    height: '100vh',
  },
  sidebarHeader: {
    padding: '20px 20px 12px',
    borderBottom: '1px solid rgba(255,255,255,0.06)',
  },
  logo: {
    fontSize: 16,
    fontWeight: 700,
    color: '#f1f5f9',
    textDecoration: 'none',
    letterSpacing: '-0.02em',
  },
  nav: {
    flex: 1,
    padding: '12px 8px',
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  navLink: {
    display: 'block',
    padding: '8px 12px',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    color: '#94a3b8',
    textDecoration: 'none',
    transition: 'background 0.15s, color 0.15s',
  },
  navLinkActive: {
    background: 'rgba(59,130,246,0.12)',
    color: '#60a5fa',
  },
  sidebarFooter: {
    padding: '16px 20px',
    borderTop: '1px solid rgba(255,255,255,0.06)',
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  userEmail: {
    fontSize: 12,
    color: '#64748b',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  logoutBtn: {
    background: 'rgba(255,255,255,0.05)',
    border: '1px solid rgba(255,255,255,0.08)',
    borderRadius: 6,
    color: '#94a3b8',
    fontSize: 13,
    padding: '6px 12px',
    cursor: 'pointer',
    fontWeight: 500,
  },
  content: {
    flex: 1,
    padding: '32px',
    minWidth: 0,
  },
};
