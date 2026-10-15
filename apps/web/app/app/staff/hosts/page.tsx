'use client';
import { Badge, PageHeader } from '@/components/ui';
import { ListView } from '@/components/staff';
import { date, label } from '@/lib/format';

/** Host employers (FR-ENT-01). */
export default function Hosts() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Host employers" subtitle="Verify each host before its vacancies can go live." />
      <ListView path="/hosts/" rowHref={(h: any) => `/app/staff/hosts/${h.id}`} searchPlaceholder="Name or trade licence"
        filters={[
          { name: 'verification', label: 'Verification', options: ['pending', 'verified', 'rejected'].map((v) => ({ value: v, label: label(v) })) },
          { name: 'status', label: 'Status', options: ['active', 'suspended'].map((v) => ({ value: v, label: label(v) })) },
        ]}
        columns={[
          { key: 'name', label: 'Host', render: (h: any) => <><b>{h.name}</b><p className="text-xs text-slate-500">{h.tradeLicenceNo}</p></> },
          { key: 'verificationStatus', label: 'Verified', render: (h: any) => <Badge status={h.verificationStatus} /> },
          { key: 'status', label: 'Status', render: (h: any) => <Badge status={h.status} /> },
          { key: 'sectorCode', label: 'Sector', render: (h: any) => label(h.sectorCode) },
          { key: 'sizeTier', label: 'Size', render: (h: any) => label(h.sizeTier) },
          { key: 'dzongkhag', label: 'Dzongkhag' },
          { key: 'openVacancies', label: 'Open vacancies' }, { key: 'activeApprentices', label: 'Apprentices' },
          { key: 'createdAt', label: 'Joined', render: (h: any) => date(h.createdAt) },
        ]} />
    </div>
  );
}
