import { useState, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../../api/client';

interface RateLimitOverrides { ai_per_minute: number | null; ai_per_day: number | null; session_start_per_hour: number | null; }

const MIN_VALUE = 0;
const MAX_VALUE = 100000;

function isValidOverrideValue(value: string): boolean {
  if (value === '') return true;
  const num = Number(value);
  return Number.isInteger(num) && num >= MIN_VALUE && num <= MAX_VALUE;
}

export default function RateLimitsPage() {
  const [userId, setUserId] = useState('');
  const [aiPerMinute, setAiPerMinute] = useState('');
  const [aiPerDay, setAiPerDay] = useState('');
  const [sessionStartPerHour, setSessionStartPerHour] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [currentOverrides, setCurrentOverrides] = useState<RateLimitOverrides | null>(null);

  function getValidationError(): string | null {
    if (!userId.trim()) return 'User ID is required.';
    if (!aiPerMinute && !aiPerDay && !sessionStartPerHour) return 'At least one override field must be provided.';
    if (aiPerMinute && !isValidOverrideValue(aiPerMinute)) return `AI requests per minute must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    if (aiPerDay && !isValidOverrideValue(aiPerDay)) return `AI requests per day must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    if (sessionStartPerHour && !isValidOverrideValue(sessionStartPerHour)) return `Session starts per hour must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');
    const validationError = getValidationError();
    if (validationError) { setError(validationError); return; }
    setLoading(true);
    const body: Record<string, number | null> = {};
    if (aiPerMinute !== '') body.ai_per_minute = Number(aiPerMinute);
    if (aiPerDay !== '') body.ai_per_day = Number(aiPerDay);
    if (sessionStartPerHour !== '') body.session_start_per_hour = Number(sessionStartPerHour);
    try {
      const result = await apiRequest<{ ok: boolean; overrides: RateLimitOverrides }>(`/admin/rate-limits/${userId.trim()}`, { method: 'PATCH', body });
      setCurrentOverrides(result.overrides);
      setSuccess('Rate limit overrides updated successfully.');
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'An unexpected error occurred.');
    } finally { setLoading(false); }
  }

  return (
    <div style={s.card}>
      <h1 style={s.title}>Rate Limit Overrides</h1>
      <p style={s.subtitle}>Set per-user rate limit overrides. Leave a field empty to keep the current value unchanged. Values must be integers between {MIN_VALUE} and {MAX_VALUE.toLocaleString()}.</p>

      <form onSubmit={handleSubmit} style={s.form}>
        {error && <div role="alert" style={s.error}>{error}</div>}
        {success && <div role="status" style={s.success}>{success}</div>}

        <div style={s.field}>
          <label htmlFor="userId" style={s.label}>User ID</label>
          <input id="userId" type="text" value={userId} onChange={(e) => setUserId(e.target.value)}
            required placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000" disabled={loading} style={s.input} />
        </div>
        <div style={s.field}>
          <label htmlFor="aiPerMinute" style={s.label}>AI Requests per Minute</label>
          <input id="aiPerMinute" type="number" value={aiPerMinute} onChange={(e) => setAiPerMinute(e.target.value)}
            min={MIN_VALUE} max={MAX_VALUE} step={1} placeholder="Default: 60" disabled={loading} style={s.input} />
        </div>
        <div style={s.field}>
          <label htmlFor="aiPerDay" style={s.label}>AI Requests per Day</label>
          <input id="aiPerDay" type="number" value={aiPerDay} onChange={(e) => setAiPerDay(e.target.value)}
            min={MIN_VALUE} max={MAX_VALUE} step={1} placeholder="Default: 1000" disabled={loading} style={s.input} />
        </div>
        <div style={s.field}>
          <label htmlFor="sessionStartPerHour" style={s.label}>Session Starts per Hour</label>
          <input id="sessionStartPerHour" type="number" value={sessionStartPerHour} onChange={(e) => setSessionStartPerHour(e.target.value)}
            min={MIN_VALUE} max={MAX_VALUE} step={1} placeholder="Default: 5" disabled={loading} style={s.input} />
        </div>
        <button type="submit" disabled={loading} style={s.button}>{loading ? 'Saving…' : 'Save Overrides'}</button>
      </form>

      {currentOverrides && (
        <div style={s.resultSection}>
          <h2 style={s.resultTitle}>Current Overrides</h2>
          <table style={s.resultTable}>
            <thead><tr><th style={s.rth}>Limit</th><th style={s.rth}>Value</th></tr></thead>
            <tbody>
              <tr><td style={s.rtd}>AI Requests per Minute</td><td style={s.rtd}>{currentOverrides.ai_per_minute !== null ? currentOverrides.ai_per_minute : '(default)'}</td></tr>
              <tr><td style={s.rtd}>AI Requests per Day</td><td style={s.rtd}>{currentOverrides.ai_per_day !== null ? currentOverrides.ai_per_day : '(default)'}</td></tr>
              <tr><td style={s.rtd}>Session Starts per Hour</td><td style={s.rtd}>{currentOverrides.session_start_per_hour !== null ? currentOverrides.session_start_per_hour : '(default)'}</td></tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  card: { background: 'rgba(255,255,255,0.02)', borderRadius: 8, border: '1px solid rgba(255,255,255,0.06)', padding: '2rem', maxWidth: 560 },
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b', lineHeight: 1.5 },
  form: { display: 'flex', flexDirection: 'column', gap: '1rem' },
  field: { display: 'flex', flexDirection: 'column', gap: '0.25rem' },
  label: { fontSize: '0.875rem', fontWeight: 500, color: '#94a3b8' },
  input: { padding: '0.5rem 0.75rem', background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, fontSize: '1rem', color: '#f1f5f9', outline: 'none' },
  button: { marginTop: '0.5rem', padding: '0.625rem 1rem', background: '#3b82f6', color: '#fff', border: 'none', borderRadius: 6, fontSize: '1rem', fontWeight: 500, cursor: 'pointer' },
  error: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem' },
  success: { padding: '0.75rem', background: 'rgba(34,197,94,0.1)', border: '1px solid rgba(34,197,94,0.3)', borderRadius: 6, color: '#4ade80', fontSize: '0.875rem' },
  resultSection: { marginTop: '1.5rem', paddingTop: '1.5rem', borderTop: '1px solid rgba(255,255,255,0.06)' },
  resultTitle: { margin: '0 0 0.75rem', fontSize: '1.125rem', fontWeight: 600, color: '#f1f5f9' },
  resultTable: { width: '100%', borderCollapse: 'collapse' },
  rth: { textAlign: 'left', padding: '0.5rem 0.75rem', borderBottom: '2px solid rgba(255,255,255,0.06)', fontSize: '0.875rem', fontWeight: 600, color: '#94a3b8' },
  rtd: { padding: '0.5rem 0.75rem', borderBottom: '1px solid rgba(255,255,255,0.04)', fontSize: '0.875rem', color: '#e2e8f0' },
};
