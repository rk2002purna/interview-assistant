import { useState, useEffect, useCallback, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../../api/client';

interface RoutingConfig {
  textPrimary: { provider: string; model: string };
  textFallback: { provider: string; model: string };
  visionPrimary: { provider: string; model: string };
  visionFallback: { provider: string; model: string };
}

const MODEL_CATALOG: Record<string, { text: { id: string; label: string }[]; vision: { id: string; label: string }[] }> = {
  gemini: {
    text: [
      { id: 'gemini-flash-latest', label: 'gemini-flash-latest — Newest Flash' },
      { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash' },
      { id: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
    ],
    vision: [
      { id: 'gemini-flash-latest', label: 'gemini-flash-latest (vision)' },
      { id: 'gemini-3.5-flash', label: 'gemini-3.5-flash (vision)' },
      { id: 'gemini-3-pro-preview', label: 'gemini-3-pro-preview (vision)' },
      { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (vision)' },
      { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro (vision)' },
    ],
  },
  groq: {
    text: [
      { id: 'llama-3.3-70b-versatile', label: 'llama-3.3-70b-versatile (recommended)' },
      { id: 'llama-3.1-8b-instant', label: 'llama-3.1-8b-instant — Fastest' },
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'llama-4-scout-17b' },
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'llama-4-maverick-17b' },
    ],
    vision: [
      { id: 'meta-llama/llama-4-scout-17b-16e-instruct', label: 'llama-4-scout-17b (vision)' },
      { id: 'meta-llama/llama-4-maverick-17b-128e-instruct', label: 'llama-4-maverick-17b (vision)' },
    ],
  },
  deepseek: {
    text: [
      { id: 'deepseek-chat', label: 'deepseek-chat (V3)' },
      { id: 'deepseek-reasoner', label: 'deepseek-reasoner (R1)' },
    ],
    vision: [],
  },
  cerebras: {
    text: [
      { id: 'gpt-oss-120b', label: 'gpt-oss-120b — Cerebras (ultra-fast)' },
    ],
    vision: [],
  },
};

const PROVIDERS = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'groq', label: 'Groq' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'deepseek', label: 'DeepSeek' },
];

const VISION_PROVIDERS = [
  { value: 'gemini', label: 'Gemini' },
  { value: 'groq', label: 'Groq' },
];

function getModels(provider: string, capability: 'text' | 'vision') {
  return MODEL_CATALOG[provider]?.[capability] ?? [];
}

export default function ModelRoutingPage() {
  const [config, setConfig] = useState<RoutingConfig>({
    textPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
    textFallback: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
    visionPrimary: { provider: 'gemini', model: 'gemini-flash-latest' },
    visionFallback: { provider: 'groq', model: 'meta-llama/llama-4-scout-17b-16e-instruct' },
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const fetchConfig = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const data = await apiRequest<{ routing: RoutingConfig }>('/admin/model-routing');
      if (data.routing) setConfig(data.routing);
    } catch (err) {
      if (!(err instanceof ApiClientError && err.status === 404)) {
        setError(err instanceof Error ? err.message : 'Failed to load config');
      }
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchConfig(); }, [fetchConfig]);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      await apiRequest('/admin/model-routing', { method: 'PUT', body: { routing: config } });
      setSuccess('Model routing configuration saved successfully.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to save configuration.');
    } finally { setSaving(false); }
  }

  function updateProvider(section: keyof RoutingConfig, provider: string) {
    const capability = section.startsWith('vision') ? 'vision' : 'text';
    const models = getModels(provider, capability);
    setConfig((prev) => ({ ...prev, [section]: { provider, model: models[0]?.id ?? '' } }));
  }

  function updateModel(section: keyof RoutingConfig, model: string) {
    setConfig((prev) => ({ ...prev, [section]: { ...prev[section], model } }));
  }

  if (loading) return <div><p style={{ color: '#64748b' }}>Loading model routing config…</p></div>;

  return (
    <div>
      <h1 style={s.title}>Model Routing</h1>
      <p style={s.subtitle}>Configure which AI models are used for all users. Changes apply globally.</p>

      {error && <div role="alert" style={s.error}>{error}</div>}
      {success && <div role="status" style={s.success}>{success}</div>}

      <form onSubmit={handleSave}>
        {/* Text Section */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>Text Q&A Model (Manual / Passive)</h2>
          <div style={s.fieldRow}>
            <div style={s.field}>
              <label style={s.label}>Primary Provider</label>
              <select value={config.textPrimary.provider} onChange={(e) => updateProvider('textPrimary', e.target.value)} style={s.select}>
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Primary Model</label>
              <select value={config.textPrimary.model} onChange={(e) => updateModel('textPrimary', e.target.value)} style={s.select}>
                {getModels(config.textPrimary.provider, 'text').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div style={s.fieldRow}>
            <div style={s.field}>
              <label style={s.label}>Fallback Provider <span style={{ color: '#64748b' }}>(used if primary fails)</span></label>
              <select value={config.textFallback.provider} onChange={(e) => updateProvider('textFallback', e.target.value)} style={s.select}>
                <option value="">— None —</option>
                {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Fallback Model</label>
              <select value={config.textFallback.model} onChange={(e) => updateModel('textFallback', e.target.value)}
                style={s.select} disabled={!config.textFallback.provider}>
                {getModels(config.textFallback.provider, 'text').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <p style={s.hint}>If the primary returns an error (rate limit, quota, outage), the fallback is tried automatically.</p>
        </div>

        {/* Vision Section */}
        <div style={s.section}>
          <h2 style={s.sectionTitle}>Screen Analyzer Model (Vision)</h2>
          <div style={s.fieldRow}>
            <div style={s.field}>
              <label style={s.label}>Primary Provider</label>
              <select value={config.visionPrimary.provider} onChange={(e) => updateProvider('visionPrimary', e.target.value)} style={s.select}>
                {VISION_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Primary Model</label>
              <select value={config.visionPrimary.model} onChange={(e) => updateModel('visionPrimary', e.target.value)} style={s.select}>
                {getModels(config.visionPrimary.provider, 'vision').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <div style={s.fieldRow}>
            <div style={s.field}>
              <label style={s.label}>Fallback Provider</label>
              <select value={config.visionFallback.provider} onChange={(e) => updateProvider('visionFallback', e.target.value)} style={s.select}>
                <option value="">— None —</option>
                {VISION_PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </div>
            <div style={s.field}>
              <label style={s.label}>Fallback Model</label>
              <select value={config.visionFallback.model} onChange={(e) => updateModel('visionFallback', e.target.value)}
                style={s.select} disabled={!config.visionFallback.provider}>
                {getModels(config.visionFallback.provider, 'vision').map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
              </select>
            </div>
          </div>
          <p style={s.hint}>DeepSeek and Cerebras don't support vision. Use Gemini or Groq for screen analysis.</p>
        </div>

        <button type="submit" disabled={saving} style={s.button}>{saving ? 'Saving…' : 'Save Model Routing'}</button>
      </form>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b' },
  section: { background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '1.25rem', marginBottom: '1.5rem' },
  sectionTitle: { margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600, color: '#f1f5f9' },
  fieldRow: { display: 'flex', gap: '1rem', marginBottom: '1rem', flexWrap: 'wrap' },
  field: { flex: 1, minWidth: 200, display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  label: { fontSize: '0.8125rem', fontWeight: 500, color: '#94a3b8' },
  select: { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '0.875rem', color: '#f1f5f9' },
  hint: { fontSize: '0.8rem', color: '#64748b', margin: '0.5rem 0 0' },
  button: { padding: '0.625rem 1.25rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '1rem', fontWeight: 500, cursor: 'pointer' },
  error: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  success: { padding: '0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, color: '#4ade80', fontSize: '0.875rem', marginBottom: '1rem' },
};
