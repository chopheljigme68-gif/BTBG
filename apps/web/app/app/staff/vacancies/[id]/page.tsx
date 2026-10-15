'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Input, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Table, Tabs, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label, money } from '@/lib/format';

/** Vacancy review, matching, shortlisting and offer confirmation (Workflows 1 and 2). */
export default function Vacancy({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/vacancies/${id}`);
  const { me } = useMe();
  const [tab, setTab] = useState('candidates');
  const refresh = () => r.mutate();
  const [approve, approving] = useAction((comment?: string) => post(`/vacancies/${id}/approve`, { comment }), { success: 'Approved and live; matching job seekers notified', onDone: refresh });
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Async r={r}>
        {(v) => (
          <>
            <PageHeader title={v.title} back={{ href: '/app/staff/vacancies', label: 'Vacancies' }}
              subtitle={<span className="flex flex-wrap items-center gap-2"><Link className="link" href={`/app/staff/hosts/${v.org_id}`}>{v.host}</Link><Badge status={v.host_verification} /><Badge status={v.status} />{v.created_on_behalf && <Badge tone="blue">Field visit{v.host_confirmed_at ? ', host confirmed' : ''}</Badge>}</span>}
              actions={<div className="flex flex-wrap gap-2">
                {v.status === 'submitted' && can(me, 'vacancies.review') && <>
                  <button className="btn-gold btn-sm" disabled={approving} onClick={() => approve()}>Approve and publish</button>
                  <ReturnButton id={id} onDone={refresh} />
                </>}
                {can(me, 'vacancies.review', 'vacancies.manage_any') && <StatusButton id={id} status={v.status} onDone={refresh} />}
                {v.share_slug && <Link className="btn-ghost btn-sm" href={`/jobs/${v.share_slug}`} target="_blank">Public page</Link>}
              </div>} />
            {v.status === 'submitted' && v.host_verification !== 'verified' && <Alert tone="warn">Verify the host before approving this vacancy.</Alert>}
            <Tabs value={tab} onChange={setTab} tabs={[{ id: 'candidates', label: 'Applications', count: v.applications.length }, ...(v.status === 'open' && can(me, 'matching.manage') ? [{ id: 'matches', label: 'Suggested matches' }] : []), { id: 'details', label: 'Details' }, { id: 'history', label: 'History' }]} />
            {tab === 'candidates' && <Applications v={v} onDone={refresh} />}
            {tab === 'matches' && <Matches id={id} onDone={refresh} />}
            {tab === 'details' && (
              <Card>
                <KeyValue items={[
                  ['Openings', `${v.filled} filled of ${v.openings}`], ['Wage', money(v.wage)], ['Hours', v.hours_per_week ? `${v.hours_per_week} per week` : '—'], ['Shift', v.shift_pattern],
                  ['Start', date(v.start_date)], ['Location', [v.location_text, v.dzongkhag].filter(Boolean).join(', ')], ['Accommodation', v.accommodation ? 'Yes' : 'No'], ['Meals', v.meals ? 'Yes' : 'No'],
                  ['First-time friendly', v.first_time_friendly ? 'Yes' : 'No'], ['Experience', v.experience_required], ['Skills', v.skills.map((s: any) => s.name).join(', ') || '—'],
                  v.is_seasonal && ['Season', `${date(v.season_start)} to ${date(v.season_end)}`], ['Benefits', v.benefits],
                ]} />
                {v.description && <p className="mt-3 whitespace-pre-line text-sm">{v.description}</p>}
              </Card>
            )}
            {tab === 'history' && <Card><ul className="space-y-1 text-sm">{v.history.map((h: any, i: number) => <li key={i}>{h.from ? `${label(h.from)} → ` : ''}<b>{label(h.to)}</b> · {dateTime(h.at)} by {h.by ?? 'system'}{h.comment && <span className="text-slate-500"> · {h.comment}</span>}</li>)}</ul></Card>}
          </>
        )}
      </Async>
    </div>
  );
}

function Applications({ v, onDone }: { v: any; onDone: () => void }) {
  const { me } = useMe();
  const [move] = useAction((appId: string, stage: string, reason: string) => post(`/vacancies/applications/${appId}/stage`, { stage, reason }), { success: 'Updated', onDone });
  return (
    <Card padded={false}>
      <Table rows={v.applications} empty="No applications yet." columns={[
        { key: 'name', label: 'Candidate', render: (a: any) => <Link className="link font-medium" href={`/app/staff/candidates/${a.personId}`}>{a.name}</Link> },
        { key: 'stage', label: 'Stage', render: (a: any) => <><Badge status={a.stage} /> {a.hostDecision && <Badge tone={a.hostDecision === 'accepted' ? 'green' : 'red'}>Host {a.hostDecision}</Badge>}</> },
        { key: 'source', label: 'Source', render: (a: any) => label(a.source) },
        { key: 'matchScore', label: 'Match', render: (a: any) => a.matchScore ? `${a.matchScore}%` : '—' },
        { key: 'expectedWage', label: 'Expects', render: (a: any) => money(a.expectedWage) },
        { key: 'interview', label: 'Interview / offer', render: (a: any) => a.offerWage ? `${money(a.offerWage)} from ${date(a.offerStartDate)}` : a.interview ? `${dateTime(a.interview.scheduledAt)} (${label(a.interview.status)})` : '—' },
        { key: 'actions', label: '', render: (a: any) => (
          <div className="flex flex-wrap justify-end gap-1">
            {a.stage === 'offered' && can(me, 'placements.manage') && <ConfirmOffer a={a} v={v} onDone={onDone} />}
            {a.placementId && <Link className="btn-ghost btn-sm" href={`/app/staff/placements/${a.placementId}`}>Placement</Link>}
            {['applied', 'screening'].includes(a.stage) && <button className="btn-ghost btn-sm" onClick={() => { const r = prompt('Reason for not selecting'); if (r) move(a.id, 'not_selected', r); }}>Not selected</button>}
            {a.stage === 'applied' && <button className="btn-outline btn-sm" onClick={() => move(a.id, 'screening', 'Moved to screening')}>Screen</button>}
          </div>
        ) },
      ]} />
    </Card>
  );
}

function Matches({ id, onDone }: { id: string; onDone: () => void }) {
  const r = useApi<any[]>(`/vacancies/${id}/matches`);
  const [sel, setSel] = useState<Record<string, string>>({});
  const [share, sharing] = useAction(() => post(`/vacancies/${id}/shortlist`, { items: Object.entries(sel).map(([personId, reason]) => ({ personId, reason: reason || 'Strong match' })) }), { success: 'Shortlist shared with the host', onDone: () => { setSel({}); r.mutate(); onDone(); } });
  const [reject] = useAction((personId: string, reason: string, score: number) => post(`/vacancies/${id}/reject-match`, { personId, reason, score }), { success: 'Recorded', onDone: () => r.mutate() });
  return (
    <Card title="Ranked candidates" actions={<button className="btn-gold btn-sm" disabled={!Object.keys(sel).length || sharing} onClick={() => share()}>Share {Object.keys(sel).length || ''} with host</button>}>
      <p className="mb-3 text-xs text-slate-500">Score weights skills, screening, location, wage fit and availability. Hosts only see candidates you share.</p>
      <Async r={r}>
        {(rows) => (
          <Table rows={rows.map((m) => ({ ...m, id: m.personId }))} empty="No ready candidates match. A sourcing task was created." columns={[
            { key: 'pick', label: '', render: (m: any) => !m.shared && <input type="checkbox" className="h-4 w-4 accent-navy-900" aria-label={`Select ${m.name}`} checked={m.personId in sel} onChange={(e) => setSel((s) => { const n = { ...s }; if (e.target.checked) n[m.personId] = ''; else delete n[m.personId]; return n; })} /> },
            { key: 'name', label: 'Candidate', render: (m: any) => <><Link className="link font-medium" href={`/app/staff/candidates/${m.personId}`}>{m.name}</Link><p className="text-xs text-slate-500">{m.dzongkhag} · <Badge status={m.stage} />{m.onBench && <Badge tone="amber">Bench</Badge>}</p></> },
            { key: 'score', label: 'Match', render: (m: any) => <span title={Object.entries(m.breakdown).map(([k, v]) => `${k}: ${Math.round(Number(v) * 100)}%`).join(', ')} className="font-semibold">{Math.round(m.score)}%</span> },
            { key: 'screeningScore', label: 'Screening' },
            { key: 'wageGap', label: 'Wage', render: (m: any) => `${money(m.expectedWage)} vs ${money(m.offeredWage)}` },
            { key: 'applied', label: 'Status', render: (m: any) => m.shared ? <Badge tone="green">Shared</Badge> : m.applied ? <Badge status={m.applicationStage} /> : 'Suggested' },
            { key: 'reason', label: 'Why share', render: (m: any) => m.personId in sel && <input className="input py-1 text-xs" placeholder="Strong match" value={sel[m.personId]} onChange={(e) => setSel((s) => ({ ...s, [m.personId]: e.target.value }))} /> },
            { key: 'x', label: '', render: (m: any) => !m.shared && <button className="btn-ghost btn-sm" onClick={() => { const reason = prompt(`Why not share ${m.name}?`); if (reason) reject(m.personId, reason, m.score); }}>Skip</button> },
          ]} />
        )}
      </Async>
    </Card>
  );
}

function ConfirmOffer({ a, v, onDone }: { a: any; v: any; onDone: () => void }) {
  const staff = useApi<any[]>('/admin/staff?role=field_officer');
  const [run, busy] = useAction((b: any) => post('/placements/confirm-offer', b), { success: 'Contract and placement agreement generated and sent for signing', onDone });
  return (
    <ModalButton label="Confirm offer" className="btn-gold btn-sm" title={`Confirm offer for ${a.name}`}>
      {(close) => (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
          e.preventDefault(); const f = new FormData(e.currentTarget); const n = (k: string) => Number(f.get(k));
          if (await run({ applicationId: a.id, startDate: f.get('startDate'), wage: n('wage'), hoursPerWeek: n('hoursPerWeek'), daysPerWeek: n('daysPerWeek'), restDaysPerWeek: n('restDaysPerWeek'), leaveDaysPerYear: n('leaveDaysPerYear'), months: n('months'), officerId: (f.get('officerId') as string) || null })) close();
        }}>
          <Input name="wage" type="number" label="Monthly wage (Nu)" defaultValue={a.offerWage ?? v.wage} required />
          <Input name="startDate" type="date" label="Start date" defaultValue={a.offerStartDate ?? ''} required />
          <Input name="hoursPerWeek" type="number" label="Hours per week" defaultValue={v.hours_per_week ?? 48} required />
          <Input name="daysPerWeek" type="number" label="Days per week" defaultValue={6} required />
          <Input name="restDaysPerWeek" type="number" label="Rest days per week" defaultValue={1} required />
          <Input name="leaveDaysPerYear" type="number" label="Paid leave days a year" defaultValue={18} required />
          <Select name="months" label="Programme length" defaultValue="6" options={[3, 4, 5, 6].map((m) => ({ value: m, label: `${m} months` }))} />
          <Select name="officerId" label="Placement officer" placeholder="Me" options={staff.data?.map((s) => ({ value: s.id, label: s.fullName })) ?? []} />
          <p className="text-xs text-slate-500 sm:col-span-2">Fees come from the matching fee rule. Both parties get an SMS to sign.</p>
          <div className="sm:col-span-2"><SubmitButton busy={busy}>Generate agreements</SubmitButton></div>
        </form>
      )}
    </ModalButton>
  );
}

function ReturnButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((comment: string) => post(`/vacancies/${id}/return`, { comment }), { success: 'Returned to the host', onDone });
  return (
    <ModalButton label="Return with comments" title="Return to host">
      {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('comment') as string)) close(); }}><Textarea name="comment" label="What should the host change?" required /><SubmitButton busy={busy}>Return</SubmitButton></form>}
    </ModalButton>
  );
}

function StatusButton({ id, status, onDone }: { id: string; status: string; onDone: () => void }) {
  const next = ({ open: ['paused', 'filled', 'closed'], paused: ['open', 'closed'], filled: ['open', 'closed'], draft: ['closed'], submitted: ['closed'] } as Record<string, string[]>)[status] ?? [];
  const [run, busy] = useAction((b: any) => post(`/vacancies/${id}/status`, b), { success: 'Updated', onDone });
  if (!next.length) return null;
  return (
    <ModalButton label="Change status" title="Change vacancy status">
      {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await run({ status: f.get('status'), comment: f.get('comment') || undefined })) close(); }}>
        <Select name="status" label="New status" options={next.map((s) => ({ value: s, label: label(s) }))} /><Textarea name="comment" label="Comment" /><SubmitButton busy={busy}>Save</SubmitButton>
      </form>}
    </ModalButton>
  );
}
