'use client';
import { useParams, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Async, Badge, Card, KeyValue, PageHeader, Stars, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { date, dateTime, label } from '@/lib/format';

export default function CasePage() {
  return <Suspense><Case /></Suspense>;
}

function Case() {
  const { id } = useParams<{ id: string }>();
  const isNew = useSearchParams().get('new');
  const r = useApi<any>(`/grievances/mine/${id}`);
  const [comment, setComment] = useState('');
  const [stars, setStars] = useState(0);
  const [respond, responding] = useAction((response: string) => post(`/grievances/mine/${id}/respond`, { response, comment: comment || undefined }), { success: 'Thank you. Your response was recorded.', onDone: () => r.mutate() });
  const [rate] = useAction(() => post(`/grievances/mine/${id}/satisfaction`, { score: stars }), { success: 'Thank you for rating us', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Async r={r}>
        {(g) => (
          <>
            <PageHeader back={{ href: '/app/grievances', label: 'My concerns' }} title={`${g.ref}: ${g.subject}`} actions={<Badge status={g.status} />} />
            {isNew && <Alert tone="ok" title="Your concern was received">Keep your reference <b>{g.ref}</b>. We will contact you by {dateTime(g.firstContactDue)} and aim to resolve it by {date(g.targetDate)}.</Alert>}
            <Card>
              <KeyValue items={[['Category', label(g.category)], ['Priority', g.severity === 1 ? 'Urgent' : g.severity === 2 ? 'High' : 'Normal'],
                ['First contact by', dateTime(g.firstContactDue)], ['Target resolution', date(g.targetDate)], ['Employer told your name', g.shareIdentity ? 'Yes' : 'No']]} />
              <p className="mt-4 rounded-lg bg-cream p-3 text-sm whitespace-pre-line">{g.description}</p>
            </Card>
            {g.status === 'resolution_proposed' && (
              <Card title="Proposed resolution">
                <p className="text-sm font-medium">{label(g.resolutionType)}</p>
                <p className="mt-1 text-sm whitespace-pre-line">{g.resolutionText}</p>
                <Textarea label="Comment (optional)" className="mt-3" value={comment} onChange={(e) => setComment(e.target.value)} />
                <div className="mt-3 flex gap-2">
                  <button className="btn-primary" disabled={responding} onClick={() => respond('accepted')}>I accept</button>
                  <button className="btn-outline" disabled={responding} onClick={() => respond('rejected')}>I do not accept: escalate</button>
                </div>
              </Card>
            )}
            {['resolved', 'closed'].includes(g.status) && !g.satisfaction && (
              <Card title="How did we handle it?">
                <div className="flex items-center gap-4"><Stars value={stars} onChange={setStars} /><button className="btn-primary" disabled={!stars} onClick={() => rate()}>Submit</button></div>
              </Card>
            )}
            <Card title="Timeline">
              <ol className="relative space-y-4 border-l-2 border-navy-100 pl-5">
                {g.timeline.map((a: any, i: number) => (
                  <li key={i}>
                    <span className="absolute -left-[7px] mt-1.5 h-3 w-3 rounded-full bg-gold-500" aria-hidden />
                    <p className="text-sm font-semibold text-navy-900">{label(a.action)}</p>
                    {a.note && <p className="text-sm text-slate-700">{a.note}</p>}
                    <p className="text-xs text-slate-500">{dateTime(a.at)}</p>
                  </li>
                ))}
              </ol>
            </Card>
            <Card title="If you are not satisfied">
              <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">{g.escalationSteps.map((s: string) => <li key={s}>{s}</li>)}</ol>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
