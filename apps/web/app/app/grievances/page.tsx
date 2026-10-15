'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Alert, Async, Badge, Card, Checkbox, Empty, Input, PageHeader, Select, SubmitButton, Table, Textarea, formData, useAction } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label } from '@/lib/format';

const CATEGORY_HELP: Record<string, string> = {
  pay: 'Pay or deductions', safety: 'Safety at work (urgent)', harassment: 'Harassment or abuse (urgent)', working_hours: 'Working hours or rest days',
  conduct: 'How someone treated me', contract: 'My contract terms', other: 'Something else',
};

export default function Grievances() {
  const router = useRouter();
  const { me } = useMe();
  const meta = useApi<any>('/grievances/meta');
  const mine = useApi<any[]>('/grievances/mine');
  const aboutUs = useApi<any[]>(me && can(me, 'host.admin') ? '/grievances/host' : null);
  const [lodge, busy] = useAction((b: any) => post('/grievances', b), { onDone: (r: any) => router.push(`/app/grievances/${r.id}?new=1`) });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="Raise a concern" subtitle="Confidential. Nobody may take action against you for raising a concern." />
      <Card title="New concern">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); lodge(formData(e.currentTarget)); }}>
          <Select name="category" label="What is it about?" required placeholder="Choose" options={(meta.data?.categories ?? []).map((c: string) => ({ value: c, label: CATEGORY_HELP[c] ?? label(c) }))} />
          {meta.data?.placements?.length > 0 && (
            <Select name="placementId" label="Which placement?" placeholder="Not about a placement" options={meta.data.placements.map((p: any) => ({ value: p.id, label: `${p.roleTitle} · ${p.host ?? p.apprentice}` }))} />
          )}
          <Input name="subject" label="Short title" required minLength={3} maxLength={140} />
          <Textarea name="description" label="What happened?" required minLength={10} hint="Dates, places and who was involved help us act quickly." />
          <Checkbox name="shareIdentity" label="BTBG may tell the employer my name" hint="Leave unticked to stay anonymous to the employer." />
          <Alert tone="info">Safety and harassment concerns are urgent: a Grievance Officer contacts you within 24 hours and can move you to another host straight away.</Alert>
          <SubmitButton busy={busy}>Submit concern</SubmitButton>
        </form>
      </Card>
      <Card title="My concerns" padded={false}>
        <Async r={mine} empty={<div className="p-5"><Empty title="You have not raised any concerns" /></div>}>
          {(rows) => (
            <Table rows={rows} rowHref={(g) => `/app/grievances/${g.id}`} columns={[
              { key: 'ref', label: 'Ref', render: (g) => <Link className="link" href={`/app/grievances/${g.id}`}>{g.ref}</Link> },
              { key: 'subject', label: 'Subject' }, { key: 'status', label: 'Status', render: (g) => <Badge status={g.status} /> },
              { key: 'targetDate', label: 'Target date', render: (g) => date(g.targetDate) },
            ]} />
          )}
        </Async>
      </Card>
      {aboutUs.data && (
        <Card title="Concerns about our workplace" padded={false}>
          <Table rows={aboutUs.data} empty="No concerns relate to your workplace." columns={[
            { key: 'ref', label: 'Ref' }, { key: 'category', label: 'Category', render: (g) => label(g.category) },
            { key: 'complainant', label: 'Raised by' }, { key: 'status', label: 'Status', render: (g) => <Badge status={g.status} /> },
            { key: 'createdAt', label: 'Opened', render: (g) => date(g.createdAt) },
          ]} />
        </Card>
      )}
    </div>
  );
}
