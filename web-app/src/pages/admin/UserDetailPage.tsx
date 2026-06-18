import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiRequest, ApiClientError } from '../../api/client';

interface UserInfo { id: string; email: string; role: string; email_verified: boolean; created_at: string; }
interface Entitlement { session_count: number; lifetime_flag: boolean; }
interface Purchase { id: string; pack_slug: string; effective_price_paise: number; mrp_at_purchase_paise: number; status: string; razorpay_order_id: string; razorpay_payment_id: string | null; welcome_offer_applied: boolean; created_at: string; completed_at: string | null; }
interface Session { id: string; status: string; started_at: string; expires_at: string; ended_at: string | null; ended_reason: string | null; }
interface LedgerEntry { id: string; ts: string; session_delta: number; lifetime_flag_set: string; reason: string; razorpay_payment_id: string | null; interview_session_id: string | null; acting_admin_id: string | null; resulting_session_count: number; resulting_lifetime_flag: boolean; note: string | null; }
interface UserDetailResponse { user: UserInfo; entitlement: Entitlement; purchases: Purchase[]; sessions: Session[]; ledger: LedgerEntry[]; }

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showLifetimeModal, setShowLifetimeModal] = useState(false);
  const [activeTab, setActiveTab] = useState<'purchases' | 'sessions' | 'ledger'>('ledger');

  const fetchUser = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      setData(await apiRequest<UserDetailResponse>(`/admin/users/${id}`));
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) setError('User not found.');
      else setError(err instanceof Error ? err.message : 'Failed to load user');
    } finally { setLoading(false); }
  }, [id]);

  useEffect(() => { fetchUser(); }, [fetchUser]);

  if (loading) return <div style={s.container}><p style={{ color: '#94a3b8' }}>Loading user details…</p></div>;
  if (error || !data) {
    return (
      <div style={s.container}>
        <button onClick={() => navigate('/admin/users')} style={s.backBtn}>← Back to Users</button>
        <div role="alert" style={s.errorBox}>{error}</div>
      </div>
    );
  }

  const { user, entitlement, purchases, sessions, ledger } = data;

  return (
    <div style={s.container}>
      <button onClick={() => navigate('/admin/users')} style={s.backBtn}>← Back to Users</button>

      <div style={s.headerCard}>
        <div style={s.headerTop}>
          <div>
            <h1 style={s.heading}>{user.email}</h1>
            <p style={s.subtext}>
              {user.role === 'admin' ? 'Admin' : 'User'}
              {' · '}{user.email_verified ? 'Verified' : 'Unverified'}
              {' · Joined '}{new Date(user.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>
        <div style={s.entitlementCard}>
          <h3 style={s.sectionTitle}>Current Entitlement</h3>
          <div style={s.entitlementRow}>
            {entitlement.lifetime_flag
              ? <span style={s.badgeLifetime}>Lifetime Access</span>
              : <span style={s.badgeSessions}>{entitlement.session_count} session{entitlement.session_count !== 1 ? 's' : ''} remaining</span>}
            <div style={s.entitlementActions}>
              <button onClick={() => setShowAdjustModal(true)} style={s.btnPrimary}>Grant / Revoke Sessions</button>
              <button onClick={() => setShowLifetimeModal(true)} style={s.btnSecondary}>Grant Lifetime</button>
            </div>
          </div>
        </div>
      </div>

      <div style={s.tabRow}>
        {(['ledger', 'sessions', 'purchases'] as const).map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)}
            style={activeTab === tab ? s.tabActive : s.tab}>
            {tab.charAt(0).toUpperCase() + tab.slice(1)} ({data[tab].length})
          </button>
        ))}
      </div>

      {activeTab === 'ledger' && <LedgerTable entries={ledger} />}
      {activeTab === 'sessions' && <SessionsTable sessions={sessions} />}
      {activeTab === 'purchases' && <PurchasesTable purchases={purchases} />}

      {showAdjustModal && <AdjustSessionsModal userId={user.id} onClose={() => setShowAdjustModal(false)} onSuccess={fetchUser} />}
      {showLifetimeModal && <LifetimeModal userId={user.id} onClose={() => setShowLifetimeModal(false)} onSuccess={fetchUser} />}
    </div>
  );
}

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) return <p style={s.emptyText}>No ledger entries.</p>;
  return (
    <div style={s.tableWrapper}>
      <table style={s.table}>
        <thead><tr><th style={s.th}>Timestamp</th><th style={s.th}>Reason</th><th style={s.th}>Delta</th><th style={s.th}>Lifetime</th><th style={s.th}>Resulting</th><th style={s.th}>Note</th></tr></thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} style={s.trHover}>
              <td style={s.td}>{new Date(entry.ts).toLocaleString()}</td>
              <td style={s.td}><span style={s.reasonBadge}>{entry.reason}</span></td>
              <td style={s.td}><span style={{ color: entry.session_delta > 0 ? '#4ade80' : entry.session_delta < 0 ? '#f87171' : '#64748b', fontWeight: 600 }}>{entry.session_delta > 0 ? '+' : ''}{entry.session_delta}</span></td>
              <td style={s.td}>{entry.lifetime_flag_set === 'set_true' ? 'Set' : '—'}</td>
              <td style={s.td}>{entry.resulting_lifetime_flag ? '♾️' : entry.resulting_session_count}</td>
              <td style={s.td}>{entry.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) return <p style={s.emptyText}>No sessions.</p>;
  return (
    <div style={s.tableWrapper}>
      <table style={s.table}>
        <thead><tr><th style={s.th}>Started</th><th style={s.th}>Status</th><th style={s.th}>Expires</th><th style={s.th}>Ended</th><th style={s.th}>Reason</th></tr></thead>
        <tbody>
          {sessions.map((ses) => (
            <tr key={ses.id} style={s.trHover}>
              <td style={s.td}>{new Date(ses.started_at).toLocaleString()}</td>
              <td style={s.td}><span style={ses.status === 'active' ? s.statusActive : ses.status === 'ended' ? s.statusEnded : s.statusExpired}>{ses.status}</span></td>
              <td style={s.td}>{new Date(ses.expires_at).toLocaleString()}</td>
              <td style={s.td}>{ses.ended_at ? new Date(ses.ended_at).toLocaleString() : '—'}</td>
              <td style={s.td}>{ses.ended_reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PurchasesTable({ purchases }: { purchases: Purchase[] }) {
  if (purchases.length === 0) return <p style={s.emptyText}>No purchases.</p>;
  return (
    <div style={s.tableWrapper}>
      <table style={s.table}>
        <thead><tr><th style={s.th}>Date</th><th style={s.th}>Pack</th><th style={s.th}>Price</th><th style={s.th}>MRP</th><th style={s.th}>Status</th><th style={s.th}>Welcome Offer</th></tr></thead>
        <tbody>
          {purchases.map((p) => (
            <tr key={p.id} style={s.trHover}>
              <td style={s.td}>{new Date(p.created_at).toLocaleString()}</td>
              <td style={s.td}>{p.pack_slug}</td>
              <td style={s.td}>₹{(p.effective_price_paise / 100).toFixed(2)}</td>
              <td style={s.td}>₹{(p.mrp_at_purchase_paise / 100).toFixed(2)}</td>
              <td style={s.td}><span style={p.status === 'completed' ? s.statusActive : p.status === 'pending' ? s.statusPending : s.statusExpired}>{p.status}</span></td>
              <td style={s.td}>{p.welcome_offer_applied ? '✓' : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustSessionsModal({ userId, onClose, onSuccess }: { userId: string; onClose: () => void; onSuccess: () => void }) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError('');
    const deltaNum = parseInt(delta, 10);
    if (isNaN(deltaNum) || deltaNum === 0 || deltaNum < -1000 || deltaNum > 1000) { setError('Session delta must be an integer between -1000 and 1000, excluding 0.'); return; }
    if (!note.trim() || note.trim().length > 500) { setError('Note is required (1–500 characters).'); return; }
    setSubmitting(true);
    try {
      await apiRequest(`/admin/users/${userId}/entitlement-adjust`, { method: 'POST', body: { session_delta: deltaNum, note: note.trim() } });
      onSuccess(); onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to adjust entitlement.');
    } finally { setSubmitting(false); }
  }

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalContent} onClick={(e) => e.stopPropagation()}>
        <h2 style={s.modalTitle}>Grant / Revoke Sessions</h2>
        <form onSubmit={handleSubmit}>
          {error && <div role="alert" style={s.errorBox}>{error}</div>}
          <div style={s.formField}>
            <label htmlFor="adjust-delta" style={s.formLabel}>Session Delta</label>
            <input id="adjust-delta" type="number" min="-1000" max="1000" value={delta}
              onChange={(e) => setDelta(e.target.value)} placeholder="e.g. 5 to grant, -3 to revoke" required style={s.formInput} />
            <p style={s.helpText}>Positive to grant, negative to revoke. Range: -1000 to 1000.</p>
          </div>
          <div style={s.formField}>
            <label htmlFor="adjust-note" style={s.formLabel}>Reason Note</label>
            <textarea id="adjust-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for this adjustment (required)" required maxLength={500} rows={3} style={s.formTextarea} />
            <p style={s.helpText}>{note.length}/500 characters</p>
          </div>
          <div style={s.modalActions}>
            <button type="button" onClick={onClose} style={s.btnSecondary} disabled={submitting}>Cancel</button>
            <button type="submit" style={s.btnPrimary} disabled={submitting}>{submitting ? 'Applying…' : 'Apply Adjustment'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LifetimeModal({ userId, onClose, onSuccess }: { userId: string; onClose: () => void; onSuccess: () => void }) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (!confirmed) { setError('Please confirm you want to grant lifetime access.'); return; }
    if (!note.trim() || note.trim().length > 500) { setError('Note is required (1–500 characters).'); return; }
    setSubmitting(true);
    try {
      await apiRequest(`/admin/users/${userId}/entitlement-adjust`, { method: 'POST', body: { session_delta: 1, note: `[LIFETIME GRANT] ${note.trim()}` } });
      onSuccess(); onClose();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to grant lifetime access.');
    } finally { setSubmitting(false); }
  }

  return (
    <div style={s.modalOverlay} onClick={onClose}>
      <div style={s.modalContent} onClick={(e) => e.stopPropagation()}>
        <h2 style={s.modalTitle}>Grant Lifetime Access</h2>
        <form onSubmit={handleSubmit}>
          {error && <div role="alert" style={s.errorBox}>{error}</div>}
          <p style={s.warningText}>This will grant the user unlimited interview sessions for the lifetime of their account. This action cannot be easily undone.</p>
          <div style={s.formField}>
            <label htmlFor="lifetime-note" style={s.formLabel}>Reason Note</label>
            <textarea id="lifetime-note" value={note} onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for granting lifetime access (required)" required maxLength={500} rows={3} style={s.formTextarea} />
            <p style={s.helpText}>{note.length}/500 characters</p>
          </div>
          <div style={s.formField}>
            <label style={s.checkboxLabel}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
              {' '}I confirm I want to grant lifetime access to this user
            </label>
          </div>
          <div style={s.modalActions}>
            <button type="button" onClick={onClose} style={s.btnSecondary} disabled={submitting}>Cancel</button>
            <button type="submit" style={s.btnDanger} disabled={submitting || !confirmed}>{submitting ? 'Granting…' : 'Grant Lifetime Access'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  container: { padding: 0, maxWidth: 1200, margin: '0 auto' },
  backBtn: { background: 'none', border: 'none', color: '#60a5fa', cursor: 'pointer', fontSize: '0.875rem', padding: '0.25rem 0', marginBottom: '1rem' },
  heading: { fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9', margin: 0 },
  subtext: { fontSize: '0.875rem', color: '#64748b', margin: '0.25rem 0 0' },
  headerCard: { marginBottom: '1.5rem' },
  headerTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' },
  entitlementCard: { padding: '1rem', background: 'rgba(255,255,255,0.025)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' },
  sectionTitle: { fontSize: '0.875rem', fontWeight: 600, color: '#94a3b8', margin: '0 0 0.5rem' },
  entitlementRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '0.75rem' },
  entitlementActions: { display: 'flex', gap: '0.5rem' },
  badgeLifetime: { display: 'inline-block', padding: '0.25rem 0.75rem', background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderRadius: 9999, fontSize: '0.875rem', fontWeight: 600 },
  badgeSessions: { display: 'inline-block', padding: '0.25rem 0.75rem', background: 'rgba(34,197,94,0.12)', color: '#4ade80', borderRadius: 9999, fontSize: '0.875rem', fontWeight: 600 },
  tabRow: { display: 'flex', gap: 0, borderBottom: '2px solid rgba(255,255,255,0.06)', marginBottom: '1rem' },
  tab: { padding: '0.5rem 1rem', background: 'none', border: 'none', borderBottom: '2px solid transparent', marginBottom: -2, cursor: 'pointer', fontSize: '0.875rem', color: '#64748b', fontWeight: 500 },
  tabActive: { padding: '0.5rem 1rem', background: 'none', border: 'none', borderBottom: '2px solid #3b82f6', marginBottom: -2, cursor: 'pointer', fontSize: '0.875rem', color: '#60a5fa', fontWeight: 600 },
  tableWrapper: { overflowX: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.8125rem' },
  th: { textAlign: 'left', padding: '0.625rem 0.75rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 600, color: '#94a3b8', fontSize: '0.6875rem', textTransform: 'uppercase', letterSpacing: '0.05em' },
  trHover: { borderBottom: '1px solid rgba(255,255,255,0.04)' },
  td: { padding: '0.625rem 0.75rem', color: '#e2e8f0' },
  reasonBadge: { display: 'inline-block', padding: '0.125rem 0.375rem', background: 'rgba(255,255,255,0.05)', borderRadius: 4, fontSize: '0.6875rem', fontFamily: 'monospace', color: '#cbd5e1' },
  statusActive: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(34,197,94,0.12)', color: '#4ade80', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  statusEnded: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  statusExpired: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(239,68,68,0.1)', color: '#fca5a5', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  statusPending: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(245,158,11,0.12)', color: '#fbbf24', borderRadius: 9999, fontSize: '0.75rem', fontWeight: 500 },
  emptyText: { textAlign: 'center', color: '#64748b', padding: '2rem' },
  errorBox: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  modalOverlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' },
  modalContent: { background: '#111827', borderRadius: 12, padding: '1.5rem', width: '100%', maxWidth: 480, border: '1px solid rgba(255,255,255,0.08)' },
  modalTitle: { fontSize: '1.25rem', fontWeight: 600, color: '#f1f5f9', margin: '0 0 1rem' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', marginTop: '1.25rem' },
  formField: { marginBottom: '1rem' },
  formLabel: { display: 'block', fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8', marginBottom: '0.25rem' },
  formInput: { width: '100%', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '1rem', color: '#f1f5f9', boxSizing: 'border-box' },
  formTextarea: { width: '100%', padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', color: '#f1f5f9', resize: 'vertical', boxSizing: 'border-box' },
  helpText: { fontSize: '0.75rem', color: '#64748b', margin: '0.25rem 0 0' },
  warningText: { padding: '0.75rem', background: 'rgba(245,158,11,0.1)', border: '1px solid rgba(245,158,11,0.25)', borderRadius: 6, color: '#fbbf24', fontSize: '0.875rem', marginBottom: '1rem' },
  checkboxLabel: { fontSize: '0.875rem', color: '#e2e8f0', cursor: 'pointer' },
  btnPrimary: { padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  btnSecondary: { padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  btnDanger: { padding: '0.5rem 1rem', background: '#dc2626', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
};
