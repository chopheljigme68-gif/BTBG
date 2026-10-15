'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Async, Badge, PageHeader, Tabs, useAction } from '@/components/ui';
import { post, qs, useApi } from '@/lib/api';
import { date, label } from '@/lib/format';

const LINK: Record<string, (id: string) => string> = {
  placement: (id) => `/app/staff/placements/${id}`, vacancy: (id) => `/app/staff/vacancies/${id}`, person: (id) => `/app/staff/candidates/${id}`,
  organisation: (id) => `/app/staff/hosts/${id}`, grievance: (id) => `/app/staff/grievances/${id}`, ticket: (id) => `/app/staff/helpdesk/${id}`,
  invoice: (id) => `/app/staff/billing/${id}`, payroll_run: (id) => `/app/staff/payroll/${id}`, application: () => '/app/staff/placements', video: (id) => `/app/staff/campaign/${id}`,
};

export function TaskList({ scope = 'mine', limit }: { scope?: string; limit?: number }) {
  const r = useApi<any[]>(`/admin/tasks${qs({ scope, status: 'open' })}`);
  const [done] = useAction((id: string) => post(`/admin/tasks/${id}/complete`), { success: 'Task done', onDone: () => r.mutate() });
  return (
    <Async r={r}>
      {(rows) => rows.length === 0 ? <p className="text-sm text-slate-500">Nothing to do. 🎉</p> : (
        <ul className="divide-y divide-navy-50">
          {rows.slice(0, limit).map((t) => (
            <li key={t.id} className="flex items-start justify-between gap-3 py-2.5">
              <div className="min-w-0">
                <p className="text-sm font-medium text-navy-950">{t.entityType && LINK[t.entityType] ? <Link className="hover:underline" href={LINK[t.entityType](t.entityId)}>{t.title}</Link> : t.title}</p>
                <p className="text-xs text-slate-500"><Badge status={t.priority} /> {label(t.kind)} · due {date(t.dueAt)} {t.overdue && <span className="font-semibold text-red-700">overdue</span>} · {t.assignee ?? label(t.assigneeRole)}</p>
                {t.description && <p className="text-xs text-slate-600">{t.description}</p>}
              </div>
              <button className="btn-outline btn-sm shrink-0" onClick={() => done(t.id)}>Done</button>
            </li>
          ))}
        </ul>
      )}
    </Async>
  );
}
