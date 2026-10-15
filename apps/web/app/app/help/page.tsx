'use client';
import Link from 'next/link';
import { Async, Badge, Empty, PageHeader, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { date, label } from '@/lib/format';

export default function MyTickets() {
  const r = useApi<any[]>('/helpdesk/tickets/mine');
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title="My help tickets" subtitle="Use the Help button at the bottom right to open a new one." />
      <Async r={r} empty={<Empty title="No tickets">If something is not working, tap Help.</Empty>}>
        {(rows) => (
          <div className="card">
            <Table rows={rows} rowHref={(t) => `/app/help/${t.id}`} columns={[
              { key: 'ref', label: 'Ref', render: (t) => <Link className="link" href={`/app/help/${t.id}`}>{t.ref}</Link> },
              { key: 'subject', label: 'Subject' }, { key: 'category', label: 'Topic', render: (t) => label(t.category) },
              { key: 'status', label: 'Status', render: (t) => <Badge status={t.status} /> }, { key: 'createdAt', label: 'Opened', render: (t) => date(t.createdAt) },
            ]} />
          </div>
        )}
      </Async>
    </div>
  );
}
