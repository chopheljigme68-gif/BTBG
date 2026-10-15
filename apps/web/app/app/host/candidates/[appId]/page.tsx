'use client';
import { use } from 'react';
import { Alert, Async, Badge, Card, KeyValue, PageHeader, Stars } from '@/components/ui';
import { useApi } from '@/lib/api';
import { date, label, money } from '@/lib/format';

/** Trust Profile (FR-PLC-03): what BTBG knows, without contact details until an interview is booked. */
export default function TrustProfile({ params }: { params: Promise<{ appId: string }> }) {
  const { appId } = use(params);
  const r = useApi<any>(`/host/applications/${appId}/trust-profile`);
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Async r={r}>
        {(t) => (
          <>
            <PageHeader title={t.name} back={{ href: '/app/host/vacancies', label: 'Vacancies' }} subtitle={<>{t.application.vacancy} · <Badge status={t.application.stage} /> {t.identityVerified && <Badge tone="green">ID verified</Badge>}</>} />
            <Card title="About">
              <KeyValue items={[
                ['Age', t.age ?? '—'], ['Gender', label(t.gender)], ['From', t.location || '—'], ['Expected wage', money(t.expectedWage)],
                ['Available from', date(t.availableFrom)], ['Languages', t.languages?.join(', ') || '—'], ['Interested in', t.preferredRoles?.join(', ') || '—'],
              ]} />
              {t.bio && <p className="mt-3 text-sm text-slate-700">{t.bio}</p>}
            </Card>
            {t.contact.hidden ? <Alert tone="info">{t.contact.reason}</Alert> : (
              <Card title="Contact"><KeyValue items={[['Mobile', <a key="m" className="link" href={`tel:${t.contact.mobile}`}>{t.contact.mobile}</a>], ['Email', t.contact.email ?? '—'], ['Village', t.contact.village ?? '—'], ['CID', t.contact.cid ?? '—']]} /></Card>
            )}
            {t.screening && (
              <Card title={`Screening: ${t.screening.score} points`} actions={<Badge tone={t.screening.passed ? 'green' : 'red'}>{t.screening.passed ? 'Passed' : 'Below threshold'}</Badge>}>
                <div className="space-y-2">
                  {t.screening.breakdown.map((b: any) => (
                    <div key={b.label} className="text-sm"><div className="flex justify-between"><span>{b.label}</span><span>{b.score}/{b.max}</span></div>
                      <div className="h-1.5 rounded bg-navy-50"><div className="h-1.5 rounded bg-navy-700" style={{ width: `${(b.score / b.max) * 100}%` }} /></div></div>
                  ))}
                </div>
                <p className="mt-2 text-xs text-slate-500">Commits to {t.screening.commitmentMonths ?? '—'} months · {date(t.screening.date)}</p>
              </Card>
            )}
            <div className="grid gap-6 md:grid-cols-2">
              <Card title="Skills">{t.skills.length ? <ul className="text-sm">{t.skills.map((s: any) => <li key={s.name} className="flex justify-between py-0.5">{s.name}<Stars value={s.level} size="text-sm" /></li>)}</ul> : <p className="text-sm text-slate-500">None listed.</p>}</Card>
              <Card title="Training">{t.training.length ? <ul className="text-sm">{t.training.map((x: any, i: number) => <li key={i} className="py-0.5">{x.programme} ({x.provider}) · {x.attendance_pct}% attendance · <Badge status={x.result} /></li>)}</ul> : <p className="text-sm text-slate-500">None yet.</p>}</Card>
              <Card title="Education and certificates">
                <ul className="text-sm">{t.credentials.map((c: any, i: number) => <li key={i}>{c.qualification ?? label(c.type)}, {c.institution} <Badge status={c.verification_status} /></li>)}
                  {t.certificates.map((c: any) => <li key={c.verification_code}>{c.title} · BTBG certificate {c.verification_code}</li>)}</ul>
              </Card>
              <Card title="References and past ratings">{t.references.length ? <ul className="text-sm">{t.references.map((x: any, i: number) => <li key={i}><Stars value={x.stars} size="text-sm" /> {x.host}{x.comment && `: “${x.comment}”`}</li>)}</ul> : <p className="text-sm text-slate-500">First placement.</p>}</Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}
