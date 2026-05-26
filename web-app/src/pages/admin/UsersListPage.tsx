import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiRequest } from '../../api/client';

interface UserListItem {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  created_at: string;
  session_count: number;
  lifetime_flag: boolean;
}

interface UsersListResponse {
  items: UserListItem[];
  next_cursor: string | null;
}

interface Filters {
  email: string;
  role: string;
  entitlement_state: string;
  min_sessions: string;
  max_sessions: string;
}

export default function UsersListPage() {
  const navigate = useNavigate();
  const [users, setUsers] = useState<UserListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [filters, setFilters] = useState<Filters>({ email: '', role: '', entitlement_state: '', min_sessions: '', max_sessions: '' });
  const [appliedFilters, setAppliedFilters] = useState<Filters>({ email: '', role: '', entitlement_state: '', min_sessions: '', max_sessions: '' });

  const fetchUsers = useCallback(async (nextCursor?: string | null) => {
    setLoading(true);
    setError('');
    const params = new URLSearchParams();
    if (appliedFilters.email) params.set('email', appliedFilters.email);
    if (appliedFilters.role) params.set('role', appliedFilters.role);
    if (appliedFilters.entitlement_state) params.set('entitlement_state', appliedFilters.entitlement_state);
    if (appliedFilters.min_sessions) params.set('min_sessions', appliedFilters.min_sessions);
    if (appliedFilters.max_sessions) params.set('max_sessions', appliedFilters.max_sessions);
    if (nextCursor) params.set('cursor', nextCursor);
    const query = params.toString();
    try {
      const data = await apiRequest<UsersListResponse>(`/admin/users${query ? `?${query}` : ''}`);
      if (nextCursor) {
        setUsers((prev) => [...prev, ...data.items]);
      } else {
        setUsers(data.items);
      }
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters]);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  function handleFilterSubmit(e: FormEvent) {
    e.preventDefault();
    setAppliedFilters({ ...filters });
    setCursor(null);
  }

  function handleClearFilters() {
    const cleared: Filters = { email: '', role: '', entitlement_state: '', min_sessions: '', max_sessions: '' };
    setFilters(cleared);
    setAppliedFilters(cleared);
    setCursor(null);
  }

  function getEntitlementBadge(user: UserListItem) {
    if (user.lifetime_flag) return <span style={styles.badgeLifetime}>Lifetime</span>;
    if (user.session_count > 0) return <span style={styles.badgeSessions}>{user.session_count} session{user.session_count !== 1 ? 's' : ''}</span>;
    return <span style={styles.badgeNone}>No sessions</span>;
  }

  return (
    <div>
      <h1 style={styles.heading}>Users</h1>

      <form onSubmit={handleFilterSubmit} style={styles.filtersForm}>
        <div style={styles.filtersRow}>
          <div style={styles.filterField}>
            <label htmlFor="filter-email" style={styles.filterLabel}>Email</label>
            <input id="filter-email" type="text" placeholder="Search by email" value={filters.email}
              onChange={(e) => setFilters((f) => ({ ...f, email: e.target.value }))} style={styles.filterInput} />
          </div>
          <div style={styles.filterField}>
            <label htmlFor="filter-role" style={styles.filterLabel}>Role</label>
            <select id="filter-role" value={filters.role}
              onChange={(e) => setFilters((f) => ({ ...f, role: e.target.value }))} style={styles.filterInput}>
              <option value="">All</option>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <div style={styles.filterField}>
            <label htmlFor="filter-entitlement" style={styles.filterLabel}>Entitlement</label>
            <select id="filter-entitlement" value={filters.entitlement_state}
              onChange={(e) => setFilters((f) => ({ ...f, entitlement_state: e.target.value }))} style={styles.filterInput}>
              <option value="">All</option>
              <option value="none">No sessions</option>
              <option value="has_sessions">Has sessions</option>
              <option value="lifetime">Lifetime</option>
            </select>
          </div>
          <div style={styles.filterField}>
            <label htmlFor="filter-min-sessions" style={styles.filterLabel}>Min sessions</label>
            <input id="filter-min-sessions" type="number" min="0" placeholder="0" value={filters.min_sessions}
              onChange={(e) => setFilters((f) => ({ ...f, min_sessions: e.target.value }))} style={styles.filterInput} />
          </div>
          <div style={styles.filterField}>
            <label htmlFor="filter-max-sessions" style={styles.filterLabel}>Max sessions</label>
            <input id="filter-max-sessions" type="number" min="0" placeholder="∞" value={filters.max_sessions}
              onChange={(e) => setFilters((f) => ({ ...f, max_sessions: e.target.value }))} style={styles.filterInput} />
          </div>
        </div>
        <div style={styles.filterActions}>
          <button type="submit" style={styles.btnPrimary}>Apply Filters</button>
          <button type="button" onClick={handleClearFilters} style={styles.btnSecondary}>Clear</button>
        </div>
      </form>

      {error && <div role="alert" style={styles.errorBox}>{error}</div>}

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Email</th>
              <th style={styles.th}>Role</th>
              <th style={styles.th}>Verified</th>
              <th style={styles.th}>Entitlement</th>
              <th style={styles.th}>Created</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id} style={styles.tr}
                onClick={() => navigate(`/admin/users/${user.id}`)}
                role="button" tabIndex={0}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate(`/admin/users/${user.id}`); }}>
                <td style={styles.td}>{user.email}</td>
                <td style={styles.td}>
                  <span style={user.role === 'admin' ? styles.roleAdmin : styles.roleUser}>{user.role}</span>
                </td>
                <td style={styles.td}>{user.email_verified ? '✓' : '✗'}</td>
                <td style={styles.td}>{getEntitlementBadge(user)}</td>
                <td style={styles.td}>{new Date(user.created_at).toLocaleDateString()}</td>
              </tr>
            ))}
            {users.length === 0 && !loading && (
              <tr><td colSpan={5} style={{ ...styles.td, textAlign: 'center' }}>No users found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {hasMore && (
        <div style={styles.paginationRow}>
          <button onClick={() => fetchUsers(cursor)} disabled={loading} style={styles.btnPrimary}>
            {loading ? 'Loading…' : 'Load More'}
          </button>
        </div>
      )}
      {loading && users.length === 0 && <p style={styles.loadingText}>Loading users…</p>}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  heading: { fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9', marginBottom: '1rem' },
  filtersForm: { marginBottom: '1.5rem', padding: '1rem', background: 'rgba(255,255,255,0.025)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' },
  filtersRow: { display: 'flex', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' },
  filterField: { display: 'flex', flexDirection: 'column', gap: '0.25rem', minWidth: 140, flex: 1 },
  filterLabel: { fontSize: '0.75rem', fontWeight: 500, color: '#64748b', textTransform: 'uppercase', letterSpacing: '0.05em' },
  filterInput: { padding: '0.4rem 0.6rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: '0.875rem', color: '#f1f5f9' },
  filterActions: { display: 'flex', gap: '0.5rem' },
  btnPrimary: { padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  btnSecondary: { padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  errorBox: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  tableWrapper: { overflowX: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th: { textAlign: 'left', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 600, color: '#94a3b8', fontSize: '0.75rem', textTransform: 'uppercase', letterSpacing: '0.05em' },
  tr: { cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.04)' },
  td: { padding: '0.75rem 1rem', color: '#e2e8f0' },
  badgeLifetime: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  badgeSessions: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(34,197,94,0.12)', color: '#4ade80', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  badgeNone: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(255,255,255,0.05)', color: '#64748b', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  roleAdmin: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(245,158,11,0.15)', color: '#fbbf24', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  roleUser: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  paginationRow: { marginTop: '1rem', display: 'flex', justifyContent: 'center' },
  loadingText: { textAlign: 'center', color: '#64748b', marginTop: '2rem' },
};
