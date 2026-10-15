'use client';
import { useState } from 'react';
import { Async, Badge, Card, Input, ModalButton, PageHeader, Select, Stars, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, put, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date } from '@/lib/format';

const CRITERIA = [['punctuality', 'Punctuality'], ['skills', 'Skills'], ['attitude', 'Attitude'], ['teamwork', 'Teamwork'], ['customerCare', 'Customer care']] as const;

/** Apprentices on placement with notes, requests and ratings (FR-EMP-30..34, 40). */
export default function Roster() {
  const r = useApi<any[]>('/host/roster');
  const users = useApi<any[]>('/host/users');
  const { me } = useMe();
  const admin = can(me, 'host.admin');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Apprentices" subtitle="BTBG employs and pays them. You supervise their daily work." />
      <Async r={r} empty={<p className="text-sm text-slate-500">No apprentices yet.</p>}>
        {(rows) => (
          <div className="grid gap-4 md:grid-cols-2">
            {rows.map((a) => (
              <Card key={a.id} title={a.name} actions={<Badge status={a.status} />}>
                <p className="text-sm">{a.roleTitle} · {date(a.startDate)} to {date(a.plannedEndDate)}</p>
                <p className="text-sm text-slate-600">Supervisor: {a.supervisor ?? 'not assigned'} · Next check-in: {date(a.nextCheckin)}</p>
                <p className="text-xs text-slate-500">Last attendance: {a.lastAttendance ? `${a.lastAttendance.period} ${a.lastAttendance.confirmedAt ? 'confirmed' : 'not confirmed'}` : 'none yet'}</p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <NoteButton id={a.id} />
                  <RequestButton id={a.id} owner={me?.activeRole === 'host_owner'} onDone={() => r.mutate()} />
                  <RateButton id={a.id} />
                  {admin && <SupervisorButton id={a.id} current={a.supervisorId} users={users.data ?? []} onDone={() => r.mutate()} />}
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}

function CriteriaInputs({ v, set }: { v: Record<string, number>; set: (k: string, n: number) => void }) {
  return <div className="space-y-1">{CRITERIA.map(([k, l]) => <div key={k} className="flex items-center justify-between text-sm">{l}<Stars value={v[k] ?? 0} onChange={(n) => set(k, n)} size="text-xl" /></div>)}</div>;
}
const complete = (v: Record<string, number>) => CRITERIA.every(([k]) => v[k]);

function NoteButton({ id }: { id: string }) {
  const [v, setV] = useState<Record<string, number>>({});
  const [run, busy] = useAction((note: string) => post(`/host/roster/${id}/notes`, { ...v, note: note || undefined }), { success: 'Note saved' });
  return (
    <ModalButton label="Add performance note" title="Performance note">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('note') as string)) { setV({}); close(); } }}>
          <CriteriaInputs v={v} set={(k, n) => setV((x) => ({ ...x, [k]: n }))} />
          <Textarea name="note" label="Note" maxLength={1000} />
          <SubmitButton busy={busy} disabled={!complete(v)}>Save</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function RateButton({ id }: { id: string }) {
  const [v, setV] = useState<Record<string, number>>({});
  const [run, busy] = useAction((comment: string) => post(`/host/roster/${id}/rating`, { criteria: v, comment: comment || undefined }), { success: 'Rating saved' });
  return (
    <ModalButton label="End-of-placement rating" title="Rate the apprentice">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('comment') as string)) close(); }}>
          <CriteriaInputs v={v} set={(k, n) => setV((x) => ({ ...x, [k]: n }))} />
          <Textarea name="comment" label="Comment (the apprentice can see this)" maxLength={1000} />
          <SubmitButton busy={busy} disabled={!complete(v)}>Submit</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function RequestButton({ id, owner, onDone }: { id: string; owner: boolean; onDone: () => void }) {
  const [kind, setKind] = useState('conversation');
  const [run, busy] = useAction((b: any) => post(`/host/roster/${id}/requests`, b), { success: 'Request sent to BTBG', onDone });
  const kinds = [['conversation', 'Ask BTBG to talk with the apprentice'], ['warning', 'Formal warning'], ['move', 'Move to another host'], ['end', 'End the placement'], ...(owner ? [['conversion', 'Hire directly (conversion)']] : [])];
  return (
    <ModalButton label="Request" title="Request to BTBG">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault(); const f = new FormData(e.currentTarget);
          if (await run({ kind, reason: f.get('reason'), directHireWage: kind === 'conversion' ? Number(f.get('wage')) : undefined, directHireDate: kind === 'conversion' ? f.get('date') : undefined })) close();
        }}>
          <Select label="What do you need?" value={kind} onChange={(e) => setKind(e.target.value)} options={kinds.map(([value, label]) => ({ value, label }))} />
          {kind === 'conversion' && <div className="grid grid-cols-2 gap-3"><Input name="wage" type="number" label="Direct-hire wage (Nu)" required /><Input name="date" type="date" label="Start date" required /></div>}
          <Textarea name="reason" label="Reason" required minLength={5} />
          <SubmitButton busy={busy}>Send</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function SupervisorButton({ id, current, users, onDone }: { id: string; current: string | null; users: any[]; onDone: () => void }) {
  const [run, busy] = useAction((userId: string) => put(`/host/roster/${id}/supervisor`, { userId }), { success: 'Supervisor assigned', onDone });
  return (
    <ModalButton label="Supervisor" title="Assign a supervisor">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('userId') as string)) close(); }}>
          <Select name="userId" label="Supervisor" defaultValue={current ?? ''} required placeholder="Choose" options={users.map((u) => ({ value: u.id, label: `${u.fullName} (${u.role === 'host_owner' ? 'Owner' : 'Supervisor'})` }))} />
          <SubmitButton busy={busy}>Assign</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
