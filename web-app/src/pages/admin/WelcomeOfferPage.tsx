import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest } from '../../api/client';

interface WelcomeOffer { enabled: boolean; ends_at: string; created_at: string; updated_at: string; }
interface WelcomeOfferResponse { welcome_offer: WelcomeOffer; }
interface WelcomeOfferUpdateResponse { welcome_offer: WelcomeOffer; previous: { enabled: boolean; ends_at: string }; new: { enabled: boolean; ends_at: string }; }

function toDatetimeLocalValue(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

export default function WelcomeOfferPage() {
  const [offer, setOffer] = useState<WelcomeOffer | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [endsAt, setEndsAt] = useState('');
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
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchOffer(); }, [fetchOffer]);

  const hasChanges = offer
    ? enabled !== offer.enabled || fromDatetimeLocalValue(endsAt) !== new Date(offer.ends_at).toISOString()
    : false;

  function handleSubmit(e: FormEvent) { e.preventDefault(); if (!hasChanges) return; setShowConfirmDialog(true); }

  async function confirmSave() {
    setShowConfirmDialog(false);
    setSaving(true);
    setError('');
    setSuccessMessage('');
    try {
      const body: { enabled?: boolean; ends_at?: string } = {};
      if (offer && enabled !== offer.enabled) body.enabled = enabled;
      if (offer && fromDatetimeLocalValue(endsAt) !== new Date(offer.ends_at).toISOString()) body.ends_at = fromDatetimeLocalValue(endsAt);
      const data = await apiRequest<WelcomeOfferUpdateResponse>('/admin/welcome-offer', { method: 'PATCH', body });
      setOffer(data.welcome_offer);
      setEnabled(data.welcome_offer.enabled);
      setEndsAt(toDatetimeLocalValue(data.welcome_offer.ends_at));
      setSuccessMessage('Welcome offer updated successfully.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update welcome offer');
    } finally { setSaving(false); }
  }

  if (loading) return <div><p style={{ color: '#64748b', textAlign: 'center', padding: '2rem' }}>Loading welcome offer…</p></div>;

  return (
    <div style={s.card}>
      <h1 style={s.title}>Welcome Offer</h1>
      <p style={s.subtitle}>Configure the welcome offer discount for first-time buyers.</p>

      {error && <div role="alert" style={s.error}>{error}</div>}
      {successMessage && <div role="status" style={s.success}>{successMessage}</div>}

      {offer && (
        <div style={s.meta}>
          <span style={s.metaItem}>Created: {formatDate(offer.created_at)}</span>
          <span style={s.metaItem}>Last updated: {formatDate(offer.updated_at)}</span>
        </div>
      )}

      <form onSubmit={handleSubmit} style={s.form}>
        <div style={s.field}>
          <div style={s.toggleRow}>
            <label htmlFor="enabled-toggle" style={s.label}>Offer Enabled</label>
            <button id="enabled-toggle" type="button" role="switch" aria-checked={enabled}
              onClick={() => setEnabled(!enabled)} disabled={saving}
              style={{ ...s.toggle, background: enabled ? '#3b82f6' : 'rgba(255,255,255,0.15)' }}>
              <span style={{ ...s.toggleKnob, transform: enabled ? 'translateX(20px)' : 'translateX(0)' }} />
            </button>
          </div>
          <p style={s.fieldHint}>{enabled ? 'The welcome offer is active. First-time buyers will see discounted prices.' : 'The welcome offer is disabled. All users will see MRP prices.'}</p>
        </div>

        <div style={s.field}>
          <label htmlFor="ends-at" style={s.label}>Offer End Date & Time</label>
          <input id="ends-at" type="datetime-local" value={endsAt}
            onChange={(e) => setEndsAt(e.target.value)} disabled={saving} style={s.input} aria-describedby="ends-at-hint" />
          <p id="ends-at-hint" style={s.fieldHint}>The welcome offer will automatically stop applying after this date and time (local timezone).</p>
        </div>

        <button type="submit" disabled={saving || !hasChanges}
          style={{ ...s.button, opacity: saving || !hasChanges ? 0.6 : 1, cursor: saving || !hasChanges ? 'not-allowed' : 'pointer' }}>
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </form>

      {showConfirmDialog && (
        <div style={s.overlay} role="dialog" aria-modal="true" aria-labelledby="confirm-dialog-title">
          <div style={s.dialog}>
            <h2 id="confirm-dialog-title" style={s.dialogTitle}>Confirm Changes</h2>
            <p style={s.dialogText}>Are you sure you want to update the welcome offer?</p>
            <div style={s.dialogChanges}>
              {offer && enabled !== offer.enabled && <p style={s.changeItem}><strong>Enabled:</strong> {offer.enabled ? 'Yes' : 'No'} → {enabled ? 'Yes' : 'No'}</p>}
              {offer && fromDatetimeLocalValue(endsAt) !== new Date(offer.ends_at).toISOString() && (
                <p style={s.changeItem}><strong>End Date:</strong> {formatDate(offer.ends_at)} → {formatDate(fromDatetimeLocalValue(endsAt))}</p>
              )}
            </div>
            <div style={s.dialogActions}>
              <button type="button" onClick={() => setShowConfirmDialog(false)} style={s.cancelButton}>Cancel</button>
              <button type="button" onClick={confirmSave} style={s.confirmButton}>Confirm</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card: { background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)', padding: '2rem', maxWidth: 600 },
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b' },
  meta: { display: 'flex', flexDirection: 'column', gap: '0.25rem', marginBottom: '1.5rem', padding: '0.75rem', background: 'rgba(255,255,255,0.025)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)' },
  metaItem: { fontSize: '0.8rem', color: '#64748b' },
  form: { display: 'flex', flexDirection: 'column', gap: '1.5rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  toggleRow: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
  label: { fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' },
  toggle: { position: 'relative', width: 44, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', transition: 'background-color 0.2s', padding: 0 },
  toggleKnob: { display: 'block', width: 20, height: 20, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 3px rgba(0,0,0,0.2)', transition: 'transform 0.2s', marginLeft: 2, marginTop: 2 },
  fieldHint: { fontSize: '0.8rem', color: '#64748b', margin: 0 },
  input: { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '1rem', color: '#f1f5f9', outline: 'none' },
  button: { marginTop: '0.5rem', padding: '0.625rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '1rem', fontWeight: 500, cursor: 'pointer' },
  error: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  success: { padding: '0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, color: '#4ade80', fontSize: '0.875rem', marginBottom: '1rem' },
  overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: '1rem' },
  dialog: { background: '#111827', borderRadius: 8, border: '1px solid rgba(255,255,255,0.08)', padding: '1.5rem', width: '100%', maxWidth: 440 },
  dialogTitle: { margin: '0 0 0.75rem', fontSize: '1.125rem', fontWeight: 600, color: '#f1f5f9' },
  dialogText: { margin: '0 0 1rem', fontSize: '0.875rem', color: '#94a3b8' },
  dialogChanges: { padding: '0.75rem', background: 'rgba(255,255,255,0.03)', borderRadius: 6, border: '1px solid rgba(255,255,255,0.06)', marginBottom: '1.25rem' },
  changeItem: { margin: '0 0 0.25rem', fontSize: '0.8rem', color: '#e2e8f0' },
  dialogActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem' },
  cancelButton: { padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  confirmButton: { padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
};
