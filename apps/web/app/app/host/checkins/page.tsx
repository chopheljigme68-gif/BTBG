'use client';
import { useState } from 'react';
import { Async, Badge, Card, PageHeader, Stars, SubmitButton, Textarea, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { date } from '@/lib/format';

const CRITERIA = [['punctuality', 'Punctuality'], ['skills', 'Skills'], ['attitude', 'Attitude'], ['teamwork', 'Teamwork'], ['customerCare', 'Customer care']] as const;
const QUESTIONS = [['attendance', 'Attendance'], ['performance', 'Work performance'], ['wellbeing', 'How the apprentice seems to be coping']] as const;

/** Day 7/30/60/90 host check-ins with apprentice rating (FR-EMP-40). */
export default function HostCheckins() {
  const r = useApi<any[]>('/host/checkins');
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Check-ins" subtitle="Short reviews on day 7, 30, 60 and 90 help BTBG support your apprentices early." />
      <Async r={r} empty={<p className="text-sm text-slate-500">No check-ins yet.</p>}>
        {(rows) => (
          <div className="space-y-4">
            {rows.filter((c) => !c.completedAt).map((c) => <CheckinForm key={c.id} c={c} onDone={() => r.mutate()} />)}
            <Card title="Completed">
              <ul className="divide-y divide-navy-50 text-sm">
                {rows.filter((c) => c.completedAt).map((c) => <li key={c.id} className="flex justify-between py-2"><span>Day {c.day} · {c.apprentice}</span><span>{date(c.completedAt)} <Badge status={c.riskRating} /></span></li>)}
              </ul>
            </Card>
          </div>
        )}
      </Async>
    </div>
  );
}

function CheckinForm({ c, onDone }: { c: any; onDone: () => void }) {
  const [v, setV] = useState<Record<string, number>>({});
  const [concerns, setConcerns] = useState('');
  const [comment, setComment] = useState('');
  const [run, busy] = useAction(() => post(`/host/checkins/${c.id}`, {
    attendance: v.attendance, performance: v.performance, wellbeing: v.wellbeing, concerns: concerns || undefined, comment: comment || undefined,
    criteria: Object.fromEntries(CRITERIA.map(([k]) => [k, v[k]])),
  }), { success: 'Check-in sent', onDone });
  const all = [...QUESTIONS, ...CRITERIA];
  const ok = all.every(([k]) => v[k]);
  return (
    <Card title={`Day ${c.day} check-in: ${c.apprentice}`} actions={<span className="text-sm text-slate-500">Due {date(c.dueDate)}</span>}>
      <form className="space-y-1" onSubmit={(e) => { e.preventDefault(); run(); }}>
        {all.map(([k, l]) => <div key={k} className="flex items-center justify-between text-sm">{l}<Stars value={v[k] ?? 0} onChange={(n) => setV((x) => ({ ...x, [k]: n }))} size="text-xl" /></div>)}
        <Textarea label="Comment for the apprentice" value={comment} onChange={(e) => setComment(e.target.value)} maxLength={1000} />
        <Textarea label="Concerns for BTBG only" value={concerns} onChange={(e) => setConcerns(e.target.value)} maxLength={1000} />
        <div className="pt-2"><SubmitButton busy={busy} disabled={!ok}>Send check-in</SubmitButton></div>
      </form>
    </Card>
  );
}
