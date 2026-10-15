'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Async, Badge, Card, Checkbox, Empty, Input, ModalButton, PageHeader, Select, SubmitButton, Tabs, Textarea, formData, useAction } from '@/components/ui';
import { del, post, useApi } from '@/lib/api';
import { date, dateTime, label, money } from '@/lib/format';

export default function SeekerJobsPage() {
  return <Suspense><SeekerJobs /></Suspense>;
}

function SeekerJobs() {
  const [tab, setTab] = useState(useSearchParams().get('tab') ?? 'recommended');
  const recs = useApi<any[]>(tab === 'recommended' ? '/me/recommendations' : null);
  const apps = useApi<any[]>('/me/applications');
  const saved = useApi<any[]>(tab === 'saved' ? '/me/saved' : null);
  const alerts = useApi<any[]>(tab === 'alerts' ? '/me/alerts' : null);
  const ref = useApi<any>('/public/reference');
  const [apply] = useAction((id: string) => post('/me/applications', { vacancyId: id }), { success: 'Applied. We will be in touch by SMS.', onDone: () => { recs.mutate(); apps.mutate(); } });
  const [unsave] = useAction((id: string) => del(`/me/saved/${id}`), { onDone: () => saved.mutate() });
  const [addAlert, adding] = useAction((b: any) => post('/me/alerts', b), { success: 'Alert saved. We will message you when matching jobs open.', onDone: () => alerts.mutate() });
  const [removeAlert] = useAction((id: string) => del(`/me/alerts/${id}`), { onDone: () => alerts.mutate() });

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Jobs" actions={<Link href="/jobs" className="btn-outline">Search all jobs</Link>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'recommended', label: 'Recommended' }, { id: 'applications', label: 'Applications', count: apps.data?.length }, { id: 'saved', label: 'Saved' }, { id: 'alerts', label: 'Job alerts' }]} />
      {tab === 'recommended' && (
        <Async r={recs} empty={<Empty title="No recommendations yet">Add skills, expected wage and preferred Dzongkhags to your profile.</Empty>}>
          {(rows) => (
            <div className="grid gap-3 md:grid-cols-2">
              {rows.map((v) => (
                <div key={v.id} className="card p-4">
                  <div className="flex justify-between gap-3">
                    <div><Link href={`/jobs/${v.share_slug ?? v.id}`} className="font-semibold text-navy-950 hover:underline">{v.title}</Link><p className="text-sm text-slate-600">{v.host} · {v.dzongkhag}</p></div>
                    <div className="text-right"><p className="font-bold text-gold-700">{money(v.wage)}</p><Badge tone={v.score >= 70 ? 'green' : 'blue'}>{v.score}% match</Badge></div>
                  </div>
                  <div className="mt-3 flex gap-2"><button className="btn-gold btn-sm" onClick={() => apply(v.id)}>Apply</button><Link className="btn-outline btn-sm" href={`/jobs/${v.share_slug ?? v.id}`}>Details</Link></div>
                </div>
              ))}
            </div>
          )}
        </Async>
      )}
      {tab === 'applications' && (
        <Async r={apps} empty={<Empty title="You have not applied yet" action={<Link href="/jobs" className="btn-gold">Find a job</Link>} />}>
          {(rows) => (
            <div className="space-y-3">
              {rows.map((a) => (
                <div key={a.id} className="card flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-navy-950">{a.title} <span className="font-normal text-slate-500">· {a.host}</span></p>
                    <p className="text-xs text-slate-500">Applied {date(a.appliedAt)} · {money(a.wage)}</p>
                    {a.interview && a.interview.status === 'scheduled' && <p className="mt-1 text-sm text-navy-800">📅 Interview {dateTime(a.interview.scheduledAt)} {a.interview.location}</p>}
                    {a.outcomeReason && <p className="mt-1 text-sm text-slate-600">{a.outcomeReason}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge status={a.stage} />
                    {!['hired', 'offered', 'withdrawn', 'not_selected'].includes(a.stage) && (
                      <ModalButton label="Withdraw" title="Withdraw application">
                        {(close) => <WithdrawForm id={a.id} onDone={() => { close(); apps.mutate(); }} />}
                      </ModalButton>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Async>
      )}
      {tab === 'saved' && (
        <Async r={saved} empty={<Empty title="No saved jobs">Tap ☆ Save on any job to keep it here.</Empty>}>
          {(rows) => (
            <Card padded={false}>
              <ul className="divide-y divide-navy-50">
                {rows.map((v) => (
                  <li key={v.id} className="flex items-center justify-between gap-3 p-4">
                    <div><Link href={`/jobs/${v.slug ?? v.id}`} className="font-medium hover:underline">{v.title}</Link><p className="text-xs text-slate-500">{v.host} · {money(v.wage)} {v.status !== 'open' && <Badge status={v.status} />}</p></div>
                    <button className="btn-ghost btn-sm" onClick={() => unsave(v.id)}>Remove</button>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </Async>
      )}
      {tab === 'alerts' && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="New alert">
            <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); addAlert(formData(e.currentTarget)); }}>
              <Input name="q" label="Keyword" placeholder="e.g. cook" />
              <Select name="sector" label="Sector" placeholder="Any" options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
              <Select name="dzongkhagId" data-number label="Dzongkhag" placeholder="Anywhere" options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
              <Input name="wageMin" type="number" label="Minimum wage (Nu)" min={0} />
              <Checkbox name="accommodation" label="Housing provided" />
              <Checkbox name="firstTime" label="Good for a first job" />
              <SubmitButton busy={adding}>Save alert</SubmitButton>
            </form>
          </Card>
          <Card title="My alerts">
            <Async r={alerts} empty={<p className="text-sm text-slate-500">No alerts yet.</p>}>
              {(rows) => (
                <ul className="divide-y divide-navy-50 text-sm">
                  {rows.map((a) => (
                    <li key={a.id} className="flex items-center justify-between py-2">
                      <span>{Object.entries(a.criteria).filter(([, v]) => v !== false).map(([k, v]) => (v === true ? label(k) : `${label(k)}: ${v}`)).join(' · ') || 'All new jobs'}</span>
                      <button className="btn-ghost btn-sm" onClick={() => removeAlert(a.id)}>Delete</button>
                    </li>
                  ))}
                </ul>
              )}
            </Async>
          </Card>
        </div>
      )}
    </div>
  );
}

function WithdrawForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/me/applications/${id}/withdraw`, b), { success: 'Application withdrawn', onDone });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(formData(e.currentTarget)); }}>
      <Textarea name="reason" label="Why are you withdrawing?" required minLength={2} />
      <SubmitButton busy={busy} className="btn-danger">Withdraw</SubmitButton>
    </form>
  );
}
