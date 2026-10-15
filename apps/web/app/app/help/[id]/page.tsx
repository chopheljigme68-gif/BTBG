'use client';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { Alert, Async, Badge, Card, PageHeader, Stars, SubmitButton, Textarea, formData, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { dateTime } from '@/lib/format';

export default function Ticket() {
  const { id } = useParams<{ id: string }>();
  const r = useApi<any>(`/helpdesk/tickets/mine/${id}`);
  const [stars, setStars] = useState(0);
  const [reply, replying] = useAction((b: any) => post(`/helpdesk/tickets/mine/${id}/messages`, b), { onDone: () => r.mutate() });
  const [confirm, confirming] = useAction(() => post(`/helpdesk/tickets/mine/${id}/confirm`, { satisfaction: stars }), { success: 'Thank you for the feedback', onDone: () => r.mutate() });
  return (
    <div className="mx-auto max-w-3xl">
      <Async r={r}>
        {(t) => (
          <>
            <PageHeader back={{ href: '/app/help', label: 'My tickets' }} title={`${t.ref}: ${t.subject}`} actions={<Badge status={t.status} />} />
            <Card>
              <ol className="space-y-3">
                {t.messages.map((m: any, i: number) => (
                  <li key={i} className={`max-w-[85%] rounded-xl p-3 text-sm ${m.authorKind === 'user' ? 'ml-auto bg-navy-900 text-white' : m.authorKind === 'system' ? 'mx-auto bg-slate-100 text-slate-600' : 'bg-cream'}`}>
                    <p className="whitespace-pre-line">{m.body}</p>
                    <p className={`mt-1 text-[11px] ${m.authorKind === 'user' ? 'text-navy-200' : 'text-slate-500'}`}>{m.authorKind === 'agent' ? 'BTBG helpdesk · ' : ''}{dateTime(m.at)}</p>
                  </li>
                ))}
              </ol>
              {!['closed', 'converted'].includes(t.status) && (
                <form className="mt-5 space-y-2" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; if (await reply(formData(f))) f.reset(); }}>
                  <Textarea name="body" label="Reply" required />
                  <SubmitButton busy={replying}>Send</SubmitButton>
                </form>
              )}
            </Card>
            {t.status === 'resolved' && !t.satisfaction && (
              <div className="mt-4">
                <Alert tone="ok" title="We marked this as solved">If it is, rate our help. If not, just reply above and the ticket reopens.</Alert>
                <div className="mt-3 flex items-center gap-4"><Stars value={stars} onChange={setStars} /><button className="btn-primary" disabled={!stars || confirming} onClick={() => confirm()}>Confirm solved</button></div>
              </div>
            )}
          </>
        )}
      </Async>
    </div>
  );
}
