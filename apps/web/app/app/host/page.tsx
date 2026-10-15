'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Alert, Async, Badge, Card, PageHeader, Stat } from '@/components/ui';
import { useApi } from '@/lib/api';
import { useMe } from '@/lib/auth';
import { date, money } from '@/lib/format';

export default function HostHomePage() {
  return <Suspense><HostHome /></Suspense>;
}

function HostHome() {
  const { me } = useMe();
  const welcome = useSearchParams().get('welcome');
  const r = useApi<any>('/host/dashboard');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Async r={r}>
        {(d) => (
          <>
            <PageHeader title={d.org.name} subtitle={<>Kuzuzangpo, {me?.user.fullName.split(' ')[0]}. <Badge status={d.org.verificationStatus} /></>}
              actions={<Link href="/app/host/vacancies/new" className="btn-gold">Post a vacancy</Link>} />
            {welcome && <Alert tone="ok" title="Your business is registered">BTBG will verify your trade licence, address and owner identity. Upload documents on your company profile to speed this up.</Alert>}
            {d.org.verificationStatus !== 'verified' && <Alert tone="warn" title="Verification pending">You can prepare vacancies now. They go live after BTBG verifies your business. <Link href="/app/host/profile" className="font-semibold underline">Upload documents</Link></Alert>}
            {d.org.status === 'suspended' && <Alert tone="error" title="Account suspended">Contact BTBG operations.</Alert>}
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label="Open vacancies" value={d.openVacancies} hint={`${d.draftVacancies} in draft or review`} href="/app/host/vacancies" />
              <Stat label="Candidates to review" value={d.candidatesToReview} tone={d.candidatesToReview ? 'gold' : 'navy'} href="/app/host/vacancies" />
              <Stat label="Apprentices" value={d.activeApprentices} href="/app/host/roster" />
              <Stat label="Balance due" value={money(d.invoicesDue.balance)} hint={`${d.invoicesDue.n} unpaid invoice(s)`} tone={Number(d.invoicesDue.balance) > 0 ? 'red' : 'green'} href="/app/host/invoices" />
            </div>
            <div className="grid gap-6 md:grid-cols-2">
              <Card title="To do">
                <ul className="space-y-2 text-sm">
                  {d.agreementsToSign > 0 && <li>📝 <Link className="link" href="/app/host/agreements">{d.agreementsToSign} placement agreement(s) to sign</Link></li>}
                  {d.attendancePending > 0 && <li>🗓️ <Link className="link" href={`/app/host/attendance?period=${d.period}`}>Confirm {d.period} attendance for {d.attendancePending} apprentice(s)</Link></li>}
                  {d.candidatesToReview > 0 && <li>👤 <Link className="link" href="/app/host/vacancies">{d.candidatesToReview} candidate(s) waiting for your decision</Link></li>}
                  {!d.agreementsToSign && !d.attendancePending && !d.candidatesToReview && <li className="text-slate-500">You are all caught up.</li>}
                </ul>
              </Card>
              <Card title="Check-ins due" actions={<Link className="btn-ghost btn-sm" href="/app/host/checkins">All</Link>}>
                {d.nextCheckins.length === 0 ? <p className="text-sm text-slate-500">No check-ins due.</p> : (
                  <ul className="divide-y divide-navy-50 text-sm">{d.nextCheckins.map((c: any) => <li key={c.id} className="flex justify-between py-2"><span>Day {c.day} · {c.apprentice}</span><span className="text-slate-500">{date(c.dueDate)}</span></li>)}</ul>
                )}
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
