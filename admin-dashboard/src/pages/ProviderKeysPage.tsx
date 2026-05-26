import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../api/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ProviderKey {
  provider: string;
  masked: string;
  last4: string;
  version: number;
  created_at: string;
  updated_at: string;
}

const PROVIDERS = ['gemini', 'groq', 'deepseek', 'cerebras'] as const;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProviderKeysPage() {
  const [keys, setKeys] = useState<ProviderKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  // Create form state
  const [showCreateForm, setShowCreateForm] = useState(false);
  const [createProvider, setCreateProvider] = useState<string>(PROVIDERS[0]);
  const [createKeyValue, setCreateKeyValue] = useState('');
  const [createError, setCreateError] = useState('');
  const [createLoading, setCreateLoading] = useState(false);

  // Rotate state
  const [rotateProvider, setRotateProvider] = useState<string | null>(null);
  const [rotateKeyValue, setRotateKeyValue] = useState('');
  const [rotateError, setRotateError] = useState('');
  const [rotateLoading, setRotateLoading] = useState(false);

  // Delete confirmation state
  const [deleteProvider, setDeleteProvider] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // -------------------------------------------------------------------------
  // Fetch keys
  // -------------------------------------------------------------------------

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ provider_keys: ProviderKey[] }>(
        '/admin/provider-keys',
      );
      setKeys(data.provider_keys);
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to load provider keys.');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchKeys();
  }, [fetchKeys]);

  // -------------------------------------------------------------------------
  // Create key
  // -------------------------------------------------------------------------

  async function handleCreate(e: FormEvent) {
    e.preventDefault();
    setCreateError('');
    setCreateLoading(true);
    try {
      await apiRequest<{ provider_key: ProviderKey }>('/admin/provider-keys', {
        method: 'POST',
        body: { provider: createProvider, key: createKeyValue },
      });
      setCreateKeyValue('');
      setShowCreateForm(false);
      await fetchKeys();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setCreateError(err.message);
      } else {
        setCreateError('Failed to create provider key.');
      }
    } finally {
      setCreateLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Rotate key
  // -------------------------------------------------------------------------

  async function handleRotate(e: FormEvent) {
    e.preventDefault();
    if (!rotateProvider) return;
    setRotateError('');
    setRotateLoading(true);
    try {
      await apiRequest<{ provider_key: ProviderKey }>(
        `/admin/provider-keys/${rotateProvider}`,
        {
          method: 'PATCH',
          body: { key: rotateKeyValue },
        },
      );
      setRotateKeyValue('');
      setRotateProvider(null);
      await fetchKeys();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setRotateError(err.message);
      } else {
        setRotateError('Failed to rotate provider key.');
      }
    } finally {
      setRotateLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Delete key
  // -------------------------------------------------------------------------

  async function handleDelete() {
    if (!deleteProvider) return;
    setDeleteLoading(true);
    try {
      await apiRequest(`/admin/provider-keys/${deleteProvider}`, {
        method: 'DELETE',
      });
      setDeleteProvider(null);
      await fetchKeys();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to delete provider key.');
      }
    } finally {
      setDeleteLoading(false);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Providers that don't already have a key stored. */
  const availableProviders = PROVIDERS.filter(
    (p) => !keys.some((k) => k.provider === p),
  );

  function formatDate(iso: string): string {
    return new Date(iso).toLocaleString();
  }

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <h1 style={styles.title}>Provider Keys</h1>
        {availableProviders.length > 0 && (
          <button
            style={styles.primaryButton}
            onClick={() => {
              setCreateProvider(availableProviders[0]!);
              setShowCreateForm(true);
            }}
          >
            + Add Key
          </button>
        )}
      </div>

      {error && (
        <div role="alert" style={styles.errorBanner}>
          {error}
        </div>
      )}

      {loading ? (
        <p style={styles.loadingText}>Loading…</p>
      ) : keys.length === 0 ? (
        <p style={styles.emptyText}>
          No provider keys configured. Add a key to enable AI operations.
        </p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Provider</th>
              <th style={styles.th}>Key (masked)</th>
              <th style={styles.th}>Version</th>
              <th style={styles.th}>Created</th>
              <th style={styles.th}>Updated</th>
              <th style={styles.th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.provider} style={styles.tr}>
                <td style={styles.td}>
                  <span style={styles.providerBadge}>{k.provider}</span>
                </td>
                <td style={styles.td}>
                  <code style={styles.maskedKey}>
                    {k.masked}{k.last4}
                  </code>
                </td>
                <td style={styles.td}>{k.version}</td>
                <td style={styles.td}>{formatDate(k.created_at)}</td>
                <td style={styles.td}>{formatDate(k.updated_at)}</td>
                <td style={styles.td}>
                  <div style={styles.actions}>
                    <button
                      style={styles.actionButton}
                      onClick={() => {
                        setRotateProvider(k.provider);
                        setRotateKeyValue('');
                        setRotateError('');
                      }}
                    >
                      Rotate
                    </button>
                    <button
                      style={styles.dangerButton}
                      onClick={() => setDeleteProvider(k.provider)}
                    >
                      Delete
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Create Key Modal */}
      {showCreateForm && (
        <div style={styles.overlay} onClick={() => setShowCreateForm(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Add Provider Key</h2>
            <form onSubmit={handleCreate} style={styles.form}>
              {createError && (
                <div role="alert" style={styles.formError}>
                  {createError}
                </div>
              )}
              <div style={styles.field}>
                <label htmlFor="create-provider" style={styles.label}>
                  Provider
                </label>
                <select
                  id="create-provider"
                  value={createProvider}
                  onChange={(e) => setCreateProvider(e.target.value)}
                  disabled={createLoading}
                  style={styles.select}
                >
                  {availableProviders.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div style={styles.field}>
                <label htmlFor="create-key" style={styles.label}>
                  API Key
                </label>
                <input
                  id="create-key"
                  type="password"
                  value={createKeyValue}
                  onChange={(e) => setCreateKeyValue(e.target.value)}
                  required
                  minLength={1}
                  maxLength={512}
                  placeholder="Paste the provider API key"
                  disabled={createLoading}
                  style={styles.input}
                />
              </div>
              <div style={styles.modalActions}>
                <button
                  type="button"
                  style={styles.cancelButton}
                  onClick={() => setShowCreateForm(false)}
                  disabled={createLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={styles.primaryButton}
                  disabled={createLoading || !createKeyValue.trim()}
                >
                  {createLoading ? 'Creating…' : 'Create Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Rotate Key Modal */}
      {rotateProvider && (
        <div style={styles.overlay} onClick={() => setRotateProvider(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>
              Rotate Key: <span style={styles.providerBadge}>{rotateProvider}</span>
            </h2>
            <form onSubmit={handleRotate} style={styles.form}>
              {rotateError && (
                <div role="alert" style={styles.formError}>
                  {rotateError}
                </div>
              )}
              <div style={styles.field}>
                <label htmlFor="rotate-key" style={styles.label}>
                  New API Key
                </label>
                <input
                  id="rotate-key"
                  type="password"
                  value={rotateKeyValue}
                  onChange={(e) => setRotateKeyValue(e.target.value)}
                  required
                  minLength={1}
                  maxLength={512}
                  placeholder="Paste the new provider API key"
                  disabled={rotateLoading}
                  style={styles.input}
                />
              </div>
              <div style={styles.modalActions}>
                <button
                  type="button"
                  style={styles.cancelButton}
                  onClick={() => setRotateProvider(null)}
                  disabled={rotateLoading}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  style={styles.primaryButton}
                  disabled={rotateLoading || !rotateKeyValue.trim()}
                >
                  {rotateLoading ? 'Rotating…' : 'Rotate Key'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteProvider && (
        <div style={styles.overlay} onClick={() => setDeleteProvider(null)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Delete Provider Key</h2>
            <p style={styles.confirmText}>
              Are you sure you want to delete the{' '}
              <strong>{deleteProvider}</strong> provider key? This will disable
              AI operations for this provider until a new key is added.
            </p>
            <div style={styles.modalActions}>
              <button
                type="button"
                style={styles.cancelButton}
                onClick={() => setDeleteProvider(null)}
                disabled={deleteLoading}
              >
                Cancel
              </button>
              <button
                type="button"
                style={styles.dangerButton}
                onClick={handleDelete}
                disabled={deleteLoading}
              >
                {deleteLoading ? 'Deleting…' : 'Delete Key'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '960px',
    margin: '0 auto',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '1.5rem',
  },
  title: {
    margin: 0,
    fontSize: '1.5rem',
    fontWeight: 600,
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
  loadingText: {
    color: '#6b7280',
    textAlign: 'center',
    padding: '2rem',
  },
  emptyText: {
    color: '#6b7280',
    textAlign: 'center',
    padding: '2rem',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(0, 0, 0, 0.1)',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem 1rem',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '0.75rem',
    fontWeight: 600,
    textTransform: 'uppercase',
    color: '#6b7280',
  },
  tr: {
    borderBottom: '1px solid #f3f4f6',
  },
  td: {
    padding: '0.75rem 1rem',
    fontSize: '0.875rem',
    verticalAlign: 'middle',
  },
  providerBadge: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#eff6ff',
    color: '#1d4ed8',
    borderRadius: '4px',
    fontSize: '0.8125rem',
    fontWeight: 500,
    textTransform: 'capitalize',
  },
  maskedKey: {
    fontFamily: 'monospace',
    fontSize: '0.875rem',
    backgroundColor: '#f3f4f6',
    padding: '0.25rem 0.5rem',
    borderRadius: '4px',
  },
  actions: {
    display: 'flex',
    gap: '0.5rem',
  },
  actionButton: {
    padding: '0.375rem 0.75rem',
    backgroundColor: '#f3f4f6',
    border: '1px solid #d1d5db',
    borderRadius: '4px',
    fontSize: '0.8125rem',
    cursor: 'pointer',
    fontWeight: 500,
  },
  dangerButton: {
    padding: '0.375rem 0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '4px',
    fontSize: '0.8125rem',
    color: '#dc2626',
    cursor: 'pointer',
    fontWeight: 500,
  },
  primaryButton: {
    padding: '0.5rem 1rem',
    backgroundColor: '#2563eb',
    color: '#ffffff',
    border: 'none',
    borderRadius: '6px',
    fontSize: '0.875rem',
    fontWeight: 500,
    cursor: 'pointer',
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
  // Modal styles
  overlay: {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    backgroundColor: '#ffffff',
    borderRadius: '8px',
    padding: '1.5rem',
    width: '100%',
    maxWidth: '440px',
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
  },
  modalTitle: {
    margin: '0 0 1rem',
    fontSize: '1.125rem',
    fontWeight: 600,
  },
  modalActions: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '0.75rem',
    marginTop: '1.25rem',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '1rem',
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
  },
  label: {
    fontSize: '0.875rem',
    fontWeight: 500,
    color: '#374151',
  },
  input: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '1rem',
    outline: 'none',
  },
  select: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '1rem',
    outline: 'none',
    backgroundColor: '#ffffff',
  },
  formError: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
  },
  confirmText: {
    fontSize: '0.875rem',
    color: '#374151',
    lineHeight: 1.5,
  },
};
