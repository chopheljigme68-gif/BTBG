'use client';
import { useApi } from '@/lib/api';

/** Dzongkhag, sector, host and date filters shared by the dashboard and reports (FR-RPT-01). */
export function ReportFilters({ value, onChange }: { value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const f = useApi<any>('/reports/filters');
  const set = (k: string, v: string) => onChange({ ...value, [k]: v, ...(k === 'dzongkhagId' ? { gewogId: '' } : {}) });
  const sel = (k: string, labelText: string, options: Array<{ value: any; label: string }>) => (
    <select className="input w-auto py-1.5 text-sm" aria-label={labelText} value={value[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
      <option value="">{labelText}: all</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
  if (!f.data) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {sel('dzongkhagId', 'Dzongkhag', f.data.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })))}
      {value.dzongkhagId && sel('gewogId', 'Gewog', f.data.gewogs.filter((g: any) => String(g.dzongkhagId) === value.dzongkhagId).map((g: any) => ({ value: g.id, label: g.name })))}
      {sel('sector', 'Sector', f.data.sectors.map((s: any) => ({ value: s.code, label: s.name })))}
      {sel('orgId', 'Host', f.data.hosts.map((h: any) => ({ value: h.id, label: h.name })))}
      <input type="date" className="input w-auto py-1.5 text-sm" aria-label="From" value={value.from ?? ''} onChange={(e) => set('from', e.target.value)} />
      <input type="date" className="input w-auto py-1.5 text-sm" aria-label="To" value={value.to ?? ''} onChange={(e) => set('to', e.target.value)} />
      {Object.values(value).some(Boolean) && <button className="btn-ghost btn-sm" onClick={() => onChange({})}>Clear</button>}
    </div>
  );
}
