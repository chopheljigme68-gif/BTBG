'use client';
import Link from 'next/link';
import { Async, Badge, ModalButton, PageHeader, SubmitButton, Table, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { date, label, money } from '@/lib/format';

/** Apprentices between hosts, with redeployment deadlines (FR-PLC-30..33). */
export default function Bench() {
  const r = useApi<any[]>('/placements/bench');
  const [exit, busy] = useAction((id: string, reason: string) => post(`/placements/bench/${id}/exit`, { reason }), { success: 'Contract ended and certificate issued', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader title="Bench" back={{ href: '/app/staff/placements', label: 'Placements' }} subtitle="BTBG keeps paying bench pay until redeployment or the deadline." />
      <Async r={r}>
        {(rows) => (
          <div className="card overflow-hidden">
            <Table rows={rows} empty="Nobody is on bench." columns={[
              { key: 'name', label: 'Apprentice', render: (b: any) => <Link className="link font-medium" href={`/app/staff/candidates/${b.personId}`}>{b.name}</Link> },
              { key: 'previousHost', label: 'Previous host', render: (b: any) => <>{b.previousHost}<p className="text-xs text-slate-500">{b.endReason}</p></> },
              { key: 'startDate', label: 'Since', render: (b: any) => date(b.startDate) },
              { key: 'deadline', label: 'Deadline', render: (b: any) => <>{date(b.deadline)} {b.escalated ? <Badge tone="red">Escalated</Badge> : b.alerted80 ? <Badge tone="amber">80%</Badge> : b.alerted50 ? <Badge tone="gold">50%</Badge> : null}</> },
              { key: 'payRule', label: 'Pay', render: (b: any) => `${label(b.payRule)} of ${money(b.wage)}` },
              { key: 'x', label: '', render: (b: any) => (
                <ModalButton label="Record resignation" className="btn-ghost btn-sm" title={`${b.name} resigns`}>
                  {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await exit(b.id, new FormData(e.currentTarget).get('reason') as string)) close(); }}><Textarea name="reason" label="Reason" required minLength={3} /><SubmitButton busy={busy} className="btn-danger">End contract</SubmitButton></form>}
                </ModalButton>
              ) },
            ]} />
          </div>
        )}
      </Async>
    </div>
  );
}
