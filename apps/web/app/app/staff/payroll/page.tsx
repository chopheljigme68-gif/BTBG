'use client';
import { useRouter } from 'next/navigation';
import { Async, Badge, Card, PageHeader, SubmitButton, Table, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, money, todayBT } from '@/lib/format';

/** Monthly payroll runs (Workflow 5). */
export default function Payroll() {
  const r = useApi<any[]>('/payroll/runs');
  const adj = useApi<any[]>('/payroll/adjustments');
  const { me } = useMe();
  const router = useRouter();
  const [prepare, busy] = useAction((period: string) => post('/payroll/runs', { period }), { success: 'Draft run prepared', onDone: (x: any) => router.push(`/app/staff/payroll/${x.runId}`) });
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Payroll" subtitle="One person prepares, a different person approves. Approved runs are locked." />
      {can(me, 'payroll.prepare') && (
        <Card title="Prepare a run">
          <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); prepare(new FormData(e.currentTarget).get('period') as string); }}>
            <label className="text-sm"><span className="label">Month</span><input name="period" type="month" className="input" defaultValue={todayBT().slice(0, 7)} required /></label>
            <SubmitButton busy={busy}>Prepare or rebuild draft</SubmitButton>
          </form>
          <p className="mt-2 text-xs text-slate-500">Uses confirmed attendance; unconfirmed months are paid at full scheduled days and flagged.</p>
        </Card>
      )}
      <Async r={r}>
        {(rows) => (
          <div className="card overflow-hidden">
            <Table rows={rows} rowHref={(x) => `/app/staff/payroll/${x.id}`} empty="No payroll runs yet." columns={[
              { key: 'period', label: 'Month', render: (x) => <b>{x.period}</b> }, { key: 'status', label: 'Status', render: (x) => <Badge status={x.status} /> },
              { key: 'lineCount', label: 'Payslips' }, { key: 'flaggedCount', label: 'Flagged', render: (x) => x.flaggedCount ? <Badge tone="amber">{x.flaggedCount}</Badge> : 0 },
              { key: 'totalGross', label: 'Gross', render: (x) => money(x.totalGross) }, { key: 'totalNet', label: 'Net', render: (x) => money(x.totalNet) },
              { key: 'payDate', label: 'Pay date', render: (x) => date(x.payDate) }, { key: 'preparedBy', label: 'Prepared by' }, { key: 'approvedBy', label: 'Approved by' },
            ]} />
          </div>
        )}
      </Async>
      <Card title="Corrections waiting for the next run">
        <Async r={adj}>{(rows) => <Table rows={rows} empty="None." columns={[{ key: 'name', label: 'Apprentice' }, { key: 'amount', label: 'Amount', render: (a) => money(a.amount) }, { key: 'reason', label: 'Reason' }, { key: 'createdBy', label: 'By' }, { key: 'createdAt', label: 'Date', render: (a) => date(a.createdAt) }]} />}</Async>
      </Card>
    </div>
  );
}
