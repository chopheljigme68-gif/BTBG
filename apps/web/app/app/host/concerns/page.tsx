'use client';
import { Async, Badge, PageHeader, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { date, label } from '@/lib/format';

/** Concerns raised about this workplace; the complainant stays confidential unless they agree (FR-EE-41). */
export default function Concerns() {
  const r = useApi<any[]>('/grievances/host');
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Concerns about our workplace" subtitle="BTBG handles each case and may contact you. Retaliation against anyone who raises a concern is not allowed." />
      <Async r={r}>
        {(rows) => (
          <div className="card overflow-hidden">
            <Table rows={rows} empty="No concerns raised." columns={[
              { key: 'ref', label: 'Ref' }, { key: 'category', label: 'Category', render: (g) => label(g.category) },
              { key: 'severity', label: 'Severity', render: (g) => <Badge tone={g.severity === 1 ? 'red' : g.severity === 2 ? 'amber' : 'gray'}>S{g.severity}</Badge> },
              { key: 'status', label: 'Status', render: (g) => <Badge status={g.status} /> }, { key: 'complainant', label: 'Raised by' },
              { key: 'createdAt', label: 'Opened', render: (g) => date(g.createdAt) }, { key: 'targetDate', label: 'Target', render: (g) => date(g.targetDate) },
            ]} />
          </div>
        )}
      </Async>
    </div>
  );
}
