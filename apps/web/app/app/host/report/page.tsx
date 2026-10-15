'use client';
import { useState } from 'react';
import { Async, Badge, Card, Input, ModalButton, PageHeader, Stars, SubmitButton, Table, Textarea, useAction } from '@/components/ui';
import { post, qs, useApi } from '@/lib/api';
import { money } from '@/lib/format';

/** Host report: vacancy ageing, performance, attendance and cost (FR-EMP-35). */
export default function HostReport() {
  const [range, setRange] = useState<{ from?: string; to?: string }>({});
  const r = useApi<any>(`/host/report${qs(range)}`);
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Reports" actions={<RateBtbg />} />
      <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); setRange({ from: (f.get('from') as string) || undefined, to: (f.get('to') as string) || undefined }); }}>
        <Input name="from" type="date" label="From" /><Input name="to" type="date" label="To" /><button className="btn-outline">Apply</button>
      </form>
      <Async r={r}>
        {(d) => (
          <>
            <p className="text-sm text-slate-500">{d.from} to {d.to}</p>
            <Card title="Vacancy ageing" padded={false}>
              <Table rows={d.vacancies} empty="No live vacancies." columns={[{ key: 'title', label: 'Role' }, { key: 'status', label: 'Status', render: (v) => <Badge status={v.status} /> }, { key: 'filled', label: 'Filled', render: (v) => `${v.filled}/${v.openings}` }, { key: 'daysOpen', label: 'Days open' }]} />
            </Card>
            <Card title="Performance (average of notes, out of 5)" padded={false}>
              <Table rows={d.performance} empty="No notes yet." columns={[{ key: 'apprentice', label: 'Apprentice' }, { key: 'punctuality', label: 'Punctuality' }, { key: 'skills', label: 'Skills' }, { key: 'attitude', label: 'Attitude' }, { key: 'teamwork', label: 'Teamwork' }, { key: 'customerCare', label: 'Customer care' }, { key: 'notes', label: 'Notes' }]} />
            </Card>
            <div className="grid gap-6 md:grid-cols-2">
              <Card title="Attendance" padded={false}>
                <Table rows={d.attendance} empty="No attendance yet." columns={[{ key: 'period', label: 'Month' }, { key: 'scheduled', label: 'Scheduled' }, { key: 'worked', label: 'Worked' }, { key: 'absences', label: 'Absences' }]} />
              </Card>
              <Card title="Cost" padded={false}>
                <Table rows={d.cost} empty="No invoices yet." columns={[{ key: 'period', label: 'Month' }, { key: 'wage', label: 'Wages', render: (c) => money(c.wage) }, { key: 'service', label: 'Service', render: (c) => money(c.service) }, { key: 'admin', label: 'Admin', render: (c) => money(c.admin) }, { key: 'total', label: 'Total', render: (c) => <b>{money(c.total)}</b> }]} />
              </Card>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}

function RateBtbg() {
  const [v, setV] = useState({ stars: 0, candidateQuality: 0, responsiveness: 0, billingClarity: 0 });
  const [run, busy] = useAction((comment: string) => post('/host/rate-btbg', { stars: v.stars, context: 'quarterly', comment: comment || undefined, criteria: { candidateQuality: v.candidateQuality || undefined, responsiveness: v.responsiveness || undefined, billingClarity: v.billingClarity || undefined } }), { success: 'Thank you for your feedback' });
  const rows = [['stars', 'Overall'], ['candidateQuality', 'Candidate quality'], ['responsiveness', 'Responsiveness'], ['billingClarity', 'Billing clarity']] as const;
  return (
    <ModalRate>
      {(close) => (
        <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('comment') as string)) close(); }}>
          {rows.map(([k, l]) => <div key={k} className="flex items-center justify-between text-sm">{l}<Stars value={v[k]} onChange={(n) => setV((x) => ({ ...x, [k]: n }))} size="text-xl" /></div>)}
          <Textarea name="comment" label="Comment" maxLength={1000} />
          <SubmitButton busy={busy} disabled={!v.stars}>Send</SubmitButton>
        </form>
      )}
    </ModalRate>
  );
}


function ModalRate({ children }: { children: (close: () => void) => React.ReactNode }) {
  return <ModalButton label="Rate BTBG service" title="How is BTBG doing?">{children}</ModalButton>;
}
