'use client';
import Link from 'next/link';
import { use } from 'react';
import { Alert, Async, Badge, Card, Checkbox, Input, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { dateTime, label } from '@/lib/format';

/** Grievance case handling: contact, investigate, propose, record response, refer, close (Workflow 6). */
export default function GrievanceCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/grievances/${id}`);
  const { me } = useMe();
  const staff = useApi<any[]>(can(me, 'grievances.view_all', 'grievances.escalation') ? '/admin/staff?role=grievance_officer' : null);
  const refresh = () => r.mutate();
  const useStep = (path: string, msg: string) => useAction((b: any) => post(`/grievances/${id}/${path}`, b), { success: msg, onDone: refresh });
  const [act, acting] = useStep('actions', 'Recorded');
  const [propose, proposing] = useStep('propose', 'Resolution proposed to the complainant');
  const [respond, responding] = useStep('record-response', 'Response recorded');
  const [refer, referring] = useStep('refer', 'Referred');
  const [close, closing] = useStep('close', 'Case closed');
  const [assign] = useStep('assign', 'Reassigned');
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Async r={r}>
        {(g) => {
          const open = !['resolved', 'closed'].includes(g.status);
          return (
            <>
              <PageHeader title={`${g.ref}: ${g.subject}`} back={{ href: '/app/staff/grievances', label: 'Grievances' }}
                subtitle={<span className="flex flex-wrap gap-2"><Badge tone={g.severity === 1 ? 'red' : g.severity === 2 ? 'amber' : 'gray'}>Severity {g.severity}</Badge><Badge status={g.status} />{label(g.category)} · via {label(g.channel)}</span>}
                actions={open && <div className="flex flex-wrap gap-2">
                  <ModalButton label="Record action" className="btn-primary btn-sm" title="Record an action">
                    {(c) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await act({ action: f.get('action'), note: f.get('note'), visibleToComplainant: f.get('visible') === 'on', severity: f.get('severity') ? Number(f.get('severity')) : undefined })) c(); }}>
                      <Select name="action" label="Action" options={['first_contact', 'note', 'contacted_host', 'evidence', 'finding'].map((a) => ({ value: a, label: label(a) }))} />
                      <Textarea name="note" label="Details" required minLength={2} />
                      <Select name="severity" label="Change severity" placeholder="Keep" options={[1, 2, 3].map((s) => ({ value: s, label: `Severity ${s}` }))} />
                      <Checkbox name="visible" label="Show this update to the complainant" />
                      <SubmitButton busy={acting}>Save</SubmitButton>
                    </form>}
                  </ModalButton>
                  <ModalButton label="Propose resolution" title="Propose a resolution">
                    {(c) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await propose({ resolutionType: f.get('type'), text: f.get('text') })) c(); }}>
                      <Select name="type" label="Type" options={['no_action', 'mediation', 'corrective_action', 'redeployment', 'other'].map((a) => ({ value: a, label: label(a) }))} />
                      <Textarea name="text" label="Proposal (the complainant sees this)" required minLength={10} />
                      <SubmitButton busy={proposing}>Send</SubmitButton>
                    </form>}
                  </ModalButton>
                  {g.status === 'resolution_proposed' && (
                    <ModalButton label="Record their response" title="Complainant's response by phone or SMS">
                      {(c) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await respond({ response: f.get('response'), note: f.get('note') || undefined })) c(); }}>
                        <Select name="response" label="Response" options={[{ value: 'accepted', label: 'Accepted' }, { value: 'rejected', label: 'Rejected (escalates)' }]} />
                        <Textarea name="note" label="Note" /><SubmitButton busy={responding}>Save</SubmitButton>
                      </form>}
                    </ModalButton>
                  )}
                  <ModalButton label="Refer to authority" title="Refer a possible legal breach">
                    {(c) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await refer({ authority: f.get('authority'), note: f.get('note') })) c(); }}>
                      <Input name="authority" label="Authority" placeholder="e.g. Department of Labour, MoICE" required minLength={3} /><Textarea name="note" label="Note" required minLength={5} /><SubmitButton busy={referring}>Refer</SubmitButton>
                    </form>}
                  </ModalButton>
                </div>}
              />
              {g.status === 'resolved' && <Card><form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); close({ note: new FormData(e.currentTarget).get('note') }); }}><Input name="note" label="Closing note" required /><SubmitButton busy={closing}>Close case</SubmitButton></form></Card>}
              {g.first_contact_at === null && <Alert tone="warn">First contact is due by {dateTime(g.first_contact_due)}.</Alert>}
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                  <Card title="What happened"><p className="whitespace-pre-line text-sm">{g.description}</p></Card>
                  {g.resolution_text && <Card title="Proposed resolution"><p className="text-sm"><b>{label(g.resolution_type)}</b>: {g.resolution_text}</p>{g.complainant_response && <p className="mt-1 text-sm">Complainant: <Badge tone={g.complainant_response === 'accepted' ? 'green' : 'red'}>{g.complainant_response}</Badge></p>}</Card>}
                  <Card title="Action log">
                    <ol className="space-y-3 border-l-2 border-navy-100 pl-4">
                      {g.actions.map((a: any, i: number) => <li key={i} className="text-sm"><b>{label(a.action)}</b> · {dateTime(a.at)} by {a.actor ?? 'system'} {a.visible && <Badge tone="blue">Visible to complainant</Badge>}<p className="whitespace-pre-line text-slate-700">{a.note}</p></li>)}
                    </ol>
                  </Card>
                </div>
                <div className="space-y-4">
                  <Card title="People">
                    <KeyValue items={[
                      ['Complainant', g.person ? <Link key="p" className="link" href={`/app/staff/candidates/${g.person.id}`}>{g.person.name}</Link> : g.complainant_name ?? label(g.complainant_party)],
                      ['Mobile', g.person?.mobile ?? g.complainant_mobile], ['Share identity with host', g.share_identity ? 'Yes' : 'No'],
                      ['Host', g.host ? <Link key="h" className="link" href={`/app/staff/hosts/${g.host.id}`}>{g.host.name}</Link> : '—'],
                      ['Placement', g.placement ? <Link key="pl" className="link" href={`/app/staff/placements/${g.placement.id}`}>{g.placement.roleTitle} ({label(g.placement.status)})</Link> : '—'],
                      ['Grievance officer', g.officer?.name ?? 'Unassigned'], ['Target date', dateTime(g.target_date)], ['Escalation level', g.escalation_level],
                    ]} />
                    {staff.data && open && (
                      <select className="input mt-3 py-1.5 text-sm" aria-label="Reassign" value="" onChange={(e) => e.target.value && assign({ officerId: e.target.value })}>
                        <option value="">Reassign to…</option>{staff.data.map((s) => <option key={s.id} value={s.id}>{s.fullName}</option>)}
                      </select>
                    )}
                  </Card>
                  <Card title="Escalation steps"><ol className="list-decimal space-y-1 pl-5 text-xs text-slate-600">{g.escalationSteps.map((s: any, i: number) => <li key={i} className={i + 1 === g.escalation_level ? 'font-semibold text-navy-900' : ''}>{typeof s === 'string' ? s : s.label ?? s.title ?? JSON.stringify(s)}</li>)}</ol></Card>
                </div>
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}
