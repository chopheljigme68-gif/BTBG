'use client';
import { Badge, PageHeader } from '@/components/ui';
import { ListView } from '@/components/staff';
import { date, label, money } from '@/lib/format';

/** All vacancies with the review queue (Workflow 1). */
export default function Vacancies() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Vacancies" subtitle="Review submitted vacancies, then match and shortlist candidates." />
      <ListView path="/vacancies/" rowHref={(v: any) => `/app/staff/vacancies/${v.id}`} searchPlaceholder="Title or host" initial={{ status: '' }}
        filters={[{ name: 'status', label: 'Status', options: ['draft', 'submitted', 'open', 'paused', 'filled', 'closed'].map((s) => ({ value: s, label: label(s) })) }]}
        columns={[
          { key: 'title', label: 'Role', render: (v: any) => <><b>{v.title}</b>{v.isSeasonal && <Badge tone="gold">Seasonal</Badge>}{v.onBehalf && <Badge tone="blue">Field visit</Badge>}</> },
          { key: 'host', label: 'Host' }, { key: 'dzongkhag', label: 'Dzongkhag' },
          { key: 'status', label: 'Status', render: (v: any) => <Badge status={v.status} /> },
          { key: 'openings', label: 'Filled', render: (v: any) => `${v.filled}/${v.openings}` },
          { key: 'wage', label: 'Wage', render: (v: any) => money(v.wage) },
          { key: 'inProgress', label: 'Candidates' },
          { key: 'submittedAt', label: 'Submitted', render: (v: any) => date(v.submittedAt) },
          { key: 'daysOpen', label: 'Days open', render: (v: any) => v.openedAt ? v.daysOpen : '—' },
        ]} />
    </div>
  );
}
