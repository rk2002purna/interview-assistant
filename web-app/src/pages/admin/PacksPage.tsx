import { useState, useEffect, useCallback } from 'react';
import { apiRequest, ApiClientError } from '../../api/client';

interface Pack {
  slug: string;
  display_name: string;
  description: string;
  mrp_paise: number;
  welcome_price_paise: number;
  discount_percent: number;
  session_count: number | null;
  is_lifetime: boolean;
  active: boolean;
  updated_at: string;
}

interface EditState {
  display_name: string;
  description: string;
  mrp_paise: string;
  welcome_price_paise: string;
  session_count: string;
  active: boolean;
}

function paiseToCurrency(paise: number): string {
  return `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function computeDiscountPercent(mrp: number, welcome: number): number {
  if (mrp <= 0) return 0;
  return Math.floor(((mrp - welcome) / mrp) * 100);
}

export default function PacksPage() {
  const [packs, setPacks] = useState<Pack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  const [editState, setEditState] = useState<EditState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  const fetchPacks = useCallback(async () => {
    try {
      setLoading(true);
      setError('');
      const data = await apiRequest<{ packs: Pack[] }>('/admin/packs');
      setPacks(data.packs);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load packs');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void fetchPacks(); }, [fetchPacks]);

  function startEditing(pack: Pack) {
    setEditingSlug(pack.slug);
    setSaveError('');
    setEditState({
      display_name: pack.display_name,
      description: pack.description,
      mrp_paise: String(pack.mrp_paise),
      welcome_price_paise: String(pack.welcome_price_paise),
      session_count: pack.session_count !== null ? String(pack.session_count) : '',
      active: pack.active,
    });
  }

  function cancelEditing() { setEditingSlug(null); setEditState(null); setSaveError(''); }

  function updateField(field: keyof EditState, value: string | boolean) {
    if (!editState) return;
    setEditState({ ...editState, [field]: value });
  }

  function getEditDiscount(): number {
    if (!editState) return 0;
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);
    if (isNaN(mrp) || isNaN(welcome) || mrp <= 0) return 0;
    return computeDiscountPercent(mrp, welcome);
  }

  function getValidationError(): string | null {
    if (!editState) return null;
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);
    if (isNaN(mrp) || mrp <= 0) return 'MRP must be a positive integer';
    if (mrp > 100_000_000) return 'MRP must not exceed 1,00,00,000 paise';
    if (isNaN(welcome) || welcome < 0) return 'Welcome price must be a non-negative integer';
    if (welcome >= mrp) return 'Welcome price must be less than MRP';
    const currentPack = packs.find((p) => p.slug === editingSlug);
    if (currentPack && !currentPack.is_lifetime) {
      const sc = parseInt(editState.session_count, 10);
      if (isNaN(sc) || sc <= 0) return 'Session count must be a positive integer';
    }
    return null;
  }

  async function handleSave() {
    if (!editState || !editingSlug) return;
    const validationError = getValidationError();
    if (validationError) { setSaveError(validationError); return; }
    const currentPack = packs.find((p) => p.slug === editingSlug);
    if (!currentPack) return;

    const patch: Record<string, unknown> = {};
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);
    if (editState.display_name !== currentPack.display_name) patch.display_name = editState.display_name;
    if (editState.description !== currentPack.description) patch.description = editState.description;
    if (mrp !== currentPack.mrp_paise) patch.mrp_paise = mrp;
    if (welcome !== currentPack.welcome_price_paise) patch.welcome_price_paise = welcome;
    if (!currentPack.is_lifetime) {
      const sc = parseInt(editState.session_count, 10);
      if (sc !== currentPack.session_count) patch.session_count = sc;
    }
    if (editState.active !== currentPack.active) patch.active = editState.active;
    if (Object.keys(patch).length === 0) { cancelEditing(); return; }

    try {
      setSaving(true);
      setSaveError('');
      const data = await apiRequest<{ pack: Pack }>(`/admin/packs/${editingSlug}`, { method: 'PATCH', body: patch });
      setPacks((prev) => prev.map((p) => (p.slug === editingSlug ? data.pack : p)));
      setEditingSlug(null);
      setEditState(null);
    } catch (err) {
      setSaveError(err instanceof ApiClientError ? err.message : 'Failed to save changes');
    } finally { setSaving(false); }
  }

  const validationError = getValidationError();
  const isSubmitBlocked = validationError !== null;

  if (loading) return <div><p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>Loading packs…</p></div>;
  if (error) {
    return (
      <div>
        <div role="alert" style={s.errorBanner}>{error}</div>
        <button onClick={() => void fetchPacks()} style={s.retryButton}>Retry</button>
      </div>
    );
  }

  return (
    <div>
      <h1 style={s.heading}>Pricing & Packs</h1>
      <p style={s.subtitle}>Manage pack pricing, welcome offer prices, and activation status.</p>

      <div style={s.tableWrapper}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Slug</th>
              <th style={s.th}>Display Name</th>
              <th style={s.th}>MRP</th>
              <th style={s.th}>Welcome Price</th>
              <th style={s.th}>Discount %</th>
              <th style={s.th}>Sessions</th>
              <th style={s.th}>Active</th>
              <th style={s.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.slug} style={s.tr}>
                {editingSlug === pack.slug && editState ? (
                  <EditRow
                    pack={pack} editState={editState} discount={getEditDiscount()}
                    validationError={validationError} saveError={saveError} saving={saving}
                    isSubmitBlocked={isSubmitBlocked} onUpdate={updateField}
                    onSave={() => void handleSave()} onCancel={cancelEditing}
                  />
                ) : (
                  <ViewRow pack={pack} onEdit={() => startEditing(pack)} />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {saveError && editingSlug && <div role="alert" style={s.saveErrorBanner}>{saveError}</div>}
    </div>
  );
}

function ViewRow({ pack, onEdit }: { pack: Pack; onEdit: () => void }) {
  return (
    <>
      <td style={s.td}><code style={s.slugCode}>{pack.slug}</code></td>
      <td style={s.td}>{pack.display_name}</td>
      <td style={s.td}>{paiseToCurrency(pack.mrp_paise)}</td>
      <td style={s.td}>{paiseToCurrency(pack.welcome_price_paise)}</td>
      <td style={s.td}><span style={s.discountBadge}>{pack.discount_percent}%</span></td>
      <td style={s.td}>{pack.is_lifetime ? <span style={s.lifetimeBadge}>Lifetime</span> : pack.session_count}</td>
      <td style={s.td}><span style={pack.active ? s.activeBadge : s.inactiveBadge}>{pack.active ? 'Active' : 'Inactive'}</span></td>
      <td style={s.td}><button onClick={onEdit} style={s.editButton}>Edit</button></td>
    </>
  );
}

function EditRow({ pack, editState, discount, validationError, saving, isSubmitBlocked, onUpdate, onSave, onCancel }: {
  pack: Pack; editState: EditState; discount: number; validationError: string | null;
  saveError: string; saving: boolean; isSubmitBlocked: boolean;
  onUpdate: (field: keyof EditState, value: string | boolean) => void;
  onSave: () => void; onCancel: () => void;
}) {
  return (
    <>
      <td style={s.td}><code style={s.slugCode}>{pack.slug}</code></td>
      <td style={s.td}><input type="text" value={editState.display_name} onChange={(e) => onUpdate('display_name', e.target.value)} style={s.inlineInput} aria-label="Display name" maxLength={50} /></td>
      <td style={s.td}>
        <input type="number" value={editState.mrp_paise} onChange={(e) => onUpdate('mrp_paise', e.target.value)} style={s.inlineInputNumber} aria-label="MRP in paise" min={1} max={100000000} />
        <div style={s.helperText}>{!isNaN(parseInt(editState.mrp_paise, 10)) && paiseToCurrency(parseInt(editState.mrp_paise, 10))}</div>
      </td>
      <td style={s.td}>
        <input type="number" value={editState.welcome_price_paise} onChange={(e) => onUpdate('welcome_price_paise', e.target.value)}
          style={{ ...s.inlineInputNumber, ...(isSubmitBlocked && parseInt(editState.welcome_price_paise, 10) >= parseInt(editState.mrp_paise, 10) ? s.inputError : {}) }}
          aria-label="Welcome price in paise" min={0} max={100000000} />
        <div style={s.helperText}>{!isNaN(parseInt(editState.welcome_price_paise, 10)) && paiseToCurrency(parseInt(editState.welcome_price_paise, 10))}</div>
        {validationError && parseInt(editState.welcome_price_paise, 10) >= parseInt(editState.mrp_paise, 10) && <div style={s.validationMsg}>{validationError}</div>}
      </td>
      <td style={s.td}><span style={s.discountBadge}>{discount}%</span></td>
      <td style={s.td}>
        {pack.is_lifetime ? <span style={s.lifetimeBadge}>Lifetime</span> : (
          <input type="number" value={editState.session_count} onChange={(e) => onUpdate('session_count', e.target.value)} style={s.inlineInputSmall} aria-label="Session count" min={1} />
        )}
      </td>
      <td style={s.td}>
        <label style={s.toggleLabel}>
          <input type="checkbox" checked={editState.active} onChange={(e) => onUpdate('active', e.target.checked)} aria-label="Active status" />
          {editState.active ? ' Active' : ' Inactive'}
        </label>
      </td>
      <td style={s.td}>
        <div style={s.actionButtons}>
          <button onClick={onSave} disabled={saving || isSubmitBlocked}
            style={{ ...s.saveButton, ...(isSubmitBlocked ? s.disabledButton : {}) }}
            title={isSubmitBlocked ? validationError ?? '' : 'Save changes'}>
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onCancel} disabled={saving} style={s.cancelButton}>Cancel</button>
        </div>
      </td>
    </>
  );
}

const s: Record<string, React.CSSProperties> = {
  heading: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b' },
  errorBanner: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  saveErrorBanner: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginTop: '1rem' },
  retryButton: { padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.875rem' },
  tableWrapper: { overflowX: 'auto', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)' },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th: { padding: '0.75rem 1rem', textAlign: 'left', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' },
  tr: { borderBottom: '1px solid rgba(255,255,255,0.04)' },
  td: { padding: '0.75rem 1rem', verticalAlign: 'top', color: '#e2e8f0' },
  slugCode: { background: 'rgba(255,255,255,0.05)', padding: '0.125rem 0.375rem', borderRadius: 4, fontSize: '0.8125rem', fontFamily: 'monospace', color: '#cbd5e1' },
  discountBadge: { background: 'rgba(34,197,94,0.12)', color: '#4ade80', padding: '0.125rem 0.5rem', borderRadius: 9999, fontSize: '0.8125rem', fontWeight: 500 },
  lifetimeBadge: { background: 'rgba(139,92,246,0.15)', color: '#a78bfa', padding: '0.125rem 0.5rem', borderRadius: 9999, fontSize: '0.8125rem', fontWeight: 500 },
  activeBadge: { background: 'rgba(34,197,94,0.12)', color: '#4ade80', padding: '0.125rem 0.5rem', borderRadius: 9999, fontSize: '0.8125rem' },
  inactiveBadge: { background: 'rgba(239,68,68,0.1)', color: '#fca5a5', padding: '0.125rem 0.5rem', borderRadius: 9999, fontSize: '0.8125rem' },
  editButton: { padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500, color: '#94a3b8' },
  inlineInput: { padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: '0.875rem', width: '100%', minWidth: 120, color: '#f1f5f9' },
  inlineInputNumber: { padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: '0.875rem', width: 110, color: '#f1f5f9' },
  inlineInputSmall: { padding: '0.375rem 0.5rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: '0.875rem', width: 70, color: '#f1f5f9' },
  inputError: { borderColor: '#ef4444', background: 'rgba(239,68,68,0.08)' },
  helperText: { fontSize: '0.75rem', color: '#64748b', marginTop: '0.125rem' },
  validationMsg: { fontSize: '0.75rem', color: '#f87171', marginTop: '0.25rem' },
  toggleLabel: { fontSize: '0.8125rem', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '0.25rem', color: '#e2e8f0' },
  actionButtons: { display: 'flex', gap: '0.5rem' },
  saveButton: { padding: '0.375rem 0.75rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: '0.8125rem', fontWeight: 500 },
  cancelButton: { padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, cursor: 'pointer', fontSize: '0.8125rem' },
  disabledButton: { opacity: 0.5, cursor: 'not-allowed' },
};
