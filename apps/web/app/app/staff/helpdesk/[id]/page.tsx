'use client';
import Link from 'next/link';
import { use } from 'react';
import { Async, Badge, Card, Checkbox, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { dateTime, label } from '@/lib/format';

export default function Ticket({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/helpdesk/tickets/${id}`);
  const agents = useApi<any[]>('/helpdesk/agents');
  const refresh = () => r.mutate();
  const [reply, replying] = useAction((b: any) => post(`/helpdesk/tickets/${id}/reply`, b), { success: 'Reply sent', onDone: refresh });
  const [assign] = useAction((assigneeId: string) => post(`/helpdesk/tickets/${id}/assign`, { assigneeId }), { success: 'Assigned', onDone: refresh });
  const [convert, converting] = useAction((b: any) => post(`/helpdesk/tickets/${id}/convert`, b), { success: (g: any) => `Grievance ${g.ref ?? ''} opened`, onDone: refresh });
  return (
    <div className="mx-auto max-w-5xl space-y-4">
      <Async r={r}>
        {(t) => (
          <>
            <PageHeader title={`${t.ref}: ${t.subject}`} back={{ href: '/app/staff/helpdesk', label: 'Helpdesk' }} subtitle={<span className="flex gap-2"><Badge status={t.status} /><Badge status={t.priority} />{label(t.category)}</span>}
              actions={!t.grievance_id ? (
                <ModalButton label="Convert to grievance" title="Open a grievance case from this ticket">
                  {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await convert({ category: f.get('category'), shareIdentity: f.get('share') === 'on' })) close(); }}>
                    <Select name="category" label="Category" options={['pay', 'safety', 'harassment', 'working_hours', 'conduct', 'contract', 'other'].map((c) => ({ value: c, label: label(c) }))} />
                    <Checkbox name="share" label="Requester agrees to share their identity with the host" />
                    <SubmitButton busy={converting}>Convert</SubmitButton>
                  </form>}
                </ModalButton>
              ) : <Link className="btn-outline btn-sm" href={`/app/staff/grievances/${t.grievance_id}`}>Open grievance</Link>} />
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <Card title="Conversation">
                  <ul className="space-y-3">
                    {t.messages.map((m: any, i: number) => (
                      <li key={i} className={`max-w-[85%] rounded-xl p-3 text-sm ${m.authorKind === 'agent' ? 'ml-auto bg-navy-900 text-white' : 'bg-cream'}`}>
                        <p className="whitespace-pre-line">{m.body}</p>
                        <p className={`mt-1 text-xs ${m.authorKind === 'agent' ? 'text-navy-200' : 'text-slate-500'}`}>{m.author ?? (m.authorKind === 'agent' ? 'BTBG' : t.user_name ?? t.contact_name ?? 'Requester')} · {dateTime(m.at)}</p>
                      </li>
                    ))}
                  </ul>
                  {!['closed'].includes(t.status) && (
                    <form className="mt-4 space-y-2" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; const d = new FormData(f); if (await reply({ body: d.get('body'), status: d.get('status') || undefined })) f.reset(); }}>
                      <Textarea name="body" label="Reply" required rows={3} />
                      <div className="flex items-end gap-2"><Select name="status" label="Then set status" placeholder="Awaiting requester" options={['in_progress', 'awaiting_user', 'resolved'].map((s) => ({ value: s, label: label(s) }))} /><SubmitButton busy={replying}>Send</SubmitButton></div>
                    </form>
                  )}
                </Card>
              </div>
              <Card title="Ticket">
                <KeyValue items={[
                  ['Requester', t.user_name ?? t.contact_name ?? '—'], ['Mobile', t.contact_mobile], ['Email', t.contact_email], ['Page', t.page_url],
                  ['Opened', dateTime(t.created_at)], ['First response', t.first_response_at ? dateTime(t.first_response_at) : `due ${dateTime(t.response_due)}`],
                  ['Resolve by', dateTime(t.resolution_due)], ['Resolved', dateTime(t.resolved_at)], ['Satisfaction', t.satisfaction ? `${t.satisfaction}/5` : '—'],
                ]} />
                <label className="mt-3 block text-sm"><span className="label">Assignee</span>
                  <select className="input py-1.5" value={t.assignee_id ?? ''} onChange={(e) => e.target.value && assign(e.target.value)}>
                    <option value="">Unassigned</option>{agents.data?.map((a) => <option key={a.id} value={a.id}>{a.fullName}</option>)}
                  </select>
                </label>
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
