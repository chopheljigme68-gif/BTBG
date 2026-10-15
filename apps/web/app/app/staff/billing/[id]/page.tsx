'use client';
import { use } from 'react';
import { Async, Badge, Card, KeyValue, ModalButton, PageHeader, SubmitButton, Textarea, useAction } from '@/components/ui';
import { fileUrl, post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label, money } from '@/lib/format';

export default function Invoice({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/billing/invoices/${id}`);
  const { me } = useMe();
  const [issue, issuing] = useAction(() => post(`/billing/invoices/${id}/issue`), { success: 'Issued to the host', onDone: () => r.mutate() });
  const [wo, writing] = useAction((reason: string) => post(`/billing/invoices/${id}/write-off`, { reason }), { success: 'Written off', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <Async r={r}>
        {(inv) => (
          <>
            <PageHeader title={`Invoice ${inv.number}`} back={{ href: '/app/staff/billing', label: 'Billing' }} subtitle={<>{inv.host} · {inv.period} <Badge status={inv.status} /></>}
              actions={<div className="flex gap-2">
                <a className="btn-outline btn-sm" target="_blank" rel="noreferrer" href={fileUrl(`/files/invoices/${id}`)}>PDF</a>
                {inv.status === 'draft' && can(me, 'billing.manage') && <button className="btn-gold btn-sm" disabled={issuing} onClick={() => issue()}>Issue</button>}
                {['issued', 'part_paid', 'overdue'].includes(inv.status) && can(me, 'billing.manage') && (
                  <ModalButton label="Write off" className="btn-danger btn-sm" title="Write off the balance">
                    {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await wo(new FormData(e.currentTarget).get('reason') as string)) close(); }}><Textarea name="reason" label="Reason" required /><SubmitButton busy={writing} className="btn-danger">Write off</SubmitButton></form>}
                  </ModalButton>
                )}
              </div>} />
            <Card><KeyValue items={[['Issued', date(inv.issue_date)], ['Due', date(inv.due_date)], ['Subtotal', money(inv.subtotal)], ['Credits', money(inv.credits)], ['Total', money(inv.total)], ['Paid', money(inv.amount_paid)], ['Balance', <b key="b">{money(Number(inv.total) - Number(inv.amount_paid))}</b>]]} /></Card>
            <Card title="Lines">
              <table className="table"><thead><tr><th>Type</th><th>Description</th><th className="text-right">Amount</th></tr></thead>
                <tbody>{inv.lines.map((l: any, i: number) => <tr key={i}><td>{label(l.type)}</td><td>{l.description}</td><td className="text-right">{money(l.amount)}</td></tr>)}<tr className="font-semibold"><td colSpan={2}>Total</td><td className="text-right">{money(inv.total)}</td></tr></tbody></table>
            </Card>
            <Card title="Payments applied">{inv.allocations.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : <ul className="text-sm">{inv.allocations.map((a: any, i: number) => <li key={i}>{date(a.receivedOn)} · {money(a.amount)} by {label(a.method)}{a.reference && ` (${a.reference})`}</li>)}</ul>}</Card>
          </>
        )}
      </Async>
    </div>
  );
}
