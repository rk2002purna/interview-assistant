import { useState, useEffect, useCallback } from 'react';
import { apiRequest, ApiClientError } from '../../api/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface AggItem { user_id: string; operation_type: string; calendar_day_utc: string; operation_count: number; }
interface PerUser  { user_id: string; total: number; text: number; vision: number; audio: number; lastSeen: string; }
interface PerDay   { date: string;    total: number; text: number; vision: number; audio: number; }

// Model analytics (GET /admin/usage/models)
interface ModelSummary {
  model_id: string;
  provider: string | null;
  operation_type: string;
  role: 'primary' | 'fallback' | 'unknown';
  total: number;
  success: number;
  failed: number;
}
interface ModelErrorRow {
  model_id: string;
  provider: string | null;
  operation_type: string;
  upstream_http_status: number | null;
  count: number;
  last_seen: string;
}
interface ModelAnalytics {
  models: ModelSummary[];
  errors: ModelErrorRow[];
  routing: Record<string, { provider: string; model: string }>;
  totals: { total: number; success: number; failed: number; primary: number; fallback: number };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function roleBadge(role: 'primary' | 'fallback' | 'unknown'): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-block', padding: '0.125rem 0.5rem', borderRadius: 12,
    fontSize: '0.75rem', fontWeight: 600, textTransform: 'capitalize',
  };
  if (role === 'primary')  return { ...base, background: 'rgba(59,130,246,0.15)', color: '#60a5fa' };
  if (role === 'fallback') return { ...base, background: 'rgba(245,158,11,0.15)', color: '#fbbf24' };
  return { ...base, background: 'rgba(255,255,255,0.06)', color: '#94a3b8' };
}
function byUser(items: AggItem[]): PerUser[] {
  const m = new Map<string, PerUser>();
  for (const i of items) {
    let u = m.get(i.user_id) ?? { user_id: i.user_id, total: 0, text: 0, vision: 0, audio: 0, lastSeen: i.calendar_day_utc };
    u.total += i.operation_count;
    if (i.operation_type === 'text')        u.text   += i.operation_count;
    else if (i.operation_type === 'vision') u.vision += i.operation_count;
    else if (i.operation_type === 'audio')  u.audio  += i.operation_count;
    if (i.calendar_day_utc > u.lastSeen)    u.lastSeen = i.calendar_day_utc;
    m.set(i.user_id, u);
  }
  return [...m.values()].sort((a, b) => b.total - a.total);
}
function byDay(items: AggItem[]): PerDay[] {
  const m = new Map<string, PerDay>();
  for (const i of items) {
    let d = m.get(i.calendar_day_utc) ?? { date: i.calendar_day_utc, total: 0, text: 0, vision: 0, audio: 0 };
    d.total += i.operation_count;
    if (i.operation_type === 'text')        d.text   += i.operation_count;
    else if (i.operation_type === 'vision') d.vision += i.operation_count;
    else if (i.operation_type === 'audio')  d.audio  += i.operation_count;
    m.set(i.calendar_day_utc, d);
  }
  return [...m.values()].sort((a, b) => b.date.localeCompare(a.date));
}

/** Fetch every user page and return a userId → email map */
async function fetchUserEmailMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let cursor: string | null = null;
  // Drain all pages (max 50 per page)
  for (let page = 0; page < 100; page++) {
    const qs = new URLSearchParams({ page_size: '50' });
    if (cursor) qs.set('cursor', cursor);
    const data = await apiRequest<{ items: { id: string; email: string }[]; next_cursor: string | null }>(
      `/admin/users?${qs}`,
    );
    for (const u of data.items) map.set(u.id, u.email);
    if (!data.next_cursor) break;
    cursor = data.next_cursor;
  }
  return map;
}

// ---------------------------------------------------------------------------
// Mini bar chart — pure CSS, no library
// ---------------------------------------------------------------------------
function BarChart({ days }: { days: PerDay[] }) {
  const recent = days.slice(0, 30).reverse();
  const max    = Math.max(...recent.map(d => d.total), 1);
  return (
    <div style={c.wrap}>
      <div style={c.bars}>
        {recent.map(d => (
          <div key={d.date} style={c.col} title={`${fmtDate(d.date)}: ${d.total}`}>
            <div style={{ ...c.bar, height: `${Math.max(2, (d.total / max) * 100)}%` }}>
              <div style={{ ...c.seg, height: `${(d.text   / Math.max(d.total,1))*100}%`, background:'#3b82f6' }} />
              <div style={{ ...c.seg, height: `${(d.vision / Math.max(d.total,1))*100}%`, background:'#8b5cf6' }} />
              <div style={{ ...c.seg, height: `${(d.audio  / Math.max(d.total,1))*100}%`, background:'#10b981' }} />
            </div>
          </div>
        ))}
      </div>
      <div style={c.legend}>
        {[['#3b82f6','Text'],['#8b5cf6','Vision'],['#10b981','Audio']].map(([col, lbl]) => (
          <span key={lbl} style={c.lgItem}><span style={{ ...c.dot, background: col }} />{lbl}</span>
        ))}
      </div>
    </div>
  );
}
const c: Record<string, React.CSSProperties> = {
  wrap:   { background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 8, padding: '1rem', marginBottom: '1.5rem' },
  bars:   { display: 'flex', alignItems: 'flex-end', gap: 3, height: 140, overflowX: 'auto' },
  col:    { flex: '0 0 auto', width: 16, display: 'flex', alignItems: 'flex-end', height: '100%' },
  bar:    { width: '100%', display: 'flex', flexDirection: 'column-reverse', borderRadius: '3px 3px 0 0', overflow: 'hidden', background: 'rgba(255,255,255,0.06)' },
  seg:    { width: '100%', minHeight: 1 },
  legend: { display: 'flex', gap: '1rem', marginTop: '0.75rem', fontSize: '0.75rem', color: '#64748b' },
  lgItem: { display: 'flex', alignItems: 'center', gap: 4 },
  dot:    { display: 'inline-block', width: 10, height: 10, borderRadius: '50%' },
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
const RANGES = [{ label: 'Last 7 days', days: 7 }, { label: 'Last 30 days', days: 30 }, { label: 'Last 90 days', days: 90 }];

export default function UsageAnalyticsPage() {
  const [range,     setRange]     = useState(30);
  const [items,     setItems]     = useState<AggItem[]>([]);
  const [models,    setModels]    = useState<ModelAnalytics | null>(null);
  const [emailMap,  setEmailMap]  = useState<Map<string, string>>(new Map());
  const [loading,   setLoading]   = useState(true);
  const [error,     setError]     = useState('');
  const [tab,       setTab]       = useState<'chart'|'models'|'errors'|'users'|'daily'>('chart');

  const load = useCallback(async (days: number) => {
    setLoading(true); setError('');
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - days * 86_400_000);
      const qs   = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      // Load usage + model analytics + user emails in parallel
      const [usageData, modelData, emailLookup] = await Promise.all([
        apiRequest<{ items: AggItem[] }>(`/admin/usage?${qs}`),
        apiRequest<ModelAnalytics>(`/admin/usage/models?${qs}`),
        fetchUserEmailMap(),
      ]);
      setItems(usageData.items);
      setModels(modelData);
      setEmailMap(emailLookup);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load usage.');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { load(range); }, [load, range]);

  const totalOps    = items.reduce((s, i) => s + i.operation_count, 0);
  const totalText   = items.filter(i => i.operation_type === 'text').reduce((s,i)=>s+i.operation_count,0);
  const totalVision = items.filter(i => i.operation_type === 'vision').reduce((s,i)=>s+i.operation_count,0);
  const totalAudio  = items.filter(i => i.operation_type === 'audio').reduce((s,i)=>s+i.operation_count,0);
  const uniqueUsers = new Set(items.map(i => i.user_id)).size;
  const users       = byUser(items);
  const days        = byDay(items);

  return (
    <div>
      {/* Header */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Usage Analytics</h1>
          <p style={s.sub}>AI operation counts across all users</p>
        </div>
        <div style={s.rangeBar}>
          {RANGES.map(r => (
            <button key={r.days} style={{ ...s.rBtn, ...(range === r.days ? s.rBtnOn : {}) }} onClick={() => setRange(r.days)}>
              {r.label}
            </button>
          ))}
          <button style={s.rBtn} onClick={() => load(range)} disabled={loading} title="Refresh">↻</button>
        </div>
      </div>

      {error && <div role="alert" style={s.err}>{error}</div>}

      {/* KPI cards */}
      <div style={s.kpis}>
        {[
          { label: 'Total Operations', val: totalOps,    color: '#3b82f6' },
          { label: 'Unique Users',     val: uniqueUsers, color: '#8b5cf6' },
          { label: 'Text',             val: totalText,   color: '#0ea5e9' },
          { label: 'Vision',           val: totalVision, color: '#8b5cf6' },
          { label: 'Audio',            val: totalAudio,  color: '#10b981' },
        ].map(k => (
          <div key={k.label} style={s.kpi}>
            <div style={{ ...s.kpiVal, color: k.color }}>{loading ? '…' : k.val.toLocaleString()}</div>
            <div style={s.kpiLbl}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        {([['chart','📊 Daily Chart'],['models','🤖 Models'],['errors','⚠️ Errors & Fallback'],['users','👤 By User'],['daily','📅 Daily Breakdown']] as const).map(([id, lbl]) => (
          <button key={id} style={{ ...s.tab, ...(tab === id ? s.tabOn : {}) }} onClick={() => setTab(id)}>{lbl}</button>
        ))}
      </div>

      {/* Chart tab */}
      {tab === 'chart' && (
        <>
          <h2 style={s.secTitle}>Daily Operations — last {Math.min(range, 30)} days</h2>
          {loading ? <p style={s.dim}>Loading…</p> : <BarChart days={days} />}
        </>
      )}

      {/* Models tab */}
      {tab === 'models' && (
        <>
          <h2 style={s.secTitle}>Models Called by Users</h2>
          {loading ? <p style={s.dim}>Loading…</p> : !models || models.models.length === 0 ? <p style={s.dim}>No model usage for this period.</p> : (
            <div style={s.tblWrap}>
              <table style={s.tbl}>
                <thead><tr>{['Model','Provider','Type','Role','Total','Success','Failed','Success Rate'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {models.models.map(m => {
                    const rate = m.total > 0 ? (m.success / m.total) * 100 : 0;
                    return (
                      <tr key={m.model_id + m.operation_type} style={s.tr}>
                        <td style={s.td}><span style={s.mono}>{m.model_id}</span></td>
                        <td style={s.td}>{m.provider ?? '—'}</td>
                        <td style={s.td}>{m.operation_type}</td>
                        <td style={s.td}><span style={roleBadge(m.role)}>{m.role}</span></td>
                        <td style={s.td}><strong style={{ color: '#f1f5f9' }}>{m.total}</strong></td>
                        <td style={s.td}><span style={{ ...s.badge, background:'rgba(16,185,129,0.15)', color:'#34d399' }}>{m.success}</span></td>
                        <td style={s.td}>{m.failed > 0
                          ? <span style={{ ...s.badge, background:'rgba(239,68,68,0.15)', color:'#fca5a5' }}>{m.failed}</span>
                          : <span style={s.dim}>0</span>}
                        </td>
                        <td style={s.td}>
                          <span style={{ color: rate >= 95 ? '#34d399' : rate >= 80 ? '#fbbf24' : '#fca5a5', fontWeight: 600 }}>
                            {rate.toFixed(1)}%
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Errors & Fallback tab */}
      {tab === 'errors' && (
        <>
          {models && (
            <div style={s.kpis}>
              {[
                { label: 'Failed Calls',  val: models.totals.failed.toLocaleString(), color: '#fca5a5' },
                { label: 'Error Rate',    val: (models.totals.total > 0 ? ((models.totals.failed / models.totals.total) * 100).toFixed(1) : '0') + '%', color: '#f1f5f9' },
                { label: 'Fallback Calls',val: models.totals.fallback.toLocaleString(), color: '#fbbf24' },
                { label: 'Primary Calls', val: models.totals.primary.toLocaleString(), color: '#60a5fa' },
              ].map(k => (
                <div key={k.label} style={s.kpi}>
                  <div style={{ ...s.kpiVal, color: k.color }}>{loading ? '…' : k.val}</div>
                  <div style={s.kpiLbl}>{k.label}</div>
                </div>
              ))}
            </div>
          )}

          {models && models.totals.fallback > 0 && (
            <div style={s.fallbackBanner}>
              ⚠️ Fallback is active — {models.totals.fallback.toLocaleString()} call(s) hit a configured fallback model.
              This usually means a primary provider was failing or unavailable.
            </div>
          )}

          <h2 style={s.secTitle}>Errors by Model</h2>
          {loading ? <p style={s.dim}>Loading…</p> : !models || models.errors.length === 0 ? <p style={s.dim}>🎉 No failed calls in this period.</p> : (
            <div style={s.tblWrap}>
              <table style={s.tbl}>
                <thead><tr>{['Model','Provider','Type','Upstream HTTP','Failures','Last Seen'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {models.errors.map((e, i) => (
                    <tr key={e.model_id + e.operation_type + (e.upstream_http_status ?? 'x') + i} style={s.tr}>
                      <td style={s.td}><span style={s.mono}>{e.model_id}</span></td>
                      <td style={s.td}>{e.provider ?? '—'}</td>
                      <td style={s.td}>{e.operation_type}</td>
                      <td style={s.td}>{e.upstream_http_status != null
                        ? <span style={{ ...s.badge, background:'rgba(239,68,68,0.15)', color:'#fca5a5' }}>{e.upstream_http_status}</span>
                        : <span style={s.dim}>network / timeout</span>}
                      </td>
                      <td style={s.td}><strong style={{ color: '#f1f5f9' }}>{e.count}</strong></td>
                      <td style={s.td}>{new Date(e.last_seen).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* By User tab */}
      {tab === 'users' && (
        <>
          <h2 style={s.secTitle}>Operations per User</h2>
          {loading ? <p style={s.dim}>Loading…</p> : users.length === 0 ? <p style={s.dim}>No data for this period.</p> : (
            <div style={s.tblWrap}>
              <table style={s.tbl}>
                <thead><tr>{['User Email','Total','Text','Vision','Audio','Last Active','Share %'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {users.map(u => (
                    <tr key={u.user_id} style={s.tr}>
                      <td style={s.td}>
                        <span style={s.email} title={u.user_id}>
                          {emailMap.get(u.user_id) ?? u.user_id.slice(0, 8) + '…'}
                        </span>
                      </td>
                      <td style={s.td}><strong style={{ color: '#f1f5f9' }}>{u.total}</strong></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(59,130,246,0.15)', color:'#60a5fa' }}>{u.text}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(139,92,246,0.15)', color:'#a78bfa' }}>{u.vision}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(16,185,129,0.15)', color:'#34d399' }}>{u.audio}</span></td>
                      <td style={s.td}>{fmtDate(u.lastSeen)}</td>
                      <td style={s.td}>
                        <div style={s.sBar}><div style={{ ...s.sFill, width: `${(u.total/Math.max(totalOps,1))*100}%` }} /></div>
                        <span style={s.sPct}>{totalOps > 0 ? ((u.total/totalOps)*100).toFixed(1) : 0}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Daily tab */}
      {tab === 'daily' && (
        <>
          <h2 style={s.secTitle}>Daily Breakdown</h2>
          {loading ? <p style={s.dim}>Loading…</p> : days.length === 0 ? <p style={s.dim}>No data for this period.</p> : (
            <div style={s.tblWrap}>
              <table style={s.tbl}>
                <thead><tr>{['Date (UTC)','Total','Text','Vision','Audio'].map(h => <th key={h} style={s.th}>{h}</th>)}</tr></thead>
                <tbody>
                  {days.map(d => (
                    <tr key={d.date} style={s.tr}>
                      <td style={s.td}>{fmtDate(d.date)}</td>
                      <td style={s.td}><strong style={{ color: '#f1f5f9' }}>{d.total}</strong></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(59,130,246,0.15)', color:'#60a5fa' }}>{d.text}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(139,92,246,0.15)', color:'#a78bfa' }}>{d.vision}</span></td>
                      <td style={s.td}><span style={{ ...s.badge, background:'rgba(16,185,129,0.15)', color:'#34d399' }}>{d.audio}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — dark theme matching other admin pages
// ---------------------------------------------------------------------------
const s: Record<string, React.CSSProperties> = {
  header:   { display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'1.5rem', flexWrap:'wrap', gap:'1rem' },
  title:    { margin:'0 0 0.25rem', fontSize:'1.5rem', fontWeight:600, color:'#f1f5f9' },
  sub:      { margin:0, fontSize:'0.875rem', color:'#64748b' },
  rangeBar: { display:'flex', gap:'0.5rem', alignItems:'center', flexWrap:'wrap' },
  rBtn:     { padding:'0.375rem 0.75rem', border:'1px solid rgba(255,255,255,0.1)', borderRadius:6, background:'rgba(255,255,255,0.04)', fontSize:'0.8125rem', cursor:'pointer', color:'#94a3b8' },
  rBtnOn:   { background:'rgba(59,130,246,0.2)', borderColor:'rgba(59,130,246,0.4)', color:'#60a5fa' },
  err:      { padding:'0.75rem', background:'rgba(239,68,68,0.1)', border:'1px solid rgba(239,68,68,0.3)', borderRadius:6, color:'#fca5a5', fontSize:'0.875rem', marginBottom:'1rem' },
  fallbackBanner: { padding:'0.75rem', background:'rgba(245,158,11,0.1)', border:'1px solid rgba(245,158,11,0.3)', borderRadius:6, color:'#fbbf24', fontSize:'0.875rem', marginBottom:'1.25rem' },
  kpis:     { display:'flex', gap:'1rem', marginBottom:'1.5rem', flexWrap:'wrap' },
  kpi:      { flex:'1 1 130px', background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.06)', borderRadius:8, padding:'1rem 1.25rem', textAlign:'center' as const },
  kpiVal:   { fontSize:'1.75rem', fontWeight:700, lineHeight:1.2 },
  kpiLbl:   { fontSize:'0.75rem', color:'#64748b', marginTop:4 },
  tabs:     { display:'flex', gap:'0.25rem', borderBottom:'1px solid rgba(255,255,255,0.06)', marginBottom:'1.25rem' },
  tab:      { padding:'0.5rem 1rem', border:'none', background:'transparent', fontSize:'0.875rem', cursor:'pointer', color:'#64748b', borderBottom:'2px solid transparent', marginBottom:-1 },
  tabOn:    { color:'#60a5fa', borderBottomColor:'#3b82f6', fontWeight:600 },
  secTitle: { margin:'0 0 0.75rem', fontSize:'1rem', fontWeight:600, color:'#e2e8f0' },
  dim:      { color:'#64748b', padding:'1rem 0' },
  tblWrap:  { overflowX:'auto', border:'1px solid rgba(255,255,255,0.06)', borderRadius:8 },
  tbl:      { width:'100%', borderCollapse:'collapse' as const, fontSize:'0.875rem' },
  th:       { textAlign:'left' as const, padding:'0.625rem 1rem', background:'rgba(255,255,255,0.03)', borderBottom:'1px solid rgba(255,255,255,0.06)', fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase' as const, color:'#64748b', whiteSpace:'nowrap' as const },
  tr:       { borderBottom:'1px solid rgba(255,255,255,0.04)' },
  td:       { padding:'0.625rem 1rem', verticalAlign:'middle' as const, color:'#94a3b8' },
  mono:     { fontFamily:'monospace', fontSize:'0.8125rem', background:'rgba(255,255,255,0.05)', padding:'0.125rem 0.375rem', borderRadius:4, color:'#cbd5e1' },
  email:    { fontSize:'0.8125rem', color:'#93c5fd', fontWeight:500 },
  badge:    { display:'inline-block', padding:'0.125rem 0.5rem', borderRadius:12, fontSize:'0.8125rem', fontWeight:500 },
  sBar:     { display:'inline-block', width:60, height:6, background:'rgba(255,255,255,0.06)', borderRadius:3, overflow:'hidden', verticalAlign:'middle', marginRight:6 },
  sFill:    { height:'100%', background:'#3b82f6', borderRadius:3 },
  sPct:     { fontSize:'0.8125rem', color:'#64748b' },
};
