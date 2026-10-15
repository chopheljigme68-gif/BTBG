'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Alert, Async, Badge, Card, Input, ModalButton, PageHeader, SubmitButton, Tabs, Textarea, useAction } from '@/components/ui';
import { post, qs, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label, money, relative } from '@/lib/format';

/** Requests from hosts and apprentices: conversation, warning, move, end, conversion (Workflow 4). */
export default function Requests() {
  const [status, setStatus] = useState('pending');
  const r = useApi<any[]>(`/placements/requests${qs({ status })}`);
  const { me } = useMe();
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <PageHeader title="Placement requests" back={{ href: '/app/staff/placements', label: 'Placements' }} />
      <Tabs value={status} onChange={setStatus} tabs={[{ id: 'pending', label: 'Open' }, { id: 'approved', label: 'Approved' }, { id: 'rejected', label: 'Rejected' }]} />
      <Async r={r}>
        {(rows) => rows.length === 0 ? <p className="text-sm text-slate-500">No requests.</p> : (
          <div className="space-y-3">
            {rows.map((q) => (
              <Card key={q.id} title={<>{label(q.kind)} request · <Link className="link" href={`/app/staff/placements/${q.placementId}`}>{q.apprentice} at {q.host}</Link></>} actions={<Badge status={q.status} />}>
                <p className="text-sm">{q.reason}</p>
                <p className="mt-1 text-xs text-slate-500">From {q.requesterParty} ({q.requestedBy}) · {relative(q.createdAt)} · {label(q.reasonCode)}{q.directHireWage && ` · direct hire ${money(q.directHireWage)} from ${date(q.directHireDate)}`}</p>
                {q.openGrievance && <div className="mt-2"><Alert tone="warn">There is an open grievance on this placement. {q.grievanceSignoffAt ? 'Grievance Officer has signed off.' : 'A Grievance Officer must sign off before it can end.'}</Alert></div>}
                {q.decisionNote && <p className="mt-1 text-xs">Decision: {q.decisionNote}</p>}
                {q.status === 'pending' && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {can(me, 'placements.approve_end') && <Decide q={q} onDone={() => r.mutate()} />}
                    {q.openGrievance && !q.grievanceSignoffAt && can(me, 'grievances.handle') && <Signoff id={q.id} onDone={() => r.mutate()} />}
                  </div>
                )}
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}

function Decide({ q, onDone }: { q: any; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/placements/requests/${q.id}/decide`, b), { success: 'Decision recorded; both parties notified', onDone });
  return (
    <ModalButton label="Decide" className="btn-primary btn-sm" title={`${label(q.kind)} request`}>
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const approve = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'yes'; if (await run({ approve, note: f.get('note'), endDate: f.get('endDate') || undefined, ncMapping: f.get('ncMapping') || undefined })) close(); }}>
          {['end', 'move', 'conversion'].includes(q.kind) && <Input name="endDate" type="date" label="End date (optional)" />}
          {q.kind === 'conversion' && <Input name="ncMapping" label="National Certificate mapping (optional)" />}
          <Textarea name="note" label="Decision note" required minLength={3} />
          <div className="flex gap-2"><SubmitButton busy={busy} value="yes">Approve</SubmitButton><SubmitButton busy={busy} value="no" className="btn-outline">Reject</SubmitButton></div>
        </form>
      )}
    </ModalButton>
  );
}

function Signoff({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((note: string) => post(`/placements/requests/${id}/grievance-signoff`, { note }), { success: 'Signed off', onDone });
  return (
    <ModalButton label="Grievance sign-off" title="Sign off the end request">
      {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('note') as string)) close(); }}><Textarea name="note" label="Note" required /><SubmitButton busy={busy}>Sign off</SubmitButton></form>}
    </ModalButton>
  );
}
