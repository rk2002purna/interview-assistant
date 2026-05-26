import { useState, type FormEvent } from 'react';
import { apiRequest, ApiClientError } from '../api/client';

interface RateLimitOverrides {
  ai_per_minute: number | null;
  ai_per_day: number | null;
  session_start_per_hour: number | null;
}

const MIN_VALUE = 0;
const MAX_VALUE = 100000;

function isValidOverrideValue(value: string): boolean {
  if (value === '') return true; // empty means "clear override"
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
    if (!userId.trim()) {
      return 'User ID is required.';
    }
    if (!aiPerMinute && !aiPerDay && !sessionStartPerHour) {
      return 'At least one override field must be provided.';
    }
    if (aiPerMinute && !isValidOverrideValue(aiPerMinute)) {
      return `AI requests per minute must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    }
    if (aiPerDay && !isValidOverrideValue(aiPerDay)) {
      return `AI requests per day must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    }
    if (sessionStartPerHour && !isValidOverrideValue(sessionStartPerHour)) {
      return `Session starts per hour must be an integer between ${MIN_VALUE} and ${MAX_VALUE}.`;
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setSuccess('');

    const validationError = getValidationError();
    if (validationError) {
      setError(validationError);
      return;
    }

    setLoading(true);

    const body: Record<string, number | null> = {};
    if (aiPerMinute !== '') {
      body.ai_per_minute = Number(aiPerMinute);
    }
    if (aiPerDay !== '') {
      body.ai_per_day = Number(aiPerDay);
    }
    if (sessionStartPerHour !== '') {
      body.session_start_per_hour = Number(sessionStartPerHour);
    }

    try {
      const result = await apiRequest<{ ok: boolean; overrides: RateLimitOverrides }>(
        `/admin/rate-limits/${userId.trim()}`,
        { method: 'PATCH', body },
      );
      setCurrentOverrides(result.overrides);
      setSuccess('Rate limit overrides updated successfully.');
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(err.message);
      } else {
        setError('An unexpected error occurred.');
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <h1 style={styles.title}>Rate Limit Overrides</h1>
        <p style={styles.subtitle}>
          Set per-user rate limit overrides. Leave a field empty to keep the current value unchanged.
          Values must be integers between {MIN_VALUE} and {MAX_VALUE.toLocaleString()}.
        </p>

        <form onSubmit={handleSubmit} style={styles.form}>
          {error && (
            <div role="alert" style={styles.error}>
              {error}
            </div>
          )}
          {success && (
            <div role="status" style={styles.success}>
              {success}
            </div>
          )}

          <div style={styles.field}>
            <label htmlFor="userId" style={styles.label}>
              User ID
            </label>
            <input
              id="userId"
              type="text"
              value={userId}
              onChange={(e) => setUserId(e.target.value)}
              required
              placeholder="e.g. 550e8400-e29b-41d4-a716-446655440000"
              disabled={loading}
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="aiPerMinute" style={styles.label}>
              AI Requests per Minute
            </label>
            <input
              id="aiPerMinute"
              type="number"
              value={aiPerMinute}
              onChange={(e) => setAiPerMinute(e.target.value)}
              min={MIN_VALUE}
              max={MAX_VALUE}
              step={1}
              placeholder="Default: 60"
              disabled={loading}
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="aiPerDay" style={styles.label}>
              AI Requests per Day
            </label>
            <input
              id="aiPerDay"
              type="number"
              value={aiPerDay}
              onChange={(e) => setAiPerDay(e.target.value)}
              min={MIN_VALUE}
              max={MAX_VALUE}
              step={1}
              placeholder="Default: 1000"
              disabled={loading}
              style={styles.input}
            />
          </div>

          <div style={styles.field}>
            <label htmlFor="sessionStartPerHour" style={styles.label}>
              Session Starts per Hour
            </label>
            <input
              id="sessionStartPerHour"
              type="number"
              value={sessionStartPerHour}
              onChange={(e) => setSessionStartPerHour(e.target.value)}
              min={MIN_VALUE}
              max={MAX_VALUE}
              step={1}
              placeholder="Default: 5"
              disabled={loading}
              style={styles.input}
            />
          </div>

          <button type="submit" disabled={loading} style={styles.button}>
            {loading ? 'Saving…' : 'Save Overrides'}
          </button>
        </form>

        {currentOverrides && (
          <div style={styles.resultSection}>
            <h2 style={styles.resultTitle}>Current Overrides</h2>
            <table style={styles.table}>
              <thead>
                <tr>
                  <th style={styles.th}>Limit</th>
                  <th style={styles.th}>Value</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style={styles.td}>AI Requests per Minute</td>
                  <td style={styles.td}>
                    {currentOverrides.ai_per_minute !== null
                      ? currentOverrides.ai_per_minute
                      : '(default)'}
                  </td>
                </tr>
                <tr>
                  <td style={styles.td}>AI Requests per Day</td>
                  <td style={styles.td}>
                    {currentOverrides.ai_per_day !== null
                      ? currentOverrides.ai_per_day
                      : '(default)'}
                  </td>
                </tr>
                <tr>
                  <td style={styles.td}>Session Starts per Hour</td>
                  <td style={styles.td}>
                    {currentOverrides.session_start_per_hour !== null
                      ? currentOverrides.session_start_per_hour
                      : '(default)'}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </div>
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
    maxWidth: '560px',
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
    lineHeight: 1.5,
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
  },
  success: {
    padding: '0.75rem',
    backgroundColor: '#f0fdf4',
    border: '1px solid #bbf7d0',
    borderRadius: '6px',
    color: '#16a34a',
    fontSize: '0.875rem',
  },
  resultSection: {
    marginTop: '1.5rem',
    paddingTop: '1.5rem',
    borderTop: '1px solid #e5e7eb',
  },
  resultTitle: {
    margin: '0 0 0.75rem',
    fontSize: '1.125rem',
    fontWeight: 600,
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
  },
  th: {
    textAlign: 'left',
    padding: '0.5rem 0.75rem',
    borderBottom: '2px solid #e5e7eb',
    fontSize: '0.875rem',
    fontWeight: 600,
    color: '#374151',
  },
  td: {
    padding: '0.5rem 0.75rem',
    borderBottom: '1px solid #f3f4f6',
    fontSize: '0.875rem',
    color: '#4b5563',
  },
};
