'use client';
import { Badge, PageHeader } from '@/components/ui';
import { ListView } from '@/components/staff';
import { dateTime, label, relative } from '@/lib/format';

/** Helpdesk queue with response and resolution targets (FR-HLP). */
export default function Helpdesk() {
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Helpdesk" subtitle="Reply within the response target; resolve within the resolution target." />
      <ListView path="/helpdesk/tickets" rowHref={(t: any) => `/app/staff/helpdesk/${t.id}`} searchPlaceholder="Reference or subject"
        filters={[{ name: 'status', label: 'Status', options: ['open', 'in_progress', 'awaiting_user', 'resolved', 'closed'].map((s) => ({ value: s, label: label(s) })) }, { name: 'mine', label: 'Assigned to me', type: 'checkbox' }]}
        columns={[
          { key: 'ref', label: 'Ref', render: (t: any) => <b>{t.ref}</b> },
          { key: 'subject', label: 'Subject', render: (t: any) => <>{t.subject}<p className="text-xs text-slate-500">{label(t.category)} · {t.requester ?? 'Visitor'}</p></> },
          { key: 'priority', label: 'Priority', render: (t: any) => <Badge status={t.priority} /> },
          { key: 'status', label: 'Status', render: (t: any) => <Badge status={t.status} /> },
          { key: 'responseDue', label: 'Response due', render: (t: any) => <span className={t.responseBreached ? 'font-semibold text-red-700' : ''}>{dateTime(t.responseDue)}</span> },
          { key: 'resolutionDue', label: 'Resolve by', render: (t: any) => <span className={t.resolutionBreached ? 'font-semibold text-red-700' : ''}>{dateTime(t.resolutionDue)}</span> },
          { key: 'assignee', label: 'Assignee' }, { key: 'createdAt', label: 'Opened', render: (t: any) => relative(t.createdAt) },
        ]} />
    </div>
  );
}
