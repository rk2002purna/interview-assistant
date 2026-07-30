import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../api/client';

/**
 * Admin-only Speech-to-Text (STT) model configuration page.
 *
 * All transcription runs on Groq's Whisper API, so these are Groq-hosted
 * Whisper model IDs. The selection is stored on the backend and applied to
 * every desktop client's transcription requests.
 */

interface SttConfig {
  model: string;
}

const STT_MODELS: { id: string; label: string; hint: string }[] = [
  {
    id: 'whisper-large-v3-turbo',
    label: '⚡ whisper-large-v3-turbo — Fast & low cost (recommended)',
    hint: 'Fastest and cheapest ($0.04/hr, ~12% WER). Recommended for real-time interviews.',
  },
  {
    id: 'whisper-large-v3',
    label: 'whisper-large-v3 — Most accurate',
    hint: 'Highest accuracy (10.3% WER) but pricier ($0.111/hr) and a bit slower.',
  },
];

const DEFAULT_MODEL = 'whisper-large-v3-turbo';

export default function SpeechToTextPage() {
  const [config, setConfig] = useState<SttConfig>({ model: DEFAULT_MODEL });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ stt: SttConfig }>('/admin/stt');
      if (data.stt?.model) {
        setConfig({ model: data.stt.model });
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 404) {
        // No config saved yet — use defaults.
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load config');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await apiRequest('/admin/stt', {
        method: 'PUT',
        body: { stt: config },
      });
      setSuccess('Speech-to-Text model saved successfully.');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('Failed to save configuration.');
      }
    } finally {
      setSaving(false);
    }
  }

  const selected = STT_MODELS.find((m) => m.id === config.model);

  if (loading) {
    return <div style={styles.container}><p>Loading speech-to-text config…</p></div>;
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Speech-to-Text</h1>
      <p style={styles.subtitle}>
        Choose the Groq Whisper model used to transcribe interview audio. Applies globally to all users.
      </p>

      {error && <div role="alert" style={styles.error}>{error}</div>}
      {success && <div role="status" style={styles.success}>{success}</div>}

      <form onSubmit={handleSave}>
        <div style={styles.section}>
          <h2 style={styles.sectionTitle}>🎙 Transcription Model (Groq Whisper)</h2>

          <div style={styles.field}>
            <label style={styles.label}>Whisper Model</label>
            <select
              value={config.model}
              onChange={(e) => setConfig({ model: e.target.value })}
              style={styles.select}
            >
              {STT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>{m.label}</option>
              ))}
            </select>
          </div>
          {selected && <p style={styles.hint}>{selected.hint}</p>}
          <p style={styles.hint}>
            Both models run on Groq's Whisper API. Transcription is pinned to English by the app, so either
            works for English-only interviews. (Groq's older distil-whisper-large-v3-en has been decommissioned.)
          </p>
        </div>

        <button type="submit" disabled={saving} style={styles.button}>
          {saving ? 'Saving…' : '💾 Save Speech-to-Text Model'}
        </button>
      </form>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { padding: '2rem', maxWidth: '800px', margin: '0 auto' },
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600 },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#6b7280' },
  section: {
    backgroundColor: '#f9fafb',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
    padding: '1.25rem',
    marginBottom: '1.5rem',
  },
  sectionTitle: { margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 },
  field: { display: 'flex', flexDirection: 'column' as const, gap: '0.25rem' },
  label: { fontSize: '0.8125rem', fontWeight: 500, color: '#374151' },
  select: {
    padding: '0.5rem 0.75rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    fontSize: '0.875rem',
    backgroundColor: '#fff',
  },
  hint: { fontSize: '0.8rem', color: '#6b7280', margin: '0.5rem 0 0' },
  button: {
    padding: '0.625rem 1.25rem',
    backgroundColor: '#2563eb',
    color: '#fff',
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
};
