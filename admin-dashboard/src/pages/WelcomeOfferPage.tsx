import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest } from '../api/client';

interface WelcomeOffer {
  enabled: boolean;
  ends_at: string;
  created_at: string;
  updated_at: string;
}

interface WelcomeOfferResponse {
  welcome_offer: WelcomeOffer;
}

interface WelcomeOfferUpdateResponse {
  welcome_offer: WelcomeOffer;
  previous: { enabled: boolean; ends_at: string };
  new: { enabled: boolean; ends_at: string };
}

/** Convert an ISO string to a local datetime-local input value (YYYY-MM-DDTHH:mm). */
function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/** Convert a datetime-local input value back to an ISO string (UTC). */
function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

/** Format an ISO date for display. */
function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  });
}

export default function WelcomeOfferPage() {
  const [offer, setOffer] = useState<WelcomeOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  // Form state
  const [enabled, setEnabled] = useState(false);
  const [endsAt, setEndsAt] = useState('');

  // Confirmation dialog state
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const fetchOffer = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<WelcomeOfferResponse>('/admin/welcome-offer');
      setOffer(data.welcome_offer);
      setEnabled(data.welcome_offer.enabled);
      setEndsAt(toDatetimeLocalValue(data.welcome_offer.ends_at));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load welcome offer');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchOffer();
  }, [fetchOffer]);

  const hasChanges = offer
    ? enabled !== offer.enabled ||
      fromDatetimeLocalValue(endsAt) !== new Date(offer.ends_at).toISOString()
    : false;

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!hasChanges) return;
    setShowConfirmDialog(true);
  }

  async function confirmSave() {
    setShowConfirmDialog(false);
    setSaving(true);
    setError('');
    setSuccessMessage('');

    try {
      const body: { enabled?: boolean; ends_at?: string } = {};
      if (offer && enabled !== offer.enabled) {
        body.enabled = enabled;
      }
      if (offer && fromDatetimeLocalValue(endsAt) !== new Date(offer.ends_at).toISOString()) {
        body.ends_at = fromDatetimeLocalValue(endsAt);
      }

      const data = await apiRequest<WelcomeOfferUpdateResponse>('/admin/welcome-offer', {
        method: 'PATCH',
        body,
      });

      setOffer(data.welcome_offer);
      setEnabled(data.welcome_offer.enabled);
      setEndsAt(toDatetimeLocalValue(data.welcome_offer.ends_at));
      setSuccessMessage('Welcome offer updated successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update welcome offer');
    } finally {
      setSaving(false);
    }
  }

  function cancelConfirm() {
    setShowConfirmDialog(false);
  }

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <p style={styles.loadingText}>Loading welcome offer…</p>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Welcome Offer</h1>
        <p style={styles.subtitle}>
          Configure the welcome offer discount for first-time buyers.
        </p>

        {error && (
          <div role="alert" style={styles.error}>
            {error}
          </div>
        )}

        {successMessage && (
          <div role="status" style={styles.success}>
            {successMessage}
          </div>
        )}

        {offer && (
          <div style={styles.meta}>
            <span style={styles.metaItem}>
              Created: {formatDate(offer.created_at)}
            </span>
            <span style={styles.metaItem}>
              Last updated: {formatDate(offer.updated_at)}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} style={styles.form}>
          <div style={styles.field}>
            <div style={styles.toggleRow}>
              <label htmlFor="enabled-toggle" style={styles.label}>
                Offer Enabled
              </label>
              <button
                id="enabled-toggle"
                type="button"
                role="switch"
                aria-checked={enabled}
                onClick={() => setEnabled(!enabled)}
                disabled={saving}
                style={{
                  ...styles.toggle,
                  backgroundColor: enabled ? '#2563eb' : '#d1d5db',
                }}
              >
                <span
                  style={{
                    ...styles.toggleKnob,
                    transform: enabled ? 'translateX(20px)' : 'translateX(0)',
                  }}
                />
              </button>
            </div>
            <p style={styles.fieldHint}>
              {enabled
                ? 'The welcome offer is active. First-time buyers will see discounted prices.'
                : 'The welcome offer is disabled. All users will see MRP prices.'}
            </p>
          </div>

          <div style={styles.field}>
            <label htmlFor="ends-at" style={styles.label}>
              Offer End Date & Time
            </label>
            <input
              id="ends-at"
              type="datetime-local"
              value={endsAt}
              onChange={(e) => setEndsAt(e.target.value)}
              disabled={saving}
              style={styles.input}
              aria-describedby="ends-at-hint"
            />
            <p id="ends-at-hint" style={styles.fieldHint}>
              The welcome offer will automatically stop applying after this date and time (local timezone).
            </p>
          </div>

          <button
            type="submit"
            disabled={saving || !hasChanges}
            style={{
              ...styles.button,
              opacity: saving || !hasChanges ? 0.6 : 1,
              cursor: saving || !hasChanges ? 'not-allowed' : 'pointer',
            }}
          >
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </form>
      </div>

      {/* Confirmation Dialog */}
      {showConfirmDialog && (
        <div
          style={styles.overlay}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-dialog-title"
        >
          <div style={styles.dialog}>
            <h2 id="confirm-dialog-title" style={styles.dialogTitle}>
              Confirm Changes
            </h2>
            <p style={styles.dialogText}>
              Are you sure you want to update the welcome offer?
            </p>
            <div style={styles.dialogChanges}>
              {offer && enabled !== offer.enabled && (
                <p style={styles.changeItem}>
                  <strong>Enabled:</strong>{' '}
                  {offer.enabled ? 'Yes' : 'No'} → {enabled ? 'Yes' : 'No'}
                </p>
              )}
              {offer &&
                fromDatetimeLocalValue(endsAt) !==
                  new Date(offer.ends_at).toISOString() && (
                  <p style={styles.changeItem}>
                    <strong>End Date:</strong>{' '}
                    {formatDate(offer.ends_at)} →{' '}
                    {formatDate(fromDatetimeLocalValue(endsAt))}
                  </p>
                )}
            </div>
            <div style={styles.dialogActions}>
              <button
                type="button"
                onClick={cancelConfirm}
                style={styles.cancelButton}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmSave}
                style={styles.confirmButton}
              >
                Confirm
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    minHeight: '100vh',
    backgroundColor: '#f3f4f6',
    padding: '2rem 1rem',
  },
  card: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.1)',
    padding: '2rem',
    width: '100%',
    maxWidth: '600px',
  },
  title: {
    margin: '0 0 0.25rem',
    fontSize: '1.5rem',
    fontWeight: 600,
  },
  subtitle: {
    margin: '0 0 1.5rem',
    fontSize: '0.875rem',
    color: '#6b7280',
  },
  meta: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
    marginBottom: '1.5rem',
    padding: '0.75rem',
    backgroundColor: '#f9fafb',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
  },
  metaItem: {
    fontSize: '0.8rem',
    color: '#6b7280',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1.5rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#374151',
  },
  toggle: {
    position: 'relative',
    width: '44px',
    height: '24px',
    borderRadius: '12px',
    border: 'none',
    cursor: 'pointer',
    transition: 'background-color 0.2s',
    padding: 0,
  },
  toggleKnob: {
    display: 'block',
    width: '20px',
    height: '20px',
    borderRadius: '50%',
    backgroundColor: '#ffffff',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.2)',
    transition: 'transform 0.2s',
    marginLeft: '2px',
    marginTop: '2px',
  },
  fieldHint: {
    fontSize: '0.8rem',
    color: '#6b7280',
    margin: 0,
  },
  input: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '1rem',
    outline: 'none',
  },
  button: {
    marginTop: '0.5rem',
    padding: '0.625rem 1rem',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '1rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  error: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  success: {
    padding: '0.75rem',
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: '6px',
    color: '#16a34a',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  loadingText: {
    textAlign: 'center',
    color: '#6b7280',
  },
  // Confirmation dialog styles
  overlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
    padding: '1rem',
  },
  dialog: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.2)',
    padding: '1.5rem',
    width: '100%',
    maxWidth: '440px',
  },
  dialogTitle: {
    margin: '0 0 0.75rem',
    fontSize: '1.125rem',
    fontWeight: 600,
  },
  dialogText: {
    margin: '0 0 1rem',
    fontSize: '0.875rem',
    color: '#374151',
  },
  dialogChanges: {
    padding: '0.75rem',
    backgroundColor: '#f9fafb',
    borderRadius: '6px',
    border: '1px solid #e5e7eb',
    marginBottom: '1.25rem',
  },
  changeItem: {
    margin: '0 0 0.25rem',
    fontSize: '0.8rem',
    color: '#374151',
  },
  dialogActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
  },
  cancelButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#ffffff',
    color: '#374151',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
  confirmButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
  },
};
