import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../../api/client';

interface ProviderKey { provider: string; masked: string; last4: string; version: number; created_at: string; updated_at: string; }

const PROVIDERS = ['gemini', 'groq', 'deepseek', 'cerebras', 'digitalocean'] as const;

export default function ProviderKeysPage() {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createProvider, setCreateProvider] = useState<string>(PROVIDERS[0]);
  const [createKeyValue, setCreateKeyValue] = useState('');
  const [createError, setCreateError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);
  const [rotateProvider, setRotateProvider] = useState<string | null>(null);
  const [rotateKeyValue, setRotateKeyValue] = useState('');
  const [rotateError, setRotateError] = useState('');
  const [rotateLoading, setRotateLoading] = useState(false);
  const [deleteProvider, setDeleteProvider] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ provider_keys: ProviderKey[] }>('/admin/provider-keys');
      setKeys(data.provider_keys);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load provider keys.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchKeys(); }, [fetchKeys]);

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreateLoading(true);
    try {
      await apiRequest<{ provider_key: ProviderKey }>('/admin/provider-keys', { method: 'POST', body: { provider: createProvider, key: createKeyValue } });
      setCreateKeyValue('');
      setShowCreateForm(false);
      await fetchKeys();
    } catch (err) {
      setCreateError(err instanceof ApiClientError ? err.message : 'Failed to create provider key.');
    } finally { setCreateLoading(false); }
  }

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    if (!rotateProvider) return;
    setRotateError('');
    setRotateLoading(true);
    try {
      await apiRequest<{ provider_key: ProviderKey }>(`/admin/provider-keys/${rotateProvider}`, { method: 'PATCH', body: { key: rotateKeyValue } });
      setRotateKeyValue('');
      setRotateProvider(null);
      await fetchKeys();
    } catch (err) {
      setRotateError(err instanceof ApiClientError ? err.message : 'Failed to rotate provider key.');
    } finally { setRotateLoading(false); }
  }

  async function handleDelete() {
    if (!deleteProvider) return;
    setDeleteLoading(true);
    try {
      await apiRequest(`/admin/provider-keys/${deleteProvider}`, { method: 'DELETE' });
      setDeleteProvider(null);
      await fetchKeys();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to delete provider key.');
    } finally { setDeleteLoading(false); }
  }

  const availableProviders = PROVIDERS.filter((p) => !keys.some((k) => k.provider === p));

  return (
    <div>
      <div style={s.header}>
        <h1 style={s.title}>Provider Keys</h1>
        {availableProviders.length > 0 && (
          <button style={s.primaryButton} onClick={() => { setCreateProvider(availableProviders[0]!); setShowCreateForm(true); }}>+ Add Key</button>
        )}
      </div>

      {error && <div role="alert" style={s.errorBanner}>{error}</div>}

      {loading ? <p style={s.loadingText}>Loading…</p>
        : keys.length === 0 ? <p style={s.emptyText}>No provider keys configured. Add a key to enable AI operations.</p>
        : (
          <table style={s.table}>
            <thead>
              <tr><th style={s.th}>Provider</th><th style={s.th}>Key (masked)</th><th style={s.th}>Version</th><th style={s.th}>Created</th><th style={s.th}>Updated</th><th style={s.th}>Actions</th></tr>
            </thead>
            <tbody>
              {keys.map((k) => (
                <tr key={k.provider} style={s.tr}>
                  <td style={s.td}><span style={s.providerBadge}>{k.provider}</span></td>
                  <td style={s.td}><code style={s.maskedKey}>{k.masked}{k.last4}</code></td>
                  <td style={s.td}>{k.version}</td>
                  <td style={s.td}>{new Date(k.created_at).toLocaleString()}</td>
                  <td style={s.td}>{new Date(k.updated_at).toLocaleString()}</td>
                  <td style={s.td}>
                    <div style={s.actions}>
                      <button style={s.actionButton} onClick={() => { setRotateProvider(k.provider); setRotateKeyValue(''); setRotateError(''); }}>Rotate</button>
                      <button style={s.dangerButton} onClick={() => setDeleteProvider(k.provider)}>Delete</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

      {/* Create Key Modal */}
      {showCreateForm && (
        <div style={s.overlay} onClick={() => setShowCreateForm(false)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={s.modalTitle}>Add Provider Key</h2>
            <form onSubmit={handleCreate} style={s.form}>
              {createError && <div role="alert" style={s.formError}>{createError}</div>}
              <div style={s.field}>
                <label htmlFor="create-provider" style={s.label}>Provider</label>
                <select id="create-provider" value={createProvider} onChange={(e) => setCreateProvider(e.target.value)} disabled={createLoading} style={s.select}>
                  {availableProviders.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
              <div style={s.field}>
                <label htmlFor="create-key" style={s.label}>API Key</label>
                <input id="create-key" type="password" value={createKeyValue} onChange={(e) => setCreateKeyValue(e.target.value)}
                  required minLength={1} maxLength={512} placeholder="Paste the provider API key" disabled={createLoading} style={s.input} />
              </div>
              <div style={s.modalActions}>
                <button type="button" style={s.cancelButton} onClick={() => setShowCreateForm(false)} disabled={createLoading}>Cancel</button>
                <button type="submit" style={s.primaryButton} disabled={createLoading || !createKeyValue.trim()}>{createLoading ? 'Creating…' : 'Create Key'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rotate Key Modal */}
      {rotateProvider && (
        <div style={s.overlay} onClick={() => setRotateProvider(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={s.modalTitle}>Rotate Key: <span style={s.providerBadge}>{rotateProvider}</span></h2>
            <form onSubmit={handleRotate} style={s.form}>
              {rotateError && <div role="alert" style={s.formError}>{rotateError}</div>}
              <div style={s.field}>
                <label htmlFor="rotate-key" style={s.label}>New API Key</label>
                <input id="rotate-key" type="password" value={rotateKeyValue} onChange={(e) => setRotateKeyValue(e.target.value)}
                  required minLength={1} maxLength={512} placeholder="Paste the new provider API key" disabled={rotateLoading} style={s.input} />
              </div>
              <div style={s.modalActions}>
                <button type="button" style={s.cancelButton} onClick={() => setRotateProvider(null)} disabled={rotateLoading}>Cancel</button>
                <button type="submit" style={s.primaryButton} disabled={rotateLoading || !rotateKeyValue.trim()}>{rotateLoading ? 'Rotating…' : 'Rotate Key'}</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteProvider && (
        <div style={s.overlay} onClick={() => setDeleteProvider(null)}>
          <div style={s.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={s.modalTitle}>Delete Provider Key</h2>
            <p style={s.confirmText}>Are you sure you want to delete the <strong>{deleteProvider}</strong> provider key? This will disable AI operations for this provider until a new key is added.</p>
            <div style={s.modalActions}>
              <button type="button" style={s.cancelButton} onClick={() => setDeleteProvider(null)} disabled={deleteLoading}>Cancel</button>
              <button type="button" style={s.dangerButton} onClick={handleDelete} disabled={deleteLoading}>{deleteLoading ? 'Deleting…' : 'Delete Key'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' },
  title: { margin: 0, fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  errorBanner: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  loadingText: { color: '#64748b', textAlign: 'center', padding: '2rem' },
  emptyText: { color: '#64748b', textAlign: 'center', padding: '2rem' },
  table: { width: '100%', borderCollapse: 'collapse', borderRadius: 8, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.06)' },
  th: { textAlign: 'left', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontSize: '0.75rem', fontWeight: 600, textTransform: 'uppercase', color: '#64748b' },
  tr: { borderBottom: '1px solid rgba(255,255,255,0.04)' },
  td: { padding: '0.75rem 1rem', fontSize: '0.875rem', verticalAlign: 'middle', color: '#e2e8f0' },
  providerBadge: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(59,130,246,0.15)', color: '#60a5fa', borderRadius: 4, fontSize: '0.8125rem', fontWeight: 500, textTransform: 'capitalize' },
  maskedKey: { fontFamily: 'monospace', fontSize: '0.875rem', background: 'rgba(255,255,255,0.05)', padding: '0.25rem 0.5rem', borderRadius: 4, color: '#cbd5e1' },
  actions: { display: 'flex', gap: '0.5rem' },
  actionButton: { padding: '0.375rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 4, fontSize: '0.8125rem', cursor: 'pointer', fontWeight: 500, color: '#94a3b8' },
  dangerButton: { padding: '0.375rem 0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 4, fontSize: '0.8125rem', color: '#fca5a5', cursor: 'pointer', fontWeight: 500 },
  primaryButton: { padding: '0.5rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  cancelButton: { padding: '0.5rem 1rem', background: 'rgba(255,255,255,0.05)', color: '#94a3b8', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', fontWeight: 500, cursor: 'pointer' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal: { background: '#111827', borderRadius: 8, padding: '1.5rem', width: '100%', maxWidth: 440, border: '1px solid rgba(255,255,255,0.08)' },
  modalTitle: { margin: '0 0 1rem', fontSize: '1.125rem', fontWeight: 600, color: '#f1f5f9' },
  modalActions: { display: 'flex', justifyContent: 'flex-end', gap: '0.75rem', marginTop: '1.25rem' },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  label: { fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' },
  input: { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '1rem', color: '#f1f5f9', outline: 'none' },
  select: { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '1rem', color: '#f1f5f9', outline: 'none' },
  formError: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem' },
  confirmText: { fontSize: '0.875rem', color: '#94a3b8', lineHeight: 1.5 },
};
