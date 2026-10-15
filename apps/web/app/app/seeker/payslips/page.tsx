'use client';
import { Async, Badge, Card, Empty, PageHeader } from '@/components/ui';
import { fileUrl, useApi } from '@/lib/api';
import { date, label, money } from '@/lib/format';

/** Payslips and payment history (FR-EE-22). */
export default function Payslips() {
  const r = useApi<any[]>('/me/payslips');
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My pay" subtitle="BTBG pays your salary to your bank account on the 25th of each month." />
      <Async r={r}>
        {(rows) => rows.length === 0 ? <Empty title="No payslips yet">Your first payslip appears after your first month on placement.</Empty> : (
          <div className="space-y-4">
            {rows.map((s) => (
              <Card key={s.id} title={`${monthName(s.period)} · ${money(s.net)}`} actions={<a className="btn-outline btn-sm" href={fileUrl(`/files/payslips/${s.id}`)} target="_blank" rel="noreferrer">Download PDF</a>}>
                <div className="grid gap-4 text-sm sm:grid-cols-2">
                  <div>
                    <p>Paid {date(s.payDate)} <Badge status={s.bankStatus} /></p>
                    <p className="text-slate-600">Worked {s.daysWorked} of {s.scheduledDays} days{Number(s.paidLeaveDays) > 0 && `, ${s.paidLeaveDays} paid leave`}{Number(s.benchDays) > 0 && `, ${s.benchDays} bench`}</p>
                  </div>
                  <table className="table">
                    <tbody>
                      <tr><td>Gross</td><td className="text-right">{money(s.gross)}</td></tr>
                      {s.lines.map((l: any, i: number) => <tr key={i}><td className="text-slate-600">{l.label ?? label(l.kind)}</td><td className="text-right">{money(l.amount)}</td></tr>)}
                      <tr className="font-semibold"><td>Net pay</td><td className="text-right">{money(s.net)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}

function monthName(period: string) {
  const [y, m] = period.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
