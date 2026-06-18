import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../api/client';

interface AuditLogEntry {
  id: string;
  ts: string;
  actor: string | null;
  target: string | null;
  target_resource: string | null;
  event_type: string;
  outcome: string;
  reason_code: string | null;
  metadata: Record<string, unknown>;
}

interface AuditLogResponse {
  items: AuditLogEntry[];
  next_cursor: string | null;
}

const PAGE_SIZE = 50;

export default function AuditLogPage() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [cursorHistory, setCursorHistory] = useState<(string | null)[]>([null]);

  const fetchPage = useCallback(async (pageCursor: string | null) => {
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams();
      params.set('page_size', String(PAGE_SIZE));
      if (pageCursor) {
        params.set('cursor', pageCursor);
      }
      const data = await apiRequest<AuditLogResponse>(
        `/admin/audit-log?${params.toString()}`,
      );
      setEntries(data.items);
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : 'Failed to load audit log';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchPage(null);
  }, [fetchPage]);

  function handleNextPage() {
    if (!cursor) return;
    setCursorHistory((prev) => [...prev, cursor]);
    fetchPage(cursor);
  }

  function handlePrevPage() {
    if (cursorHistory.length <= 1) return;
    const newHistory = cursorHistory.slice(0, -1);
    setCursorHistory(newHistory);
    const prevCursor = newHistory[newHistory.length - 1] ?? null;
    fetchPage(prevCursor);
  }

  function formatTimestamp(ts: string): string {
    try {
      return new Date(ts).toLocaleString();
    } catch {
      return ts;
    }
  }

  function formatMetadata(metadata: Record<string, unknown>): string {
    if (!metadata || Object.keys(metadata).length === 0) return '—';
    return JSON.stringify(metadata, null, 2);
  }

  return (
    <div style={styles.container}>
      <h1 style={styles.title}>Audit Log</h1>
      <p style={styles.subtitle}>Read-only log of security and billing events</p>

      {error && (
        <div role="alert" style={styles.error}>
          {error}
        </div>
      )}

      <div style={styles.tableWrapper}>
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Timestamp</th>
              <th style={styles.th}>Actor</th>
              <th style={styles.th}>Event Type</th>
              <th style={styles.th}>Outcome</th>
              <th style={styles.th}>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr>
                <td colSpan={5} style={styles.emptyCell}>
                  Loading…
                </td>
              </tr>
            ) : entries.length === 0 ? (
              <tr>
                <td colSpan={5} style={styles.emptyCell}>
                  No audit log entries found.
                </td>
              </tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} style={styles.row}>
                  <td style={styles.td}>{formatTimestamp(entry.ts)}</td>
                  <td style={styles.td}>
                    <span style={styles.mono}>
                      {entry.actor ? entry.actor.slice(0, 8) + '…' : '—'}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <span style={styles.badge}>{entry.event_type}</span>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.outcomeBadge,
                        backgroundColor:
                          entry.outcome === 'success'
                            ? '#dcfce7'
                            : entry.outcome === 'failure'
                              ? '#fef2f2'
                              : '#f3f4f6',
                        color:
                          entry.outcome === 'success'
                            ? '#166534'
                            : entry.outcome === 'failure'
                              ? '#991b1b'
                              : '#374151',
                      }}
                    >
                      {entry.outcome}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <pre style={styles.metadata}>
                      {formatMetadata(entry.metadata)}
                    </pre>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={styles.pagination}>
        <button
          onClick={handlePrevPage}
          disabled={cursorHistory.length <= 1 || loading}
          style={styles.pageButton}
        >
          ← Previous
        </button>
        <span style={styles.pageInfo}>
          {loading ? 'Loading…' : `${entries.length} entries`}
        </span>
        <button
          onClick={handleNextPage}
          disabled={!hasMore || loading}
          style={styles.pageButton}
        >
          Next →
        </button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: '2rem',
    maxWidth: '1200px',
    margin: '0 auto',
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
  error: {
    padding: '0.75rem',
    backgroundColor: '#fef2f2',
    border: '1px solid #fecaca',
    borderRadius: '6px',
    color: '#dc2626',
    fontSize: '0.875rem',
    marginBottom: '1rem',
  },
  tableWrapper: {
    overflowX: 'auto',
    border: '1px solid #e5e7eb',
    borderRadius: '8px',
  },
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: '0.875rem',
  },
  th: {
    textAlign: 'left',
    padding: '0.75rem 1rem',
    backgroundColor: '#f9fafb',
    borderBottom: '1px solid #e5e7eb',
    fontWeight: 600,
    color: '#374151',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '0.75rem 1rem',
    borderBottom: '1px solid #f3f4f6',
    verticalAlign: 'top',
  },
  row: {
    transition: 'background-color 0.1s',
  },
  emptyCell: {
    padding: '2rem',
    textAlign: 'center',
    color: '#6b7280',
  },
  mono: {
    fontFamily: 'monospace',
    fontSize: '0.8rem',
  },
  badge: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    backgroundColor: '#eff6ff',
    color: '#1d4ed8',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  outcomeBadge: {
    display: 'inline-block',
    padding: '0.125rem 0.5rem',
    borderRadius: '4px',
    fontSize: '0.75rem',
    fontWeight: 500,
  },
  metadata: {
    margin: 0,
    fontSize: '0.75rem',
    fontFamily: 'monospace',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-all',
    maxWidth: '300px',
    maxHeight: '80px',
    overflow: 'auto',
  },
  pagination: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: '1rem',
    padding: '0.5rem 0',
  },
  pageButton: {
    padding: '0.5rem 1rem',
    border: '1px solid #d1d5db',
    borderRadius: '6px',
    backgroundColor: '#ffffff',
    fontSize: '0.875rem',
    cursor: 'pointer',
  },
  pageInfo: {
    fontSize: '0.875rem',
    color: '#6b7280',
  },
};
