import { useState, useEffect, useCallback } from 'react';
import { apiRequest, ApiClientError } from '../api/client';

/** Shape returned by GET /admin/packs */
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

/** Editable fields for a pack row */
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
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to load packs');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchPacks();
  }, [fetchPacks]);

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

  function cancelEditing() {
    setEditingSlug(null);
    setEditState(null);
    setSaveError('');
  }

  function updateField(field: keyof EditState, value: string | boolean) {
    if (!editState) return;
    setEditState({ ...editState, [field]: value });
  }

  /** Compute real-time discount % from current edit state */
  function getEditDiscount(): number {
    if (!editState) return 0;
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);
    if (isNaN(mrp) || isNaN(welcome) || mrp <= 0) return 0;
    return computeDiscountPercent(mrp, welcome);
  }

  /** Validation: blocks submission when welcome_price >= mrp */
  function getValidationError(): string | null {
    if (!editState) return null;
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);

    if (isNaN(mrp) || mrp <= 0) return 'MRP must be a positive integer';
    if (mrp > 100_000_000) return 'MRP must not exceed 1,00,00,000 paise';
    if (isNaN(welcome) || welcome < 0) return 'Welcome price must be a non-negative integer';
    if (welcome >= mrp) return 'Welcome price must be less than MRP';

    // For non-lifetime packs, session_count is required
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
    if (validationError) {
      setSaveError(validationError);
      return;
    }

    const currentPack = packs.find((p) => p.slug === editingSlug);
    if (!currentPack) return;

    // Build patch body with only changed fields
    const patch: Record<string, unknown> = {};
    const mrp = parseInt(editState.mrp_paise, 10);
    const welcome = parseInt(editState.welcome_price_paise, 10);

    if (editState.display_name !== currentPack.display_name) {
      patch.display_name = editState.display_name;
    }
    if (editState.description !== currentPack.description) {
      patch.description = editState.description;
    }
    if (mrp !== currentPack.mrp_paise) {
      patch.mrp_paise = mrp;
    }
    if (welcome !== currentPack.welcome_price_paise) {
      patch.welcome_price_paise = welcome;
    }
    if (!currentPack.is_lifetime) {
      const sc = parseInt(editState.session_count, 10);
      if (sc !== currentPack.session_count) {
        patch.session_count = sc;
      }
    }
    if (editState.active !== currentPack.active) {
      patch.active = editState.active;
    }

    if (Object.keys(patch).length === 0) {
      cancelEditing();
      return;
    }

    try {
      setSaving(true);
      setSaveError('');
      const data = await apiRequest<{ pack: Pack }>(`/admin/packs/${editingSlug}`, {
        method: 'PATCH',
        body: patch,
      });
      // Update local state with the response
      setPacks((prev) => prev.map((p) => (p.slug === editingSlug ? data.pack : p)));
      setEditingSlug(null);
      setEditState(null);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setSaveError(err.message);
      } else {
        setSaveError('Failed to save changes');
      }
    } finally {
      setSaving(false);
    }
  }

  const validationError = getValidationError();
  const isSubmitBlocked = validationError !== null;

  if (loading) {
    return (
      <div style={styles.container}>
        <p style={styles.loadingText}>Loading packs…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={styles.container}>
        <div role="alert" style={styles.errorBanner}>
          {error}
        </div>
        <button onClick={() => void fetchPacks()} style={styles.retryButton}>
          Retry
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.heading}>Pricing &amp; Packs</h1>
      <p style={styles.subtitle}>
        Manage pack pricing, welcome offer prices, and activation status.
      </p>

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Slug</th>
              <th style={styles.th}>Display Name</th>
              <th style={styles.th}>MRP</th>
              <th style={styles.th}>Welcome Price</th>
              <th style={styles.th}>Discount %</th>
              <th style={styles.th}>Sessions</th>
              <th style={styles.th}>Active</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {packs.map((pack) => (
              <tr key={pack.slug} style={styles.tr}>
                {editingSlug === pack.slug && editState ? (
                  <EditRow
                    pack={pack}
                    editState={editState}
                    discount={getEditDiscount()}
                    validationError={validationError}
                    saveError={saveError}
                    saving={saving}
                    isSubmitBlocked={isSubmitBlocked}
                    onUpdate={updateField}
                    onSave={() => void handleSave()}
                    onCancel={cancelEditing}
                  />
                ) : (
                  <ViewRow pack={pack} onEdit={() => startEditing(pack)} />
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {saveError && editingSlug && (
        <div role="alert" style={styles.saveErrorBanner}>
          {saveError}
        </div>
      )}
    </div>
  );
}

interface ViewRowProps {
  pack: Pack;
  onEdit: () => void;
}

function ViewRow({ pack, onEdit }: ViewRowProps) {
  return (
    <>
      <td style={styles.td}>
        <code style={styles.slugCode}>{pack.slug}</code>
      </td>
      <td style={styles.td}>{pack.display_name}</td>
      <td style={styles.td}>{paiseToCurrency(pack.mrp_paise)}</td>
      <td style={styles.td}>{paiseToCurrency(pack.welcome_price_paise)}</td>
      <td style={styles.td}>
        <span style={styles.discountBadge}>{pack.discount_percent}%</span>
      </td>
      <td style={styles.td}>
        {pack.is_lifetime ? (
          <span style={styles.lifetimeBadge}>Lifetime</span>
        ) : (
          pack.session_count
        )}
      </td>
      <td style={styles.td}>
        <span style={pack.active ? styles.activeBadge : styles.inactiveBadge}>
          {pack.active ? 'Active' : 'Inactive'}
        </span>
      </td>
      <td style={styles.td}>
        <button onClick={onEdit} style={styles.editButton}>
          Edit
        </button>
      </td>
    </>
  );
}

interface EditRowProps {
  pack: Pack;
  editState: EditState;
  discount: number;
  validationError: string | null;
  saveError: string;
  saving: boolean;
  isSubmitBlocked: boolean;
  onUpdate: (field: keyof EditState, value: string | boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}

function EditRow({
  pack,
  editState,
  discount,
  validationError,
  saving,
  isSubmitBlocked,
  onUpdate,
  onSave,
  onCancel,
}: EditRowProps) {
  return (
    <>
      <td style={styles.td}>
        <code style={styles.slugCode}>{pack.slug}</code>
      </td>
      <td style={styles.td}>
        <input
          type="text"
          value={editState.display_name}
          onChange={(e) => onUpdate('display_name', e.target.value)}
          style={styles.inlineInput}
          aria-label="Display name"
          maxLength={50}
        />
      </td>
      <td style={styles.td}>
        <input
          type="number"
          value={editState.mrp_paise}
          onChange={(e) => onUpdate('mrp_paise', e.target.value)}
          style={styles.inlineInputNumber}
          aria-label="MRP in paise"
          min={1}
          max={100000000}
        />
        <div style={styles.helperText}>
          {!isNaN(parseInt(editState.mrp_paise, 10)) &&
            paiseToCurrency(parseInt(editState.mrp_paise, 10))}
        </div>
      </td>
      <td style={styles.td}>
        <input
          type="number"
          value={editState.welcome_price_paise}
          onChange={(e) => onUpdate('welcome_price_paise', e.target.value)}
          style={{
            ...styles.inlineInputNumber,
            ...(isSubmitBlocked &&
            parseInt(editState.welcome_price_paise, 10) >= parseInt(editState.mrp_paise, 10)
              ? styles.inputError
              : {}),
          }}
          aria-label="Welcome price in paise"
          min={0}
          max={100000000}
        />
        <div style={styles.helperText}>
          {!isNaN(parseInt(editState.welcome_price_paise, 10)) &&
            paiseToCurrency(parseInt(editState.welcome_price_paise, 10))}
        </div>
        {validationError &&
          parseInt(editState.welcome_price_paise, 10) >= parseInt(editState.mrp_paise, 10) && (
            <div style={styles.validationMsg}>{validationError}</div>
          )}
      </td>
      <td style={styles.td}>
        <span style={styles.discountBadge}>{discount}%</span>
      </td>
      <td style={styles.td}>
        {pack.is_lifetime ? (
          <span style={styles.lifetimeBadge}>Lifetime</span>
        ) : (
          <input
            type="number"
            value={editState.session_count}
            onChange={(e) => onUpdate('session_count', e.target.value)}
            style={styles.inlineInputSmall}
            aria-label="Session count"
            min={1}
          />
        )}
      </td>
      <td style={styles.td}>
        <label style={styles.toggleLabel}>
          <input
            type="checkbox"
            checked={editState.active}
            onChange={(e) => onUpdate('active', e.target.checked)}
            aria-label="Active status"
          />
          {editState.active ? ' Active' : ' Inactive'}
        </label>
      </td>
      <td style={styles.td}>
        <div style={styles.actionButtons}>
          <button
            onClick={onSave}
            disabled={saving || isSubmitBlocked}
            style={{
              ...styles.saveButton,
              ...(isSubmitBlocked ? styles.disabledButton : {}),
            }}
            title={isSubmitBlocked ? validationError ?? '' : 'Save changes'}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
          <button onClick={onCancel} disabled={saving} style={styles.cancelButton}>
            Cancel
          </button>
        </div>
      </td>
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '1200px',
    margin: '0 auto',
  },
  heading: {
    margin: '0 0 0.25rem',
    fontSize: '1.5rem',
    fontWeight: 600,
  },
  subtitle: {
    margin: '0 0 1.5rem',
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  loadingText: {
    color: '#6b7280',
    textAlign: 'center',
    padding: '2rem',
  },
  errorBanner: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  saveErrorBanner: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginTop: '1rem',
  },
  retryButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.875rem',
  },
  tableWrapper: {
    overflowX: 'auto',
    borderRadius: '8px',
    border: '1px solid #e5e7eb',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
  },
  th: {
    padding: '0.75rem 1rem',
    textAlign: 'left',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    fontWeight: 600,
    color: '#374151',
    whiteSpace: 'nowrap',
  },
  tr: {
    borderBottom: '1px solid #f3f4f6',
  },
  td: {
    padding: '0.75rem 1rem',
    verticalAlign: 'top',
  },
  slugCode: {
    backgroundColor: '#f3f4f6',
    padding: '0.125rem 0.375rem',
    borderRadius: '4px',
    fontSize: '0.8125rem',
    fontFamily: 'monospace',
  },
  discountBadge: {
    backgroundColor: '#dcfce7',
    color: '#166534',
    padding: '0.125rem 0.5rem',
    borderRadius: '9999px',
    fontSize: '0.8125rem',
    fontWeight: 500,
  },
  lifetimeBadge: {
    backgroundColor: '#ede9fe',
    color: '#5b21b6',
    padding: '0.125rem 0.5rem',
    borderRadius: '9999px',
    fontSize: '0.8125rem',
    fontWeight: 500,
  },
  activeBadge: {
    backgroundColor: '#dcfce7',
    color: '#166534',
    padding: '0.125rem 0.5rem',
    borderRadius: '9999px',
    fontSize: '0.8125rem',
  },
  inactiveBadge: {
    backgroundColor: '#fee2e2',
    color: '#991b1b',
    padding: '0.125rem 0.5rem',
    borderRadius: '9999px',
    fontSize: '0.8125rem',
  },
  editButton: {
    padding: '0.375rem 0.75rem',
    backgroundColor: '#f3f4f6',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    fontWeight: 500,
  },
  inlineInput: {
    padding: '0.375rem 0.5rem',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    fontSize: '0.875rem',
    width: '100%',
    minWidth: '120px',
  },
  inlineInputNumber: {
    padding: '0.375rem 0.5rem',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    fontSize: '0.875rem',
    width: '110px',
  },
  inlineInputSmall: {
    padding: '0.375rem 0.5rem',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    fontSize: '0.875rem',
    width: '70px',
  },
  inputError: {
    borderColor: '#dc2626',
    backgroundColor: '#fef2f2',
  },
  helperText: {
    fontSize: '0.75rem',
    color: '#6b7280',
    marginTop: '0.125rem',
  },
  validationMsg: {
    fontSize: '0.75rem',
    color: '#dc2626',
    marginTop: '0.25rem',
  },
  toggleLabel: {
    fontSize: '0.8125rem',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '0.25rem',
  },
  actionButtons: {
    display: 'flex',
    gap: '0.5rem',
  },
  saveButton: {
    padding: '0.375rem 0.75rem',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.8125rem',
    fontWeight: 500,
  },
  cancelButton: {
    padding: '0.375rem 0.75rem',
    backgroundColor: '#ffffff',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    cursor: 'pointer',
    fontSize: '0.8125rem',
  },
  disabledButton: {
    opacity: 0.5,
    cursor: 'not-allowed',
  },
};
