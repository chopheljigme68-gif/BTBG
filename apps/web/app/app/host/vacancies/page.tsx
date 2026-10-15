'use client';
import Link from 'next/link';
import { Async, Badge, PageHeader, Table } from '@/components/ui';
import { useApi } from '@/lib/api';
import { date, money } from '@/lib/format';

export default function HostVacancies() {
  const r = useApi<any[]>('/host/vacancies');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Vacancies" subtitle="BTBG reviews each vacancy before it goes live, then shares a shortlist with you." actions={<Link href="/app/host/vacancies/new" className="btn-gold">Post a vacancy</Link>} />
      <Async r={r}>
        {(rows) => (
          <div className="card overflow-hidden">
            <Table rows={rows} rowHref={(v) => `/app/host/vacancies/${v.id}`} empty="No vacancies yet. Post your first one."
              columns={[
                { key: 'title', label: 'Role', render: (v) => <><b>{v.title}</b>{v.isSeasonal && <Badge tone="gold">Seasonal</Badge>}{v.reviewComment && v.status === 'draft' && <p className="text-xs text-red-700">Returned: {v.reviewComment}</p>}</> },
                { key: 'status', label: 'Status', render: (v) => <Badge status={v.status} /> },
                { key: 'openings', label: 'Filled', render: (v) => `${v.filled} / ${v.openings}` },
                { key: 'wage', label: 'Wage', render: (v) => money(v.wage) },
                { key: 'inProgress', label: 'Candidates' },
                { key: 'daysOpen', label: 'Open since', render: (v) => v.openedAt ? `${date(v.openedAt)} (${v.daysOpen} d)` : '—' },
              ]} />
          </div>
        )}
      </Async>
    </div>
  );
}
