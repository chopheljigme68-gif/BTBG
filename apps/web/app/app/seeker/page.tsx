'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Alert, Async, Badge, Card, Empty, PageHeader, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, dateTime, label, money } from '@/lib/format';

export default function SeekerHomePage() {
  return <Suspense><SeekerHome /></Suspense>;
}

function SeekerHome() {
  const { me } = useMe();
  const welcome = useSearchParams().get('welcome');
  const r = useApi<any>('/me/dashboard');
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={`Kuzuzangpo, ${me?.user.fullName.split(' ')[0] ?? ''}`} subtitle="Here is what is happening with your BTBG journey." />
      {welcome && <Alert tone="ok" title="Welcome to BTBG">Your account is ready. A field officer will call you soon. Meanwhile, complete your profile so we can match you faster.</Alert>}
      <Async r={r}>
        {(d) => (
          <>
            {d.contract?.toSign && <Alert tone="warn" title="Your contract is ready to sign">Read it and sign with an SMS code. <Link href="/app/seeker/contract" className="font-semibold underline">Open contract</Link></Alert>}
            {d.bench && <Alert tone="info" title="You are still employed by BTBG">We are finding your next host by {date(d.bench.deadline)}. You are paid bench pay meanwhile.</Alert>}
            {d.nextCheckin && <Alert tone="info" title={`Day ${d.nextCheckin.day} check-in due ${date(d.nextCheckin.dueDate)}`}>It takes two minutes. <Link href="/app/seeker/placement" className="font-semibold underline">Do it now</Link></Alert>}
            <div className="grid gap-4 sm:grid-cols-3">
              <Stat label="Profile complete" value={`${d.completeness.score}%`} tone={d.completeness.score >= 80 ? 'green' : 'gold'} href="/app/seeker/profile" />
              <Stat label="Stage" value={label(d.person.stage)} hint={label(d.person.lifecycle)} />
              <Stat label="Last pay" value={d.latestPayslip ? money(d.latestPayslip.net) : '—'} hint={d.latestPayslip ? `${d.latestPayslip.period}, paid ${date(d.latestPayslip.payDate)}` : 'Paid on the 25th each month'} href={d.latestPayslip ? '/app/seeker/payslips' : undefined} />
            </div>
            {d.completeness.tips.length > 0 && (
              <Card title="Make your profile stronger">
                <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">{d.completeness.tips.slice(0, 4).map((t: string) => <li key={t}>{t}</li>)}</ul>
                <Link href="/app/seeker/profile" className="btn-primary btn-sm mt-3">Update profile</Link>
              </Card>
            )}
            {d.placement && (
              <Card title="My placement" actions={<Link className="btn-outline btn-sm" href="/app/seeker/placement">Details</Link>}>
                <p className="font-semibold">{d.placement.roleTitle} at {d.placement.host} <Badge status={d.placement.status} /></p>
                <p className="text-sm text-slate-600">{date(d.placement.startDate)} to {date(d.placement.plannedEndDate)}</p>
              </Card>
            )}
            {d.interviews.length > 0 && (
              <Card title="Upcoming interviews">
                <ul className="space-y-2 text-sm">{d.interviews.map((i: any, k: number) => <li key={k}><b>{dateTime(i.scheduledAt)}</b> · {i.title} at {i.host}{i.location ? ` (${i.location})` : ''}</li>)}</ul>
              </Card>
            )}
            <div className="grid gap-6 md:grid-cols-2">
              <Card title="Jobs for you" actions={<Link className="btn-ghost btn-sm" href="/app/seeker/jobs">See all</Link>}>
                {d.recommendations.length === 0 ? <Empty title="No matches yet">Add skills and preferred places to get better matches.</Empty> : (
                  <ul className="divide-y divide-navy-50">
                    {d.recommendations.map((v: any) => (
                      <li key={v.id} className="flex items-center justify-between gap-3 py-2.5">
                        <div><Link className="font-medium text-navy-900 hover:underline" href={`/jobs/${v.share_slug ?? v.id}`}>{v.title}</Link><p className="text-xs text-slate-500">{v.host} · {v.dzongkhag}</p></div>
                        <div className="text-right text-sm"><p className="font-semibold text-gold-700">{money(v.wage)}</p><p className="text-xs text-slate-500">{v.score}% match</p></div>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              <Card title="My applications" actions={<Link className="btn-ghost btn-sm" href="/app/seeker/jobs?tab=applications">All</Link>}>
                {d.applications.length === 0 ? <Empty title="No applications yet" action={<Link href="/jobs" className="btn-gold btn-sm">Find a job</Link>} /> : (
                  <ul className="divide-y divide-navy-50 text-sm">{d.applications.map((a: any) => <li key={a.id} className="flex justify-between py-2.5"><span>{a.title} · <span className="text-slate-500">{a.host}</span></span><Badge status={a.stage} /></li>)}</ul>
                )}
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
