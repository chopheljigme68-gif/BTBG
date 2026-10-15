'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Input, KeyValue, ModalButton, PageHeader, Select, Stars, SubmitButton, Tabs, Textarea, useAction } from '@/components/ui';
import { fileUrl, post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label, money } from '@/lib/format';

/** Placement case file (FR-PLC-10..20): agreements, check-ins, attendance, ratings, requests and outcome. */
export default function PlacementCase({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/placements/${id}`);
  const { me } = useMe();
  const [tab, setTab] = useState('overview');
  const refresh = () => r.mutate();
  const [start, starting] = useAction(() => post(`/placements/${id}/start`), { success: (x: any) => `Placement is now ${label(x.status)}`, onDone: refresh });
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Async r={r}>
        {(p) => {
          const live = ['active', 'ending'].includes(p.status);
          return (
            <>
              <PageHeader title={`${p.apprentice} at ${p.host}`} back={{ href: '/app/staff/placements', label: 'Placements' }}
                subtitle={<span className="flex flex-wrap items-center gap-2">{p.role_title} <Badge status={p.status} />{p.outcome && <Badge tone="gold">{label(p.outcome)}</Badge>}</span>}
                actions={<div className="flex flex-wrap gap-2">
                  {p.status === 'contracted' && can(me, 'placements.manage') && <button className="btn-gold btn-sm" disabled={starting} onClick={() => start()}>Start now</button>}
                  {live && can(me, 'placements.manage') && <AmendButton p={p} onDone={refresh} />}
                  {live && can(me, 'checkins.manage', 'placements.manage') && <RequestButton id={id} onDone={refresh} />}
                  {live && can(me, 'placements.approve_end') && <EndButton id={id} onDone={refresh} />}
                  {['active', 'ending', 'ended'].includes(p.status) && !p.outcome && can(me, 'placements.approve_end') && <OutcomeButton id={id} onDone={refresh} />}
                </div>} />
              {Array.isArray(p.grievances) ? p.grievances.some((g: any) => !['resolved', 'closed'].includes(g.status)) && <Alert tone="warn">Open grievance on this placement.</Alert> : p.grievances?.[0]?.open > 0 && <Alert tone="warn">Open grievance on this placement.</Alert>}
              <Tabs value={tab} onChange={setTab} tabs={[
                { id: 'overview', label: 'Overview' }, { id: 'checkins', label: 'Check-ins', count: p.checkins.filter((c: any) => !c.completedAt).length },
                { id: 'attendance', label: 'Attendance' }, { id: 'feedback', label: 'Notes and ratings' }, { id: 'requests', label: 'Requests', count: p.requests.length }, { id: 'history', label: 'History' },
              ]} />
              {tab === 'overview' && (
                <div className="grid gap-4 lg:grid-cols-3">
                  <Card title="Placement" className="lg:col-span-2">
                    <KeyValue items={[
                      ['Apprentice', <Link key="a" className="link" href={`/app/staff/candidates/${p.person_id}`}>{p.apprentice}</Link>], ['Mobile', p.apprentice_mobile],
                      ['Host', <Link key="h" className="link" href={`/app/staff/hosts/${p.org_id}`}>{p.host}</Link>], ['Supervisor', p.supervisor], ['Officer', p.officer],
                      ['Dates', `${date(p.start_date)} to ${date(p.actual_end_date ?? p.planned_end_date)}`], ['Wage', money(p.wage)],
                      p.contract && ['Contract terms', `${p.contract.hours_per_week} h over ${p.contract.days_per_week} days, ${p.contract.rest_days_per_week} rest, ${p.contract.leave_days_per_year} leave days (v${p.contract.version}, ${label(p.contract.status)})`],
                      p.hpa && ['Fees', `Placement ${money(p.hpa.placement_fee)}, service ${money(p.hpa.monthly_service_fee)}/month, admin ${p.hpa.admin_fee_pct}%`],
                      p.hpa && ['Replacements', `${p.hpa.replacements_used} of ${p.hpa.replacement_entitlement} within ${p.hpa.replacement_period_days} days`],
                      p.end_reason_text && ['End reason', `${label(p.end_reason_code)}: ${p.end_reason_text}`], p.outcome_reason && ['Outcome', `${label(p.outcome)}: ${p.outcome_reason}`],
                    ]} />
                  </Card>
                  <div className="space-y-4">
                    <Card title="Agreements"><ul className="space-y-1 text-sm">{p.documents.map((d: any) => <li key={d.id} className="flex justify-between gap-2"><span>{d.kind === 'hpa' ? 'Host agreement' : 'Employment contract'} v{d.version} <Badge status={d.status} /></span><a className="link" target="_blank" rel="noreferrer" href={fileUrl(`/files/agreements/${d.id}`)}>PDF</a></li>)}</ul></Card>
                    {p.bench.length > 0 && <Card title="Bench periods"><ul className="text-sm">{p.bench.map((b: any) => <li key={b.id}>{date(b.startDate)} to {b.endedAt ? date(b.endedAt) : `deadline ${date(b.deadline)}`}{b.endReason && ` · ${b.endReason}`}</li>)}</ul></Card>}
                    {p.certificates.length > 0 && <Card title="Certificates"><ul className="text-sm">{p.certificates.map((c: any) => <li key={c.code}>{c.title} · <Link className="link" href={`/verify/${c.code}`}>{c.code}</Link></li>)}</ul></Card>}
                  </div>
                </div>
              )}
              {tab === 'checkins' && <Checkins p={p} onDone={refresh} />}
              {tab === 'attendance' && (
                <Card>{p.attendance.length === 0 ? <p className="text-sm text-slate-500">No attendance yet.</p> : (
                  <table className="table"><thead><tr><th>Month</th><th>Scheduled</th><th>Worked</th><th>Absences</th><th>Paid leave</th><th>Confirmed</th></tr></thead>
                    <tbody>{p.attendance.map((a: any) => <tr key={a.period}><td>{a.period}</td><td>{a.scheduledDays}</td><td>{a.daysWorked}</td><td>{a.absenceDates?.length ?? 0}</td><td>{a.paidLeaveDays}</td><td>{a.confirmedAt ? dateTime(a.confirmedAt) : a.defaulted ? <Badge tone="amber">Defaulted</Badge> : '—'}</td></tr>)}</tbody></table>
                )}</Card>
              )}
              {tab === 'feedback' && (
                <div className="grid gap-4 lg:grid-cols-2">
                  <Card title="Host performance notes">{p.notes.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="divide-y divide-navy-50 text-sm">{p.notes.map((n: any, i: number) => <li key={i} className="py-2">{dateTime(n.at)} · {n.author}<p className="text-xs text-slate-500">Punctuality {n.punctuality} · Skills {n.skills} · Attitude {n.attitude} · Teamwork {n.teamwork} · Customer care {n.customerCare}</p>{n.note && <p>{n.note}</p>}</li>)}</ul>}</Card>
                  <Card title="Ratings">{p.ratings.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="divide-y divide-navy-50 text-sm">{p.ratings.map((x: any, i: number) => <li key={i} className="py-2"><Stars value={x.stars} size="text-sm" /> {label(x.fromParty)} rated {label(x.toParty)} · {label(x.context)} · {date(x.at)}{x.comment && <p className="text-slate-600">“{x.comment}”</p>}</li>)}</ul>}</Card>
                </div>
              )}
              {tab === 'requests' && <Card>{p.requests.length === 0 ? <p className="text-sm text-slate-500">No requests.</p> : <ul className="divide-y divide-navy-50 text-sm">{p.requests.map((q: any) => <li key={q.id} className="py-2"><b>{label(q.kind)}</b> from {q.requesterParty} <Badge status={q.status} /> · {date(q.createdAt)}<p>{q.reason}</p>{q.decisionNote && <p className="text-xs text-slate-500">Decision: {q.decisionNote}</p>}</li>)}</ul>}<Link className="link mt-2 inline-block text-sm" href="/app/staff/placements/requests">Open the request queue</Link></Card>}
              {tab === 'history' && <Card><ul className="space-y-1 text-sm">{p.history.map((h: any, i: number) => <li key={i}>{h.from ? `${label(h.from)} → ` : ''}<b>{label(h.to)}</b> · {dateTime(h.at)} by {h.by ?? 'system'}{h.reason && <span className="text-slate-500"> · {h.reason}</span>}</li>)}</ul></Card>}
            </>
          );
        }}
      </Async>
    </div>
  );
}

function Checkins({ p, onDone }: { p: any; onDone: () => void }) {
  const { me } = useMe();
  return (
    <Card>
      <ul className="divide-y divide-navy-50 text-sm">
        {p.checkins.map((c: any) => (
          <li key={c.id} className="flex flex-wrap items-start justify-between gap-2 py-2.5">
            <div>
              <b>Day {c.day}</b> · {label(c.party)} · due {date(c.dueDate)} {c.overdue && <Badge tone="red">Overdue</Badge>} {c.riskRating && <Badge status={c.riskRating} />}
              {c.completedAt && <p className="text-xs text-slate-500">Done {dateTime(c.completedAt)} by {c.completedBy}</p>}
              {c.formData && <p className="text-xs text-slate-600">{Object.entries(c.formData).map(([k, v]) => `${label(k)}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</p>}
            </div>
            {!c.completedAt && c.party === 'officer' && can(me, 'checkins.manage') && <OfficerCheckin placementId={p.id} c={c} onDone={onDone} />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function OfficerCheckin({ placementId, c, onDone }: { placementId: string; c: any; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/placements/${placementId}/checkins/${c.id}`, b), { success: 'Check-in saved', onDone });
  return (
    <ModalButton label="Complete" className="btn-primary btn-sm" title={`Day ${c.day} officer check-in`}>
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const g = (k: string) => f.get(k) as string; if (await run({ formData: { attendance: g('attendance'), performance: g('performance'), wellbeing: g('wellbeing'), concerns: g('concerns') || undefined }, riskRating: g('risk') })) close(); }}>
          <Textarea name="attendance" label="Attendance" required rows={2} />
          <Textarea name="performance" label="Performance" required rows={2} />
          <Textarea name="wellbeing" label="Wellbeing" required rows={2} />
          <Textarea name="concerns" label="Concerns" rows={2} />
          <Select name="risk" label="Risk rating" options={[{ value: 'green', label: 'Green: on track' }, { value: 'amber', label: 'Amber: watch' }, { value: 'red', label: 'Red: act now' }]} />
          <SubmitButton busy={busy}>Save</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function AmendButton({ p, onDone }: { p: any; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/placements/${p.id}/amend-contract`, b), { success: 'New contract version sent to the apprentice to sign', onDone });
  const c = p.contract ?? {};
  return (
    <ModalButton label="Amend contract" title="Change contract terms">
      {(close) => (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const n = (k: string) => Number(f.get(k)); if (await run({ wage: n('wage'), hoursPerWeek: n('hoursPerWeek'), daysPerWeek: n('daysPerWeek'), restDaysPerWeek: n('restDaysPerWeek'), leaveDaysPerYear: n('leaveDaysPerYear'), reason: f.get('reason') })) close(); }}>
          <Input name="wage" type="number" label="Wage" defaultValue={c.wage} required /><Input name="hoursPerWeek" type="number" label="Hours a week" defaultValue={c.hours_per_week} required />
          <Input name="daysPerWeek" type="number" label="Days a week" defaultValue={c.days_per_week} required /><Input name="restDaysPerWeek" type="number" label="Rest days" defaultValue={c.rest_days_per_week} required />
          <Input name="leaveDaysPerYear" type="number" label="Leave days a year" defaultValue={c.leave_days_per_year} required />
          <div className="sm:col-span-2"><Textarea name="reason" label="Reason" required /></div>
          <SubmitButton busy={busy}>Create new version</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function RequestButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/placements/${id}/requests`, b), { success: 'Request raised', onDone });
  return (
    <ModalButton label="Raise request" title="Officer request">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await run({ kind: f.get('kind'), reason: f.get('reason') })) close(); }}>
          <Select name="kind" label="Kind" options={['conversation', 'warning', 'move', 'end'].map((k) => ({ value: k, label: label(k) }))} />
          <Textarea name="reason" label="Reason" required minLength={5} />
          <SubmitButton busy={busy}>Raise</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function EndButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/placements/${id}/end`, b), { success: 'Placement ended; apprentice moved to bench', onDone });
  return (
    <ModalButton label="End early" className="btn-danger btn-sm" title="End placement early">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await run({ reasonCode: f.get('reasonCode'), reason: f.get('reason'), endDate: f.get('endDate') || undefined })) close(); }}>
          <Alert tone="info">The apprentice stays employed by BTBG on bench pay while we redeploy them.</Alert>
          <Select name="reasonCode" label="Why" options={['host_decision', 'apprentice_request', 'btbg_monitoring', 'other'].map((k) => ({ value: k, label: label(k) }))} />
          <Input name="endDate" type="date" label="Last day (default today)" />
          <Textarea name="reason" label="Details" required minLength={5} />
          <SubmitButton busy={busy} className="btn-danger">End placement</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function OutcomeButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [kind, setKind] = useState('conversion');
  const [run, busy] = useAction((b: any) => post(`/placements/${id}/outcome`, b), { success: 'Outcome recorded and certificate issued', onDone });
  return (
    <ModalButton label="Record outcome" className="btn-gold btn-sm" title="Programme outcome">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await run({ outcome: kind, reason: f.get('reason'), directHireWage: kind === 'conversion' ? Number(f.get('wage')) : undefined, directHireDate: kind === 'conversion' ? f.get('date') : undefined, ncMapping: f.get('nc') || undefined })) close(); }}>
          <Select label="Outcome" value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: 'conversion', label: 'Conversion: host hires directly' }, { value: 'move', label: 'Move to another host' }, { value: 'exit', label: 'Exit the programme' }]} />
          {kind === 'conversion' && <div className="grid grid-cols-2 gap-3"><Input name="wage" type="number" label="Direct-hire wage" required /><Input name="date" type="date" label="Direct-hire date" required /></div>}
          <Input name="nc" label="National Certificate mapping (optional)" />
          <Textarea name="reason" label="Notes" required minLength={3} />
          <SubmitButton busy={busy}>Save outcome</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
