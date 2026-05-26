import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { apiRequest, ApiClientError } from '../api/client';

interface UserInfo {
  id: string;
  email: string;
  role: string;
  email_verified: boolean;
  created_at: string;
}

interface Entitlement {
  session_count: number;
  lifetime_flag: boolean;
}

interface Purchase {
  id: string;
  pack_slug: string;
  effective_price_paise: number;
  mrp_at_purchase_paise: number;
  status: string;
  razorpay_order_id: string;
  razorpay_payment_id: string | null;
  welcome_offer_applied: boolean;
  created_at: string;
  completed_at: string | null;
}

interface Session {
  id: string;
  status: string;
  started_at: string;
  expires_at: string;
  ended_at: string | null;
  ended_reason: string | null;
}

interface LedgerEntry {
  id: string;
  ts: string;
  session_delta: number;
  lifetime_flag_set: string;
  reason: string;
  razorpay_payment_id: string | null;
  interview_session_id: string | null;
  acting_admin_id: string | null;
  resulting_session_count: number;
  resulting_lifetime_flag: boolean;
  note: string | null;
}

interface UserDetailResponse {
  user: UserInfo;
  entitlement: Entitlement;
  purchases: Purchase[];
  sessions: Session[];
  ledger: LedgerEntry[];
}

export default function UserDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [data, setData] = useState<UserDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showAdjustModal, setShowAdjustModal] = useState(false);
  const [showLifetimeModal, setShowLifetimeModal] = useState(false);
  const [activeTab, setActiveTab] = useState<
    'purchases' | 'sessions' | 'ledger'
  >('ledger');

  const fetchUser = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError('');
    try {
      const result = await apiRequest<UserDetailResponse>(
        `/admin/users/${id}`,
      );
      setData(result);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        setError('User not found.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load user');
      }
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    fetchUser();
  }, [fetchUser]);

  if (loading) {
    return <div style={styles.container}><p>Loading user details…</p></div>;
  }

  if (error || !data) {
    return (
      <div style={styles.container}>
        <button onClick={() => navigate('/users')} style={styles.backBtn}>
          ← Back to Users
        </button>
        <div role="alert" style={styles.errorBox}>{error}</div>
      </div>
    );
  }

  const { user, entitlement, purchases, sessions, ledger } = data;

  return (
    <div style={styles.container}>
      <button onClick={() => navigate('/users')} style={styles.backBtn}>
        ← Back to Users
      </button>

      {/* User Header */}
      <div style={styles.headerCard}>
        <div style={styles.headerTop}>
          <div>
            <h1 style={styles.heading}>{user.email}</h1>
            <p style={styles.subtext}>
              {user.role === 'admin' ? '🛡️ Admin' : '👤 User'}
              {' · '}
              {user.email_verified ? 'Verified' : 'Unverified'}
              {' · Joined '}
              {new Date(user.created_at).toLocaleDateString()}
            </p>
          </div>
        </div>

        {/* Entitlement Card */}
        <div style={styles.entitlementCard}>
          <h3 style={styles.sectionTitle}>Current Entitlement</h3>
          <div style={styles.entitlementRow}>
            {entitlement.lifetime_flag ? (
              <span style={styles.badgeLifetime}>♾️ Lifetime Access</span>
            ) : (
              <span style={styles.badgeSessions}>
                {entitlement.session_count} session
                {entitlement.session_count !== 1 ? 's' : ''} remaining
              </span>
            )}
            <div style={styles.entitlementActions}>
              <button
                onClick={() => setShowAdjustModal(true)}
                style={styles.btnPrimary}
              >
                Grant / Revoke Sessions
              </button>
              <button
                onClick={() => setShowLifetimeModal(true)}
                style={styles.btnSecondary}
              >
                Grant Lifetime
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Tabs */}
      <div style={styles.tabRow}>
        <button
          onClick={() => setActiveTab('ledger')}
          style={activeTab === 'ledger' ? styles.tabActive : styles.tab}
        >
          Ledger ({ledger.length})
        </button>
        <button
          onClick={() => setActiveTab('sessions')}
          style={activeTab === 'sessions' ? styles.tabActive : styles.tab}
        >
          Sessions ({sessions.length})
        </button>
        <button
          onClick={() => setActiveTab('purchases')}
          style={activeTab === 'purchases' ? styles.tabActive : styles.tab}
        >
          Purchases ({purchases.length})
        </button>
      </div>

      {/* Tab Content */}
      {activeTab === 'ledger' && (
        <LedgerTable entries={ledger} />
      )}
      {activeTab === 'sessions' && (
        <SessionsTable sessions={sessions} />
      )}
      {activeTab === 'purchases' && (
        <PurchasesTable purchases={purchases} />
      )}

      {/* Modals */}
      {showAdjustModal && (
        <AdjustSessionsModal
          userId={user.id}
          onClose={() => setShowAdjustModal(false)}
          onSuccess={fetchUser}
        />
      )}
      {showLifetimeModal && (
        <LifetimeModal
          userId={user.id}
          onClose={() => setShowLifetimeModal(false)}
          onSuccess={fetchUser}
        />
      )}
    </div>
  );
}

/* ---------- Sub-components ---------- */

function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  if (entries.length === 0) {
    return <p style={styles.emptyText}>No ledger entries.</p>;
  }
  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Timestamp</th>
            <th style={styles.th}>Reason</th>
            <th style={styles.th}>Delta</th>
            <th style={styles.th}>Lifetime</th>
            <th style={styles.th}>Resulting</th>
            <th style={styles.th}>Note</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id} style={styles.trHover}>
              <td style={styles.td}>
                {new Date(entry.ts).toLocaleString()}
              </td>
              <td style={styles.td}>
                <span style={styles.reasonBadge}>{entry.reason}</span>
              </td>
              <td style={styles.td}>
                <span
                  style={{
                    color: entry.session_delta > 0 ? '#16a34a' : entry.session_delta < 0 ? '#dc2626' : '#6b7280',
                    fontWeight: 600,
                  }}
                >
                  {entry.session_delta > 0 ? '+' : ''}
                  {entry.session_delta}
                </span>
              </td>
              <td style={styles.td}>
                {entry.lifetime_flag_set === 'set_true' ? '✓ Set' : '—'}
              </td>
              <td style={styles.td}>
                {entry.resulting_lifetime_flag
                  ? '♾️'
                  : entry.resulting_session_count}
              </td>
              <td style={styles.td}>{entry.note ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SessionsTable({ sessions }: { sessions: Session[] }) {
  if (sessions.length === 0) {
    return <p style={styles.emptyText}>No sessions.</p>;
  }
  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Started</th>
            <th style={styles.th}>Status</th>
            <th style={styles.th}>Expires</th>
            <th style={styles.th}>Ended</th>
            <th style={styles.th}>Reason</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id} style={styles.trHover}>
              <td style={styles.td}>
                {new Date(s.started_at).toLocaleString()}
              </td>
              <td style={styles.td}>
                <span
                  style={
                    s.status === 'active'
                      ? styles.statusActive
                      : s.status === 'ended'
                        ? styles.statusEnded
                        : styles.statusExpired
                  }
                >
                  {s.status}
                </span>
              </td>
              <td style={styles.td}>
                {new Date(s.expires_at).toLocaleString()}
              </td>
              <td style={styles.td}>
                {s.ended_at ? new Date(s.ended_at).toLocaleString() : '—'}
              </td>
              <td style={styles.td}>{s.ended_reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PurchasesTable({ purchases }: { purchases: Purchase[] }) {
  if (purchases.length === 0) {
    return <p style={styles.emptyText}>No purchases.</p>;
  }
  return (
    <div style={styles.tableWrapper}>
      <table style={styles.table}>
        <thead>
          <tr>
            <th style={styles.th}>Date</th>
            <th style={styles.th}>Pack</th>
            <th style={styles.th}>Price</th>
            <th style={styles.th}>MRP</th>
            <th style={styles.th}>Status</th>
            <th style={styles.th}>Welcome Offer</th>
          </tr>
        </thead>
        <tbody>
          {purchases.map((p) => (
            <tr key={p.id} style={styles.trHover}>
              <td style={styles.td}>
                {new Date(p.created_at).toLocaleString()}
              </td>
              <td style={styles.td}>{p.pack_slug}</td>
              <td style={styles.td}>
                ₹{(p.effective_price_paise / 100).toFixed(2)}
              </td>
              <td style={styles.td}>
                ₹{(p.mrp_at_purchase_paise / 100).toFixed(2)}
              </td>
              <td style={styles.td}>
                <span
                  style={
                    p.status === 'completed'
                      ? styles.statusActive
                      : p.status === 'pending'
                        ? styles.statusPending
                        : styles.statusExpired
                  }
                >
                  {p.status}
                </span>
              </td>
              <td style={styles.td}>
                {p.welcome_offer_applied ? '✓' : '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AdjustSessionsModal({
  userId,
  onClose,
  onSuccess,
}: {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    const deltaNum = parseInt(delta, 10);
    if (isNaN(deltaNum) || deltaNum === 0 || deltaNum < -1000 || deltaNum > 1000) {
      setError('Session delta must be an integer between -1000 and 1000, excluding 0.');
      return;
    }
    if (!note.trim() || note.trim().length > 500) {
      setError('Note is required (1–500 characters).');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest(`/admin/users/${userId}/entitlement-adjust`, {
        method: 'POST',
        body: { session_delta: deltaNum, note: note.trim() },
      });
      onSuccess();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to adjust entitlement.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.modalTitle}>Grant / Revoke Sessions</h2>
        <form onSubmit={handleSubmit}>
          {error && <div role="alert" style={styles.errorBox}>{error}</div>}
          <div style={styles.formField}>
            <label htmlFor="adjust-delta" style={styles.formLabel}>
              Session Delta
            </label>
            <input
              id="adjust-delta"
              type="number"
              min="-1000"
              max="1000"
              value={delta}
              onChange={(e) => setDelta(e.target.value)}
              placeholder="e.g. 5 to grant, -3 to revoke"
              required
              style={styles.formInput}
            />
            <p style={styles.helpText}>
              Positive to grant, negative to revoke. Range: -1000 to 1000.
            </p>
          </div>
          <div style={styles.formField}>
            <label htmlFor="adjust-note" style={styles.formLabel}>
              Reason Note
            </label>
            <textarea
              id="adjust-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for this adjustment (required)"
              required
              maxLength={500}
              rows={3}
              style={styles.formTextarea}
            />
            <p style={styles.helpText}>{note.length}/500 characters</p>
          </div>
          <div style={styles.modalActions}>
            <button
              type="button"
              onClick={onClose}
              style={styles.btnSecondary}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.btnPrimary}
              disabled={submitting}
            >
              {submitting ? 'Applying…' : 'Apply Adjustment'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function LifetimeModal({
  userId,
  onClose,
  onSuccess,
}: {
  userId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [confirmed, setConfirmed] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');

    if (!confirmed) {
      setError('Please confirm you want to grant lifetime access.');
      return;
    }
    if (!note.trim() || note.trim().length > 500) {
      setError('Note is required (1–500 characters).');
      return;
    }

    setSubmitting(true);
    try {
      await apiRequest(`/admin/users/${userId}/entitlement-adjust`, {
        method: 'POST',
        body: {
          session_delta: 1,
          note: `[LIFETIME GRANT] ${note.trim()}`,
        },
      });
      onSuccess();
      onClose();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to grant lifetime access.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={styles.modalOverlay} onClick={onClose}>
      <div style={styles.modalContent} onClick={(e) => e.stopPropagation()}>
        <h2 style={styles.modalTitle}>Grant Lifetime Access</h2>
        <form onSubmit={handleSubmit}>
          {error && <div role="alert" style={styles.errorBox}>{error}</div>}
          <p style={styles.warningText}>
            This will grant the user unlimited interview sessions for the
            lifetime of their account. This action cannot be easily undone.
          </p>
          <div style={styles.formField}>
            <label htmlFor="lifetime-note" style={styles.formLabel}>
              Reason Note
            </label>
            <textarea
              id="lifetime-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Reason for granting lifetime access (required)"
              required
              maxLength={500}
              rows={3}
              style={styles.formTextarea}
            />
            <p style={styles.helpText}>{note.length}/500 characters</p>
          </div>
          <div style={styles.formField}>
            <label style={styles.checkboxLabel}>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {' '}I confirm I want to grant lifetime access to this user
            </label>
          </div>
          <div style={styles.modalActions}>
            <button
              type="button"
              onClick={onClose}
              style={styles.btnSecondary}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              style={styles.btnDanger}
              disabled={submitting || !confirmed}
            >
              {submitting ? 'Granting…' : 'Grant Lifetime Access'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ---------- Styles ---------- */

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '1.5rem',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#2563eb',
    cursor: 'pointer',
    fontSize: '0.875rem',
    padding: '0.25rem 0',
    marginBottom: '1rem',
  },
  heading: {
    fontSize: '1.5rem',
    fontWeight: 600,
    margin: 0,
  },
  subtext: {
    fontSize: '0.875rem',
    color: '#6b7280',
    margin: '0.25rem 0 0',
  },
  headerCard: {
    marginBottom: '1.5rem',
  },
  headerTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: '1rem',
  },
  entitlementCard: {
    padding: '1rem',
    backgroundColor: '#f9fafb',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
  },
  sectionTitle: {
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#374151',
    margin: '0 0 0.5rem',
  },
  entitlementRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap' as const,
    gap: '0.75rem',
  },
  entitlementActions: {
    display: 'flex',
    gap: '0.5rem',
  },
  badgeLifetime: {
    display: 'inline-block',
    padding: '0.25rem 0.75rem',
    backgroundColor: '#dbeafe',
    color: '#1d4ed8',
    borderRadius: '9999px',
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  badgeSessions: {
    display: 'inline-block',
    padding: '0.25rem 0.75rem',
    backgroundColor: '#dcfce7',
    color: '#166534',
    borderRadius: '9999px',
    fontSize: '0.875rem',
    fontWeight: 600,
  },
  tabRow: {
    display: 'flex',
    gap: '0',
    borderBottom: '2px solid #e5e7eb',
    marginBottom: '1rem',
  },
  tab: {
    padding: '0.5rem 1rem',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid transparent',
    marginBottom: '-2px',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: '#6b7280',
    fontWeight: 500,
  },
  tabActive: {
    padding: '0.5rem 1rem',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid #2563eb',
    marginBottom: '-2px',
    cursor: 'pointer',
    fontSize: '0.875rem',
    color: '#2563eb',
    fontWeight: 600,
  },
  tableWrapper: {
    overflowX: 'auto' as const,
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse' as const,
    fontSize: '0.8125rem',
  },
  th: {
    textAlign: 'left' as const,
    padding: '0.625rem 0.75rem',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    fontWeight: 600,
    color: '#374151',
    fontSize: '0.6875rem',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.05em',
  },
  trHover: {
    borderBottom: '1px solid #f3f4f6',
  },
  td: {
    padding: '0.625rem 0.75rem',
    color: '#111827',
  },
  reasonBadge: {
    display: 'inline-block',
    padding: '0.125rem 0.375rem',
    backgroundColor: '#f3f4f6',
    borderRadius: '4px',
    fontSize: '0.6875rem',
    fontFamily: 'monospace',
  },
  statusActive: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#dcfce7',
    color: '#166534',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  statusEnded: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#f3f4f6',
    color: '#374151',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  statusExpired: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#fef2f2',
    color: '#dc2626',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  statusPending: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#fef3c7',
    color: '#92400e',
    borderRadius: '9999px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  emptyText: {
    textAlign: 'center' as const,
    color: '#6b7280',
    padding: '2rem',
  },
  errorBox: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  modalOverlay: {
    position: 'fixed' as const,
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1rem',
  },
  modalContent: {
    backgroundColor: '#fff',
    borderRadius: '12px',
    padding: '1.5rem',
    width: '100%',
    maxWidth: '480px',
    boxShadow: '0 20px 60px rgba(0, 0, 0, 0.2)',
  },
  modalTitle: {
    fontSize: '1.25rem',
    fontWeight: 600,
    margin: '0 0 1rem',
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.5rem',
    marginTop: '1.25rem',
  },
  formField: {
    marginBottom: '1rem',
  },
  formLabel: {
    display: 'block',
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#374151',
    marginBottom: '0.25rem',
  },
  formInput: {
    width: '100%',
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '1rem',
    boxSizing: 'border-box' as const,
  },
  formTextarea: {
    width: '100%',
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
  },
  helpText: {
    fontSize: '0.75rem',
    color: '#6b7280',
    margin: '0.25rem 0 0',
  },
  warningText: {
    padding: '0.75rem',
    backgroundColor: '#fef3c7',
    border: '1px solid #fde68a',
    borderRadius: '6px',
    color: '#92400e',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  checkboxLabel: {
    fontSize: '0.875rem',
    color: '#374151',
    cursor: 'pointer',
  },
  btnPrimary: {
    padding: '0.5rem 1rem',
    backgroundColor: '#2563eb',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  btnSecondary: {
    padding: '0.5rem 1rem',
    backgroundColor: '#fff',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  btnDanger: {
    padding: '0.5rem 1rem',
    backgroundColor: '#dc2626',
    color: '#fff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
};
