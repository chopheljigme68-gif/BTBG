'use client';
import Link from 'next/link';
import { Badge, PageHeader } from '@/components/ui';
import { ListView } from '@/components/staff';
import { date, label, money } from '@/lib/format';

/** Placement case files (FR-PLC-10..20). */
export default function Placements() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Placements" actions={<div className="flex gap-2"><Link className="btn-outline" href="/app/staff/placements/requests">Requests</Link><Link className="btn-outline" href="/app/staff/placements/bench">Bench</Link></div>} />
      <ListView path="/placements/" rowHref={(p: any) => `/app/staff/placements/${p.id}`} searchPlaceholder="Apprentice or host"
        filters={[{ name: 'status', label: 'Status', options: ['contracted', 'active', 'ending', 'ended', 'converted'].map((s) => ({ value: s, label: label(s) })) }, { name: 'mine', label: 'Mine', type: 'checkbox' }]}
        columns={[
          { key: 'apprentice', label: 'Apprentice', render: (p: any) => <b>{p.apprentice}</b> },
          { key: 'host', label: 'Host' }, { key: 'roleTitle', label: 'Role' },
          { key: 'status', label: 'Status', render: (p: any) => <><Badge status={p.status} />{p.outcome && <Badge tone="gold">{label(p.outcome)}</Badge>}</> },
          { key: 'agreements', label: 'Signed', render: (p: any) => <span className="text-xs">Contract <Badge status={p.contractStatus} /> HPA <Badge status={p.hpaStatus} /></span> },
          { key: 'startDate', label: 'Dates', render: (p: any) => `${date(p.startDate)} to ${date(p.plannedEndDate)}` },
          { key: 'wage', label: 'Wage', render: (p: any) => money(p.wage) },
          { key: 'nextCheckin', label: 'Next check-in', render: (p: any) => date(p.nextCheckin) },
          { key: 'lastRisk', label: 'Risk', render: (p: any) => p.lastRisk ? <Badge status={p.lastRisk} /> : '—' },
          { key: 'officer', label: 'Officer' },
        ]} />
    </div>
  );
}
