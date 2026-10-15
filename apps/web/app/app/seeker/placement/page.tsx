'use client';
import { useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, Empty, KeyValue, ModalButton, PageHeader, Stars, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { date, label, relative } from '@/lib/format';

/** Current placement, check-ins, move requests and ratings (FR-EE-21..25, 30, 31). */
export default function Placement() {
  const r = useApi<any>('/me/placement');
  const ratings = useApi<any[]>('/me/ratings');
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My placement" />
      <Async r={r}>
        {(d) => (
          <>
            {d.bench && <Alert tone="info" title="Between hosts">You stay employed by BTBG while we find your next host (by {date(d.bench.deadline)}).</Alert>}
            {!d.placement ? <Empty title="No active placement">When BTBG places you with a host, details and check-ins appear here.</Empty> : (
              <>
                {d.nextCheckin && <CheckinCard checkin={d.nextCheckin} onDone={() => r.mutate()} />}
                <Card title={`${d.placement.roleTitle} at ${d.placement.host}`} actions={<Badge status={d.placement.status} />}>
                  <KeyValue items={[
                    ['Workplace', d.placement.hostAddress],
                    ['Supervisor', d.placement.supervisor && <>{d.placement.supervisor} {d.placement.supervisorMobile && <a className="link" href={`tel:${d.placement.supervisorMobile}`}>{d.placement.supervisorMobile}</a>}</>],
                    ['Started', date(d.placement.startDate)],
                    ['Planned end', date(d.placement.plannedEndDate)],
                    d.placement.schedule && ['Schedule', `${d.placement.schedule.hoursPerWeek} hours over ${d.placement.schedule.daysPerWeek} days, ${d.placement.schedule.restDaysPerWeek} rest day(s) a week`],
                  ]} />
                  <div className="mt-4 flex flex-wrap gap-2">
                    <MoveRequest onDone={() => r.mutate()} />
                    <RateWorkplace placementId={d.placement.id} />
                  </div>
                </Card>
                <Card title="Check-ins">
                  <ul className="divide-y divide-navy-50 text-sm">
                    {d.checkins.map((c: any) => (
                      <li key={c.id} className="flex justify-between py-2"><span>Day {c.day} · due {date(c.dueDate)}</span>{c.completedAt ? <Badge tone="green">Done {date(c.completedAt)}</Badge> : <Badge tone="gold">Open</Badge>}</li>
                    ))}
                  </ul>
                </Card>
                {d.requests.length > 0 && (
                  <Card title="My requests">
                    <ul className="text-sm">{d.requests.map((q: any, i: number) => <li key={i} className="py-1">{label(q.kind)} request · <Badge status={q.status} /> · {relative(q.createdAt)}</li>)}</ul>
                  </Card>
                )}
              </>
            )}
          </>
        )}
      </Async>
      <Card title="Feedback from hosts">
        <Async r={ratings}>
          {(rows) => rows.length === 0 ? <p className="text-sm text-slate-500">No ratings yet.</p> : (
            <ul className="divide-y divide-navy-50">
              {rows.map((x, i) => (
                <li key={i} className="py-2 text-sm"><Stars value={x.stars} size="text-base" /> <b>{x.host}</b> · {label(x.context)} · {date(x.at)}{x.comment && <p className="text-slate-600">“{x.comment}”</p>}</li>
              ))}
            </ul>
          )}
        </Async>
      </Card>
    </div>
  );
}

const SCALE = ['Very poor', 'Poor', 'OK', 'Good', 'Very good'];

function CheckinCard({ checkin, onDone }: { checkin: any; onDone: () => void }) {
  const [v, setV] = useState({ attendance: 0, performance: 0, wellbeing: 0, stars: 0 });
  const [concerns, setConcerns] = useState('');
  const [comment, setComment] = useState('');
  const [wantsToLeave, setLeave] = useState(false);
  const [run, busy] = useAction(() => post(`/me/checkins/${checkin.id}`, {
    attendance: v.attendance, performance: v.performance, wellbeing: v.wellbeing, concerns: concerns || undefined, wantsToLeave,
    hostRating: { stars: v.stars, comment: comment || undefined },
  }), { success: 'Thank you. Your field officer will read this.', onDone });
  const ready = v.attendance && v.performance && v.wellbeing && v.stars;
  const row = (k: keyof typeof v, q: string) => (
    <div className="flex flex-wrap items-center justify-between gap-2 py-1.5">
      <span className="text-sm">{q}</span>
      <span className="flex items-center gap-2"><Stars value={v[k]} onChange={(n) => setV((x) => ({ ...x, [k]: n }))} /><span className="w-20 text-xs text-slate-500">{SCALE[v[k] - 1] ?? ''}</span></span>
    </div>
  );
  return (
    <Card title={`Day ${checkin.day} check-in`} className="ring-2 ring-gold-500">
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
        {row('attendance', 'How is your attendance going?')}
        {row('performance', 'How well are you learning the work?')}
        {row('wellbeing', 'How are you feeling at work?')}
        {row('stars', 'How would you rate your workplace?')}
        <Textarea label="Anything about your workplace" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
        <Textarea label="Any worries? (only BTBG sees this)" value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={1000} />
        <Checkbox label="I would like to leave this placement" checked={wantsToLeave} onChange={(e) => setLeave(e.target.checked)} />
        <SubmitButton busy={busy} disabled={!ready} className="btn-gold">Send check-in</SubmitButton>
      </form>
    </Card>
  );
}

function MoveRequest({ onDone }: { onDone: () => void }) {
  const [run, busy] = useAction((reason: string) => post('/me/placement/move-request', { reason }), { success: 'Request sent to BTBG', onDone });
  return (
    <ModalButton label="Ask to move to another host" title="Ask BTBG to move you">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const reason = new FormData(e.currentTarget).get('reason') as string; if (await run(reason)) close(); }}>
          <p className="text-sm text-slate-600">Your host is not told until BTBG has spoken with you. You remain employed by BTBG.</p>
          <Textarea name="reason" label="Why would you like to move?" required minLength={5} />
          <SubmitButton busy={busy}>Send request</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function RateWorkplace({ placementId }: { placementId: string }) {
  const [stars, setStars] = useState(0);
  const [run, busy] = useAction((comment: string) => post('/me/placement/rating', { placementId, stars, comment: comment || undefined }), { success: 'Thank you for your rating' });
  return (
    <ModalButton label="Rate my workplace" title="Rate your workplace">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('comment') as string)) close(); }}>
          <Stars value={stars} onChange={setStars} />
          <Textarea name="comment" label="Comment (optional)" maxLength={1000} />
          <SubmitButton busy={busy} disabled={!stars}>Submit</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
