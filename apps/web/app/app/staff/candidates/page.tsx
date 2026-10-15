'use client';
import Link from 'next/link';
import { Badge, PageHeader } from '@/components/ui';
import { ListView, opts } from '@/components/staff';
import { useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label, money, relative } from '@/lib/format';
import { SOURCES, STAGES } from './constants';


/** Candidate pipeline (FR-CND-01..03). */
export default function Candidates() {
  const { me } = useMe();
  const ref = useApi<any>('/public/reference');
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Candidates" subtitle="Everyone from registration to placement."
        actions={<div className="flex gap-2">
          {can(me, 'candidates.import') && <Link href="/app/staff/candidates/import" className="btn-outline">Import CSV</Link>}
          {can(me, 'candidates.manage') && <Link href="/app/staff/candidates/new" className="btn-gold">Register a job seeker</Link>}
        </div>} />
      <ListView path="/candidates/" rowHref={(c: any) => `/app/staff/candidates/${c.id}`} searchPlaceholder="Name, mobile or CID"
        filters={[
          { name: 'stage', label: 'Stage', options: opts(STAGES, label) },
          { name: 'source', label: 'Source', options: opts(SOURCES, label) },
          { name: 'dzongkhagId', label: 'Dzongkhag', options: ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? [] },
          { name: 'lifecycle', label: 'Type', options: [{ value: 'job_seeker', label: 'Job seeker' }, { value: 'apprentice', label: 'Apprentice' }, { value: 'alumni', label: 'Alumni' }] },
          { name: 'mine', label: 'Mine', type: 'checkbox' },
          { name: 'contactUnverified', label: 'Contact unverified', type: 'checkbox' },
        ]}
        columns={[
          { key: 'fullName', label: 'Name', render: (c: any) => <><b>{c.fullName}</b><p className="text-xs text-slate-500">{c.mobile}</p></> },
          { key: 'stage', label: 'Stage', render: (c: any) => <><Badge status={c.stage} />{c.contactUnverified && <Badge tone="red">Contact?</Badge>}</> },
          { key: 'dzongkhag', label: 'Dzongkhag' },
          { key: 'source', label: 'Source', render: (c: any) => label(c.source) },
          { key: 'screeningScore', label: 'Score' },
          { key: 'expectedWage', label: 'Expects', render: (c: any) => money(c.expectedWage) },
          { key: 'officer', label: 'Officer' },
          { key: 'lastContactAt', label: 'Last contact', render: (c: any) => relative(c.lastContactAt) },
          { key: 'createdAt', label: 'Registered', render: (c: any) => date(c.createdAt) },
        ]} />
    </div>
  );
}
