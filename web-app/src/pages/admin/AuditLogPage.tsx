import { useCallback, useEffect, useState } from 'react';
import { apiRequest } from '../../api/client';

interface AuditLogEntry {
  id: string; ts: string; actor: string | null; target: string | null;
  target_resource: string | null; event_type: string; outcome: string;
  reason_code: string | null; metadata: Record<string, unknown>;
}
interface AuditLogResponse { items: AuditLogEntry[]; next_cursor: string | null; }

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
      if (pageCursor) params.set('cursor', pageCursor);
      const data = await apiRequest<AuditLogResponse>(`/admin/audit-log?${params.toString()}`);
      setEntries(data.items);
      setCursor(data.next_cursor);
      setHasMore(data.next_cursor !== null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load audit log');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { fetchPage(null); }, [fetchPage]);

  function handleNextPage() {
    if (!cursor) return;
    setCursorHistory((prev) => [...prev, cursor]);
    fetchPage(cursor);
  }

  function handlePrevPage() {
    if (cursorHistory.length <= 1) return;
    const newHistory = cursorHistory.slice(0, -1);
    setCursorHistory(newHistory);
    fetchPage(newHistory[newHistory.length - 1] ?? null);
  }

  return (
    <div>
      <h1 style={s.title}>Audit Log</h1>
      <p style={s.subtitle}>Read-only log of security and billing events</p>

      {error && <div role="alert" style={s.error}>{error}</div>}

      <div style={s.tableWrapper}>
        <table style={s.table}>
          <thead>
            <tr>
              <th style={s.th}>Timestamp</th>
              <th style={s.th}>Actor</th>
              <th style={s.th}>Event Type</th>
              <th style={s.th}>Outcome</th>
              <th style={s.th}>Metadata</th>
            </tr>
          </thead>
          <tbody>
            {loading && entries.length === 0 ? (
              <tr><td colSpan={5} style={s.emptyCell}>Loading…</td></tr>
            ) : entries.length === 0 ? (
              <tr><td colSpan={5} style={s.emptyCell}>No audit log entries found.</td></tr>
            ) : (
              entries.map((entry) => (
                <tr key={entry.id} style={s.row}>
                  <td style={s.td}>{new Date(entry.ts).toLocaleString()}</td>
                  <td style={s.td}><span style={s.mono}>{entry.actor ? entry.actor.slice(0, 8) + '…' : '—'}</span></td>
                  <td style={s.td}><span style={s.badge}>{entry.event_type}</span></td>
                  <td style={s.td}>
                    <span style={{
                      ...s.outcomeBadge,
                      background: entry.outcome === 'success' ? 'rgba(34,197,94,0.12)' : entry.outcome === 'failure' ? 'rgba(239,68,68,0.1)' : 'rgba(255,255,255,0.05)',
                      color: entry.outcome === 'success' ? '#4ade80' : entry.outcome === 'failure' ? '#fca5a5' : '#94a3b8',
                    }}>{entry.outcome}</span>
                  </td>
                  <td style={s.td}>
                    <pre style={s.metadata}>{entry.metadata && Object.keys(entry.metadata).length > 0 ? JSON.stringify(entry.metadata, null, 2) : '—'}</pre>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div style={s.pagination}>
        <button onClick={handlePrevPage} disabled={cursorHistory.length <= 1 || loading} style={s.pageButton}>← Previous</button>
        <span style={s.pageInfo}>{loading ? 'Loading…' : `${entries.length} entries`}</span>
        <button onClick={handleNextPage} disabled={!hasMore || loading} style={s.pageButton}>Next →</button>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  title: { margin: '0 0 0.25rem', fontSize: '1.5rem', fontWeight: 600, color: '#f1f5f9' },
  subtitle: { margin: '0 0 1.5rem', fontSize: '0.875rem', color: '#64748b' },
  error: { padding: '0.75rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: 6, color: '#fca5a5', fontSize: '0.875rem', marginBottom: '1rem' },
  tableWrapper: { overflowX: 'auto', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8 },
  table: { width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' },
  th: { textAlign: 'left', padding: '0.75rem 1rem', background: 'rgba(255,255,255,0.03)', borderBottom: '1px solid rgba(255,255,255,0.06)', fontWeight: 600, color: '#94a3b8', whiteSpace: 'nowrap' },
  td: { padding: '0.75rem 1rem', borderBottom: '1px solid rgba(255,255,255,0.04)', verticalAlign: 'top', color: '#e2e8f0' },
  row: { transition: 'background-color 0.1s' },
  emptyCell: { padding: '2rem', textAlign: 'center', color: '#64748b' },
  mono: { fontFamily: 'monospace', fontSize: '0.8rem', color: '#cbd5e1' },
  badge: { display: 'inline-block', padding: '0.125rem 0.5rem', background: 'rgba(59,130,246,0.12)', color: '#60a5fa', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500 },
  outcomeBadge: { display: 'inline-block', padding: '0.125rem 0.5rem', borderRadius: 4, fontSize: '0.75rem', fontWeight: 500 },
  metadata: { margin: 0, fontSize: '0.75rem', fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxWidth: 300, maxHeight: 80, overflow: 'auto', color: '#94a3b8' },
  pagination: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '1rem', padding: '0.5rem 0' },
  pageButton: { padding: '0.5rem 1rem', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 6, background: 'rgba(255,255,255,0.05)', color: '#94a3b8', fontSize: '0.875rem', cursor: 'pointer' },
  pageInfo: { fontSize: '0.875rem', color: '#64748b' },
};
