'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Input, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { date, dateTime, label, money } from '@/lib/format';
import { VacancyForm, vacancyToForm } from '@/components/vacancy-form';

export default function HostVacancy({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/host/vacancies/${id}`);
  const [editing, setEditing] = useState(false);
  const [submit, submitting] = useAction(() => post(`/host/vacancies/${id}/submit`), { success: 'Sent to BTBG for review', onDone: () => r.mutate() });
  const [status] = useAction((s: string) => post(`/host/vacancies/${id}/status`, { status: s }), { success: 'Updated', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <Async r={r}>
        {(v) => editing ? (
          <>
            <PageHeader title={`Edit: ${v.title}`} actions={<button className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>} />
            <VacancyForm id={id} initial={vacancyToForm(v)} />
          </>
        ) : (
          <>
            <PageHeader title={v.title} back={{ href: '/app/host/vacancies', label: 'Vacancies' }} subtitle={<Badge status={v.status} />}
              actions={<div className="flex flex-wrap gap-2">
                {['draft', 'submitted', 'paused', 'open'].includes(v.status) && <button className="btn-outline btn-sm" onClick={() => setEditing(true)}>Edit</button>}
                {v.status === 'draft' && <button className="btn-gold btn-sm" disabled={submitting} onClick={() => submit()}>Send for review</button>}
                {v.status === 'open' && <button className="btn-outline btn-sm" onClick={() => status('paused')}>Pause</button>}
                {['paused', 'filled'].includes(v.status) && <button className="btn-outline btn-sm" onClick={() => status('open')}>Reopen</button>}
                {['open', 'paused', 'filled'].includes(v.status) && <button className="btn-danger btn-sm" onClick={() => confirm('Close this vacancy?') && status('closed')}>Close</button>}
              </div>} />
            {v.status === 'draft' && v.review_comment && <Alert tone="warn" title="BTBG returned this vacancy">{v.review_comment}</Alert>}
            {v.status === 'submitted' && <Alert tone="info">BTBG is reviewing this vacancy. You will get an SMS when it goes live.</Alert>}
            {v.expectedDaysToFill && <Alert tone="info" title="Finding candidates">No ready candidates match yet. BTBG is sourcing and training new ones; typical time to fill is about {v.expectedDaysToFill} days.</Alert>}
            <Card title="Shortlist from BTBG">
              {v.shortlist.length === 0 ? <p className="text-sm text-slate-500">BTBG shares screened candidates here once the vacancy is open.</p> : (
                <ul className="divide-y divide-navy-50">
                  {v.shortlist.map((a: any) => <ShortlistRow key={a.id} a={a} wage={Number(v.wage)} onChange={() => r.mutate()} />)}
                </ul>
              )}
            </Card>
            <Card title="Details">
              <KeyValue items={[
                ['Openings', `${v.filled} filled of ${v.openings}`], ['Wage', money(v.wage)], ['Hours per week', v.hours_per_week ?? '—'], ['Shift', v.shift_pattern ?? '—'],
                ['Start date', date(v.start_date)], ['Accommodation', v.accommodation ? 'Yes' : 'No'], ['Meals', v.meals ? 'Yes' : 'No'],
                v.is_seasonal && ['Season', `${date(v.season_start)} to ${date(v.season_end)}`], v.share_slug && ['Public link', <Link key="l" className="link" href={`/jobs/${v.share_slug}`}>/jobs/{v.share_slug}</Link>],
              ]} />
              {v.description && <p className="mt-3 whitespace-pre-line text-sm text-slate-700">{v.description}</p>}
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}

function ShortlistRow({ a, wage, onChange }: { a: any; wage: number; onChange: () => void }) {
  const [decide, busy] = useAction((decision: string, reason: string) => post(`/host/applications/${a.id}/decision`, { decision, reason }), { success: 'Decision saved', onDone: onChange });
  const [book, booking] = useAction((b: any) => post(`/host/applications/${a.id}/interview`, b), { success: 'Interview booked; SMS sent to the candidate', onDone: onChange });
  const [result, saving] = useAction((b: any) => post(`/host/interviews/${a.interview.id}/result`, b), { success: 'Result saved', onDone: onChange });
  const open = !['not_selected', 'withdrawn', 'hired'].includes(a.stage) && a.hostDecision !== 'declined';
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 py-3">
      <div>
        <Link className="font-semibold text-navy-900 hover:underline" href={`/app/host/candidates/${a.id}`}>{a.name}</Link> <Badge status={a.stage} /> {a.hostDecision && <Badge tone={a.hostDecision === 'accepted' ? 'green' : 'red'}>{label(a.hostDecision)}</Badge>}
        <p className="text-xs text-slate-500">Screening score {a.screeningScore ?? '—'} · shared {date(a.sharedAt)}{a.interview && ` · interview ${dateTime(a.interview.scheduledAt)} (${label(a.interview.status)})`}{a.offerWage && ` · offer ${money(a.offerWage)} from ${date(a.offerStartDate)}`}</p>
      </div>
      {open && (
        <div className="flex flex-wrap gap-2">
          <Link className="btn-ghost btn-sm" href={`/app/host/candidates/${a.id}`}>Trust profile</Link>
          {a.interview?.status !== 'scheduled' && a.stage !== 'offered' && (
            <ModalButton label="Book interview" title={`Interview ${a.name}`}>
              {(close) => (
                <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await book({ scheduledAt: new Date(f.get('at') as string).toISOString(), location: f.get('location'), mode: f.get('mode') })) close(); }}>
                  <Input name="at" type="datetime-local" label="Date and time" required />
                  <Input name="location" label="Where" required minLength={2} />
                  <Select name="mode" label="How" options={[{ value: 'in_person', label: 'In person' }, { value: 'phone', label: 'Phone' }, { value: 'video', label: 'Video' }]} />
                  <SubmitButton busy={booking}>Book</SubmitButton>
                </form>
              )}
            </ModalButton>
          )}
          {a.interview?.status === 'scheduled' && (
            <ModalButton label="Record result" title="Interview result and offer">
              {(close) => (
                <form className="space-y-3" onSubmit={async (e) => {
                  e.preventDefault(); const f = new FormData(e.currentTarget); const pass = f.get('result') === 'pass';
                  if (await result({ result: f.get('result'), notes: f.get('notes') || undefined, reason: pass ? undefined : f.get('notes') || undefined, offer: pass ? { wage: Number(f.get('wage')), startDate: f.get('startDate') } : undefined })) close();
                }}>
                  <Select name="result" label="Result" options={[{ value: 'pass', label: 'Pass: make an offer' }, { value: 'fail', label: 'Not selected' }]} />
                  <Input name="wage" type="number" label="Offered wage (Nu)" defaultValue={wage} />
                  <Input name="startDate" type="date" label="Start date" />
                  <Textarea name="notes" label="Notes or reason" />
                  <SubmitButton busy={saving}>Save</SubmitButton>
                </form>
              )}
            </ModalButton>
          )}
          {['shortlisted', 'interview'].includes(a.stage) && !a.hostDecision && <button className="btn-outline btn-sm" disabled={busy} onClick={() => decide('accepted', 'Suitable for interview')}>Accept</button>}
          {['shortlisted', 'interview'].includes(a.stage) && (
            <ModalButton label="Decline" className="btn-ghost btn-sm text-red-700" title={`Decline ${a.name}`}>
              {(close) => (
                <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await decide('declined', new FormData(e.currentTarget).get('reason') as string)) close(); }}>
                  <Textarea name="reason" label="Reason (shared with BTBG, helps us improve matches)" required minLength={3} />
                  <SubmitButton busy={busy} className="btn-danger">Decline</SubmitButton>
                </form>
              )}
            </ModalButton>
          )}
        </div>
      )}
    </li>
  );
}
