'use client';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Async, Badge, Card, PageHeader, Table, Tabs } from '@/components/ui';
import { fileUrl, qs, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { label, money } from '@/lib/format';
import { ReportFilters } from '../filters';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `${v}%`);

export default function ReportsPage() {
  return <Suspense><Reports /></Suspense>;
}

/** Standard, impact, seasonal and host reports with Excel and PDF export (FR-RPT-02..06). */
function Reports() {
  const host = useSearchParams().get('host');
  const [tab, setTab] = useState(host ? 'host' : 'standard');
  const [f, setF] = useState<Record<string, string>>(host ? { orgId: host } : {});
  const { me } = useMe();
  const exportable = ['dashboard', 'standard', 'impact', 'seasonal'].includes(tab) && can(me, 'reports.export');
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Reports" actions={exportable && <div className="flex gap-2">
        <a className="btn-outline btn-sm" href={fileUrl(`/reports/export${qs({ ...f, report: tab, format: 'xlsx' })}`)}>Excel</a>
        <a className="btn-outline btn-sm" href={fileUrl(`/reports/export${qs({ ...f, report: tab, format: 'pdf' })}`)}>PDF</a>
      </div>} />
      <ReportFilters value={f} onChange={setF} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'standard', label: 'Operations' }, { id: 'impact', label: 'Impact' }, { id: 'seasonal', label: 'Seasonal demand' }, { id: 'exposure', label: 'Cash exposure' }, ...(f.orgId ? [{ id: 'host', label: 'Host report' }] : [])]} />
      {tab === 'standard' && <Standard f={f} />}
      {tab === 'impact' && <Impact f={f} />}
      {tab === 'seasonal' && <Seasonal f={f} />}
      {tab === 'exposure' && <ExposureReport />}
      {tab === 'host' && f.orgId && <HostReport orgId={f.orgId} f={f} />}
    </div>
  );
}

function Standard({ f }: { f: Record<string, string> }) {
  const r = useApi<any>(`/reports/standard${qs(f)}`);
  return (
    <Async r={r}>{(d) => (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{d.from} to {d.to}</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Box label="Conversion rate" value={pct(d.conversionRate.pct)} hint={`${d.conversionRate.conversions} of ${d.conversionRate.outcomes} outcomes`} />
          <Box label="Average time to fill" value={d.timeToFill.avgDays !== null ? `${Math.max(0, d.timeToFill.avgDays)} days` : '—'} hint={`${d.timeToFill.vacancies} vacancies`} />
          <Box label="Redeployed in time" value={pct(d.redeploymentRate.pct)} hint={`${d.redeploymentRate.withinDeadline} of ${d.redeploymentRate.benchPeriods} bench periods`} />
          <Box label="Bench days" value={d.benchDays} />
          <Box label="Invoiced" value={money(d.revenue.invoiced)} /><Box label="Collected" value={money(d.revenue.collected)} /><Box label="Receivable" value={money(d.revenue.receivable)} />
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Retention" padded={false}><Table rows={d.retention.map((x: any) => ({ ...x, id: x.day }))} columns={[{ key: 'day', label: 'Day' }, { key: 'retained', label: 'Retained' }, { key: 'eligible', label: 'Eligible' }, { key: 'pct', label: 'Rate', render: (x: any) => pct(x.pct) }]} /></Card>
          <Card title="Placements by status" padded={false}><Table rows={d.placementsByStatus.map((x: any) => ({ ...x, id: x.status }))} columns={[{ key: 'status', label: 'Status', render: (x: any) => <Badge status={x.status} /> }, { key: 'count', label: 'Count' }]} /></Card>
          <Card title="Grievances" padded={false}><Generic rows={d.grievances} /></Card>
          <Card title="Receivables ageing" padded={false}><Generic rows={d.receivablesAgeing} money /></Card>
        </div>
      </div>
    )}</Async>
  );
}

function Impact({ f }: { f: Record<string, string> }) {
  const r = useApi<any>(`/reports/impact${qs(f)}`);
  const cols = [{ key: 'group', label: 'Group', render: (x: any) => label(x.group) }, { key: 'reached', label: 'Reached' }, { key: 'trained', label: 'Trained' }, { key: 'placed', label: 'Placed' }, { key: 'retained90', label: 'Retained 90 days' }, { key: 'converted', label: 'Hired directly' }];
  return (
    <Async r={r}>{(d) => (
      <div className="space-y-4">
        <p className="text-sm text-slate-500">{d.from} to {d.to}. For funders and government partners.</p>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">{['reached', 'trained', 'placed', 'retained90', 'converted'].map((k) => <Box key={k} label={cols.find((c) => c.key === k)!.label as string} value={d.total[k]} />)}</div>
        <div className="grid gap-4 lg:grid-cols-3">
          {(['byGender', 'byDzongkhag', 'bySector'] as const).map((k) => <Card key={k} title={label(k.replace('by', 'By '))} padded={false}><Table rows={d[k].map((x: any) => ({ ...x, id: x.group }))} columns={cols} /></Card>)}
        </div>
      </div>
    )}</Async>
  );
}

function Seasonal({ f }: { f: Record<string, string> }) {
  const r = useApi<any[]>(`/reports/seasonal${qs(f)}`);
  return (
    <Card title="Seasonal demand" padded={false}>
      <Async r={r}>{(rows) => {
        const max = Math.max(1, ...rows.map((x) => Math.max(x.hostsInPeak, x.openingsStarting)));
        return (
          <div className="p-4">
            <div className="flex h-48 items-end gap-2">
              {rows.map((x) => (
                <div key={x.month} className="flex flex-1 flex-col items-center gap-1">
                  <div className="flex h-40 w-full items-end gap-0.5">
                    <div className="flex-1 rounded-t bg-navy-700" style={{ height: `${(x.hostsInPeak / max) * 100}%` }} title={`${x.hostsInPeak} hosts in peak`} />
                    <div className="flex-1 rounded-t bg-gold-500" style={{ height: `${(x.openingsStarting / max) * 100}%` }} title={`${x.openingsStarting} openings starting`} />
                  </div>
                  <span className="text-xs text-slate-500">{MONTHS[x.month - 1]}</span>
                </div>
              ))}
            </div>
            <p className="mt-2 text-xs"><span className="inline-block h-2 w-3 bg-navy-700" /> Hosts in peak season · <span className="inline-block h-2 w-3 bg-gold-500" /> Openings starting</p>
          </div>
        );
      }}</Async>
    </Card>
  );
}

function ExposureReport() {
  const r = useApi<any>('/reports/exposure');
  return <Async r={r}>{(x) => <div className="grid gap-3 sm:grid-cols-3"><Box label="Wages paid to date" value={money(x.wagesPaidToDate)} /><Box label="Not yet recovered" value={money(x.outstandingWageRecovery)} /><Box label="Bench pay (not billable)" value={money(x.benchPayNotRecoverable)} /></div>}</Async>;
}

function HostReport({ orgId, f }: { orgId: string; f: Record<string, string> }) {
  const r = useApi<any>(`/reports/hosts/${orgId}${qs({ from: f.from, to: f.to })}`);
  return (
    <Async r={r}>{(d) => (
      <div className="grid gap-4 md:grid-cols-2">
        {(['vacancies', 'performance', 'attendance', 'cost'] as const).map((k) => <Card key={k} title={label(k)} padded={false}><Generic rows={d[k]} money={k === 'cost'} /></Card>)}
      </div>
    )}</Async>
  );
}

function Generic({ rows, money: isMoney }: { rows: any[]; money?: boolean }) {
  const keys = Object.keys(rows[0] ?? {}).filter((k) => !/id$/i.test(k));
  return <Table rows={rows.map((x, i) => ({ ...x, id: i }))} empty="No data for this period." columns={keys.map((k) => ({ key: k, label: label(k), render: (x: any) => (isMoney && k !== 'period' && x[k] !== null && !isNaN(Number(x[k])) ? money(x[k]) : String(x[k] ?? '—')) }))} />;
}

function Box({ label: l, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return <div className="card p-4"><p className="text-xs font-medium text-slate-500 uppercase">{l}</p><p className="mt-1 text-2xl font-bold text-navy-950">{value}</p>{hint && <p className="text-xs text-slate-500">{hint}</p>}</div>;
}
