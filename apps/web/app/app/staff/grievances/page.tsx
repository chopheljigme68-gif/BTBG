'use client';
import { useState } from 'react';
import { Async, Badge, Card, Checkbox, Input, ModalButton, PageHeader, Select, Stars, SubmitButton, Table, Tabs, Textarea, formData, useAction } from '@/components/ui';
import { ListView } from '@/components/staff';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label } from '@/lib/format';

const CATEGORIES = ['pay', 'safety', 'harassment', 'working_hours', 'conduct', 'contract', 'other'];

/** Grievance cases and the combined feedback queue (Workflow 6, FR-FDB). */
export default function Grievances() {
  const { me } = useMe();
  const [tab, setTab] = useState('cases');
  const [key, setKey] = useState(0);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Grievances and feedback" actions={can(me, 'grievances.handle') && <PhoneButton onDone={() => setKey((k) => k + 1)} />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'cases', label: 'Cases' }, ...(can(me, 'feedback.view', 'grievances.view_all') ? [{ id: 'queue', label: 'Feedback queue' }] : []), ...(can(me, 'grievances.view_all', 'reports.view') ? [{ id: 'summary', label: 'Summary' }] : [])]} />
      {tab === 'cases' && (
        <ListView key={key} path="/grievances/" rowHref={(g: any) => `/app/staff/grievances/${g.id}`} searchPlaceholder="Reference or subject"
          filters={[
            { name: 'status', label: 'Status', options: ['new', 'assigned', 'under_review', 'resolution_proposed', 'escalated', 'referred', 'resolved', 'closed'].map((s) => ({ value: s, label: label(s) })) },
            { name: 'severity', label: 'Severity', options: [1, 2, 3].map((s) => ({ value: s, label: `S${s}` })) },
            { name: 'mine', label: 'Mine', type: 'checkbox' },
          ]}
          columns={[
            { key: 'ref', label: 'Ref', render: (g: any) => <b>{g.ref}</b> },
            { key: 'severity', label: 'Sev.', render: (g: any) => <Badge tone={g.severity === 1 ? 'red' : g.severity === 2 ? 'amber' : 'gray'}>S{g.severity}</Badge> },
            { key: 'category', label: 'Category', render: (g: any) => label(g.category) }, { key: 'subject', label: 'Subject' },
            { key: 'status', label: 'Status', render: (g: any) => <Badge status={g.status} /> },
            { key: 'firstContact', label: 'First contact', render: (g: any) => g.firstContactAt ? date(g.firstContactAt) : g.firstContactOverdue ? <Badge tone="red">Overdue</Badge> : `due ${dateTime(g.firstContactDue)}` },
            { key: 'targetDate', label: 'Target', render: (g: any) => date(g.targetDate) },
            { key: 'officer', label: 'Officer', render: (g: any) => g.officer ?? g.officerName ?? '—' },
            { key: 'createdAt', label: 'Opened', render: (g: any) => date(g.createdAt) },
          ]} />
      )}
      {tab === 'queue' && <Queue />}
      {tab === 'summary' && <Summary />}
    </div>
  );
}

function Queue() {
  const r = useApi<any[]>('/grievances/queue/all');
  return (
    <Card padded={false}>
      <Async r={r}>{(rows) => <Table rows={rows} empty="Nothing in the queue." columns={[
        { key: 'kind', label: 'Type', render: (x: any) => <Badge tone={x.kind === 'grievance' ? 'red' : x.kind === 'rating' ? 'gold' : 'blue'}>{label(x.kind)}</Badge> },
        { key: 'at', label: 'When', render: (x: any) => dateTime(x.at) }, { key: 'title', label: 'What', render: (x: any) => <><b>{x.title}</b><p className="text-xs text-slate-600">{x.detail}</p></> },
        { key: 'score', label: 'Score', render: (x: any) => x.kind === 'rating' ? <Stars value={Number(x.score)} size="text-sm" /> : x.score ? `S${x.score}` : '' },
        { key: 'status', label: 'Status', render: (x: any) => label(x.status) }, { key: 'host', label: 'Host' }, { key: 'source', label: 'From', render: (x: any) => label(x.source) },
      ]} />}</Async>
    </Card>
  );
}

function Summary() {
  const r = useApi<any>('/grievances/reports/summary');
  return (
    <Async r={r}>{(d) => (
      <div className="grid gap-4 md:grid-cols-2">
        {Object.entries(d).map(([k, rows]: [string, any]) => Array.isArray(rows) && (
          <Card key={k} title={label(k)} padded={false}>
            <Table rows={rows.map((x: any, i: number) => ({ ...x, id: i }))} empty="No data." columns={Object.keys(rows[0] ?? {}).map((c) => ({ key: c, label: label(c) }))} />
          </Card>
        ))}
      </div>
    )}</Async>
  );
}

function PhoneButton({ onDone }: { onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post('/grievances/phone', b), { success: (g: any) => `Case ${g.ref} logged`, onDone });
  return (
    <ModalButton label="Log a phone grievance" className="btn-gold" title="Grievance received by phone" wide>
      {(close) => (
        <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const b = formData(e.currentTarget); b.shareIdentity = Boolean(b.shareIdentity); if (await run(b)) close(); }}>
          <Input name="complainantName" label="Caller name" required /><Input name="complainantMobile" label="Caller mobile" required />
          <Select name="category" label="Category" options={CATEGORIES.map((c) => ({ value: c, label: label(c) }))} />
          <Input name="subject" label="Subject" required />
          <div className="sm:col-span-2"><Textarea name="description" label="What happened" required minLength={10} /></div>
          <Checkbox name="shareIdentity" value="true" label="Caller agrees to share their name with the host" />
          <div className="sm:col-span-2"><SubmitButton busy={busy}>Log case</SubmitButton></div>
        </form>
      )}
    </ModalButton>
  );
}
