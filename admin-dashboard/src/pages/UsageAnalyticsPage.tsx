import { useState, useEffect, useCallback } from 'react';
import { apiRequest, ApiClientError } from '../api/client';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AggregatedUsageItem {
  user_id: string;
  operation_type: string;
  calendar_day_utc: string;
  operation_count: number;
}

interface AdminUsageResponse {
  items: AggregatedUsageItem[];
}

interface PerUserSummary {
  user_id: string;
  total: number;
  text: number;
  vision: number;
  audio: number;
  lastSeen: string;
}

interface DailySummary {
  date: string;
  total: number;
  text: number;
  vision: number;
  audio: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shortId(id: string) {
  return id.slice(0, 8) + '…';
}

function fmtDate(iso: string) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString(undefined, {
    month: 'short', day: 'numeric', timeZone: 'UTC',
  });
}

function buildPerUserSummary(items: AggregatedUsageItem[]): PerUserSummary[] {
  const map = new Map<string, PerUserSummary>();
  for (const item of items) {
    let s = map.get(item.user_id);
    if (!s) {
      s = { user_id: item.user_id, total: 0, text: 0, vision: 0, audio: 0, lastSeen: item.calendar_day_utc };
      map.set(item.user_id, s);
    }
    s.total += item.operation_count;
    if (item.operation_type === 'text')        s.text   += item.operation_count;
    else if (item.operation_type === 'vision') s.vision += item.operation_count;
    else if (item.operation_type === 'audio')  s.audio  += item.operation_count;
    if (item.calendar_day_utc > s.lastSeen) s.lastSeen = item.calendar_day_utc;
  }
  return Array.from(map.values()).sort((a, b) => b.total - a.total);
}

function buildDailySummary(items: AggregatedUsageItem[]): DailySummary[] {
  const map = new Map<string, DailySummary>();
  for (const item of items) {
    let s = map.get(item.calendar_day_utc);
    if (!s) {
      s = { date: item.calendar_day_utc, total: 0, text: 0, vision: 0, audio: 0 };
      map.set(item.calendar_day_utc, s);
    }
    s.total += item.operation_count;
    if (item.operation_type === 'text')        s.text   += item.operation_count;
    else if (item.operation_type === 'vision') s.vision += item.operation_count;
    else if (item.operation_type === 'audio')  s.audio  += item.operation_count;
  }
  return Array.from(map.values()).sort((a, b) => b.date.localeCompare(a.date));
}

// ---------------------------------------------------------------------------
// Bar chart (pure CSS, no library needed)
// ---------------------------------------------------------------------------

function BarChart({ data }: { data: DailySummary[] }) {
  const maxVal = Math.max(...data.map((d) => d.total), 1);
  const recent = data.slice(0, 30).reverse();
  return (
    <div style={cStyles.wrapper}>
      <div style={cStyles.bars}>
        {recent.map((d) => (
          <div key={d.date} style={cStyles.col} title={`${fmtDate(d.date)}: ${d.total} ops`}>
            <div style={{ ...cStyles.bar, height: `${Math.max(2, (d.total / maxVal) * 100)}%` }}>
              <div style={{ ...cStyles.seg, height: `${(d.text   / Math.max(d.total,1))*100}%`, background:'#3b82f6' }} />
              <div style={{ ...cStyles.seg, height: `${(d.vision / Math.max(d.total,1))*100}%`, background:'#8b5cf6' }} />
              <div style={{ ...cStyles.seg, height: `${(d.audio  / Math.max(d.total,1))*100}%`, background:'#10b981' }} />
            </div>
          </div>
        ))}
      </div>
      <div style={cStyles.legend}>
        {[['#3b82f6','Text'],['#8b5cf6','Vision'],['#10b981','Audio']].map(([c,l])=>(
          <span key={l} style={cStyles.legendItem}>
            <span style={{...cStyles.dot, background:c}} />{l}
          </span>
        ))}
      </div>
    </div>
  );
}

const cStyles: Record<string, React.CSSProperties> = {
  wrapper:    { background:'#f9fafb', border:'1px solid #e5e7eb', borderRadius:8, padding:'1rem', marginBottom:'1.5rem' },
  bars:       { display:'flex', alignItems:'flex-end', gap:3, height:140, overflowX:'auto' },
  col:        { flex:'0 0 auto', width:16, display:'flex', alignItems:'flex-end', height:'100%' },
  bar:        { width:'100%', display:'flex', flexDirection:'column-reverse', borderRadius:'3px 3px 0 0', overflow:'hidden', background:'#e5e7eb' },
  seg:        { width:'100%', minHeight:1 },
  legend:     { display:'flex', gap:'1rem', marginTop:'0.75rem', fontSize:'0.75rem', color:'#6b7280' },
  legendItem: { display:'flex', alignItems:'center', gap:4 },
  dot:        { display:'inline-block', width:10, height:10, borderRadius:'50%' },
};

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

const RANGE_OPTIONS = [
  { label: 'Last 7 days',  days: 7  },
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
];

export default function UsageAnalyticsPage() {
  const [rangeDays, setRangeDays]   = useState(30);
  const [items,     setItems]       = useState<AggregatedUsageItem[]>([]);
  const [loading,   setLoading]     = useState(true);
  const [error,     setError]       = useState('');
  const [activeTab, setActiveTab]   = useState<'overview'|'byUser'|'daily'>('overview');

  const fetchUsage = useCallback(async (days: number) => {
    setLoading(true);
    setError('');
    try {
      const to   = new Date();
      const from = new Date(to.getTime() - days * 86400_000);
      const qs   = new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
      const data = await apiRequest<AdminUsageResponse>(`/admin/usage?${qs}`);
      setItems(data.items);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : 'Failed to load usage data.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsage(rangeDays); }, [fetchUsage, rangeDays]);

  const totalOps    = items.reduce((s,i) => s + i.operation_count, 0);
  const totalText   = items.filter(i=>i.operation_type==='text').reduce((s,i)=>s+i.operation_count,0);
  const totalVision = items.filter(i=>i.operation_type==='vision').reduce((s,i)=>s+i.operation_count,0);
  const totalAudio  = items.filter(i=>i.operation_type==='audio').reduce((s,i)=>s+i.operation_count,0);
  const uniqueUsers = new Set(items.map(i=>i.user_id)).size;
  const perUser     = buildPerUserSummary(items);
  const daily       = buildDailySummary(items);

  const kpis = [
    { label:'Total Operations', value:totalOps,    color:'#2563eb' },
    { label:'Unique Users',     value:uniqueUsers, color:'#7c3aed' },
    { label:'Text Ops',         value:totalText,   color:'#0891b2' },
    { label:'Vision Ops',       value:totalVision, color:'#7c3aed' },
    { label:'Audio Ops',        value:totalAudio,  color:'#059669' },
  ];

  return (
    <div style={s.container}>
      {/* Header ---------------------------------------------------------- */}
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Usage Analytics</h1>
          <p style={s.subtitle}>AI operation counts across all users</p>
        </div>
        <div style={s.rangeBar}>
          {RANGE_OPTIONS.map(opt => (
            <button
              key={opt.days}
              style={{ ...s.rangeBtn, ...(rangeDays===opt.days ? s.rangeBtnActive : {}) }}
              onClick={() => setRangeDays(opt.days)}
            >
              {opt.label}
            </button>
          ))}
          <button style={s.refreshBtn} onClick={()=>fetchUsage(rangeDays)} disabled={loading} title="Refresh">
            {loading ? '…' : '↻'}
          </button>
        </div>
      </div>

      {error && <div role="alert" style={s.errorBanner}>{error}</div>}

      {/* KPI cards -------------------------------------------------------- */}
      <div style={s.kpiRow}>
        {kpis.map(k => (
          <div key={k.label} style={s.kpiCard}>
            <div style={{ ...s.kpiValue, color: k.color }}>{loading ? '…' : k.value.toLocaleString()}</div>
            <div style={s.kpiLabel}>{k.label}</div>
          </div>
        ))}
      </div>

      {/* Tabs ------------------------------------------------------------ */}
      <div style={s.tabs}>
        {(['overview','byUser','daily'] as const).map(tab => (
          <button
            key={tab}
            style={{ ...s.tab, ...(activeTab===tab ? s.tabActive : {}) }}
            onClick={()=>setActiveTab(tab)}
          >
            {tab==='overview' ? '📊 Daily Chart' : tab==='byUser' ? '👤 By User' : '📅 Daily Breakdown'}
          </button>
        ))}
      </div>

      {/* Tab: Overview --------------------------------------------------- */}
      {activeTab==='overview' && (
        <>
          <h2 style={s.sectionTitle}>Daily Operations — last {Math.min(rangeDays,30)} days shown</h2>
          {loading ? <p style={s.dim}>Loading…</p> : <BarChart data={daily} />}
        </>
      )}

      {/* Tab: By User ----------------------------------------------------- */}
      {activeTab==='byUser' && (
        <>
          <h2 style={s.sectionTitle}>Operations per User</h2>
          {loading ? <p style={s.dim}>Loading…</p> : perUser.length===0 ? (
            <p style={s.empty}>No usage data for this period.</p>
          ) : (
            <div style={s.tableWrapper}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['User ID','Total','Text','Vision','Audio','Last Active','Share'].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {perUser.map(u => (
                    <tr key={u.user_id} style={s.tr}>
                      <td style={s.td}><code style={s.mono}>{shortId(u.user_id)}</code></td>
                      <td style={s.td}><strong>{u.total}</strong></td>
                      <td style={s.td}><span style={{...s.badge,background:'#eff6ff',color:'#1d4ed8'}}>{u.text}</span></td>
                      <td style={s.td}><span style={{...s.badge,background:'#f5f3ff',color:'#6d28d9'}}>{u.vision}</span></td>
                      <td style={s.td}><span style={{...s.badge,background:'#ecfdf5',color:'#065f46'}}>{u.audio}</span></td>
                      <td style={s.td}>{fmtDate(u.lastSeen)}</td>
                      <td style={s.td}>
                        <div style={s.shareBar}>
                          <div style={{...s.shareFill, width:`${(u.total/Math.max(totalOps,1))*100}%`}} />
                        </div>
                        <span style={s.sharePct}>{totalOps>0?((u.total/totalOps)*100).toFixed(1):0}%</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Tab: Daily Breakdown --------------------------------------------- */}
      {activeTab==='daily' && (
        <>
          <h2 style={s.sectionTitle}>Daily Breakdown</h2>
          {loading ? <p style={s.dim}>Loading…</p> : daily.length===0 ? (
            <p style={s.empty}>No usage data for this period.</p>
          ) : (
            <div style={s.tableWrapper}>
              <table style={s.table}>
                <thead>
                  <tr>
                    {['Date (UTC)','Total','Text','Vision','Audio'].map(h=>(
                      <th key={h} style={s.th}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {daily.map(d => (
                    <tr key={d.date} style={s.tr}>
                      <td style={s.td}>{fmtDate(d.date)}</td>
                      <td style={s.td}><strong>{d.total}</strong></td>
                      <td style={s.td}><span style={{...s.badge,background:'#eff6ff',color:'#1d4ed8'}}>{d.text}</span></td>
                      <td style={s.td}><span style={{...s.badge,background:'#f5f3ff',color:'#6d28d9'}}>{d.vision}</span></td>
                      <td style={s.td}><span style={{...s.badge,background:'#ecfdf5',color:'#065f46'}}>{d.audio}</span></td>
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
// Styles
// ---------------------------------------------------------------------------

const s: Record<string, React.CSSProperties> = {
  container:    { padding:'2rem', maxWidth:1100, margin:'0 auto' },
  header:       { display:'flex', justifyContent:'space-between', alignItems:'flex-start', marginBottom:'1.5rem', flexWrap:'wrap', gap:'1rem' },
  title:        { margin:'0 0 0.25rem', fontSize:'1.5rem', fontWeight:600 },
  subtitle:     { margin:0, fontSize:'0.875rem', color:'#6b7280' },
  rangeBar:     { display:'flex', gap:'0.5rem', alignItems:'center', flexWrap:'wrap' },
  rangeBtn:     { padding:'0.375rem 0.75rem', border:'1px solid #d1d5db', borderRadius:6, background:'#fff', fontSize:'0.8125rem', cursor:'pointer', color:'#374151' },
  rangeBtnActive:{ background:'#2563eb', color:'#fff', borderColor:'#2563eb' },
  refreshBtn:   { padding:'0.375rem 0.6rem', border:'1px solid #d1d5db', borderRadius:6, background:'#fff', fontSize:'1rem', cursor:'pointer', lineHeight:1 },
  errorBanner:  { padding:'0.75rem', background:'#fef2f2', border:'1px solid #fecaca', borderRadius:6, color:'#dc2626', fontSize:'0.875rem', marginBottom:'1.25rem' },
  kpiRow:       { display:'flex', gap:'1rem', marginBottom:'1.5rem', flexWrap:'wrap' },
  kpiCard:      { flex:'1 1 140px', background:'#fff', border:'1px solid #e5e7eb', borderRadius:8, padding:'1rem 1.25rem', textAlign:'center' as const },
  kpiValue:     { fontSize:'1.75rem', fontWeight:700, lineHeight:1.2 },
  kpiLabel:     { fontSize:'0.75rem', color:'#6b7280', marginTop:4 },
  tabs:         { display:'flex', gap:'0.5rem', borderBottom:'2px solid #e5e7eb', marginBottom:'1.25rem' },
  tab:          { padding:'0.5rem 1rem', border:'none', background:'transparent', fontSize:'0.875rem', cursor:'pointer', color:'#6b7280', borderBottom:'2px solid transparent', marginBottom:-2 },
  tabActive:    { color:'#2563eb', borderBottomColor:'#2563eb', fontWeight:600 },
  sectionTitle: { margin:'0 0 0.75rem', fontSize:'1rem', fontWeight:600, color:'#111827' },
  dim:          { color:'#6b7280', padding:'1rem 0' },
  empty:        { color:'#6b7280', padding:'2rem', textAlign:'center' as const },
  tableWrapper: { overflowX:'auto', border:'1px solid #e5e7eb', borderRadius:8 },
  table:        { width:'100%', borderCollapse:'collapse' as const, fontSize:'0.875rem' },
  th:           { textAlign:'left' as const, padding:'0.625rem 1rem', background:'#f9fafb', borderBottom:'1px solid #e5e7eb', fontSize:'0.75rem', fontWeight:600, textTransform:'uppercase' as const, color:'#6b7280', whiteSpace:'nowrap' as const },
  tr:           { borderBottom:'1px solid #f3f4f6' },
  td:           { padding:'0.625rem 1rem', verticalAlign:'middle' as const },
  mono:         { fontFamily:'monospace', fontSize:'0.8125rem', background:'#f3f4f6', padding:'0.125rem 0.375rem', borderRadius:4 },
  badge:        { display:'inline-block', padding:'0.125rem 0.5rem', borderRadius:12, fontSize:'0.8125rem', fontWeight:500 },
  shareBar:     { display:'inline-block', width:60, height:6, background:'#e5e7eb', borderRadius:3, overflow:'hidden', verticalAlign:'middle', marginRight:6 },
  shareFill:    { height:'100%', background:'#3b82f6', borderRadius:3 },
  sharePct:     { fontSize:'0.8125rem', color:'#6b7280' },
};
