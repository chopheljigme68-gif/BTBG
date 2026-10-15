'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Async, Card, PageHeader, Stat } from '@/components/ui';
import { qs, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label } from '@/lib/format';
import { ReportFilters } from './filters';
import { TaskList } from './tasks/task-list';

const MVP: Record<string, string> = {
  hostsAgreeingToInterview: 'Hosts agreeing to interview',
  hostsPayingNamedPrice: 'Hosts paying the named price',
  matchesStarted: 'Matches started',
  retainedAt90Days: 'Retained at 90 days',
};

/** Operations dashboard (FR-RPT-01): live counts, MVP measures and the risk panel. */
export default function StaffHome() {
  const { me } = useMe();
  const [f, setF] = useState<Record<string, string>>({});
  const showDash = can(me, 'dashboard.view', 'reports.view');
  const d = useApi<any>(showDash ? `/reports/dashboard${qs(f)}` : null);
  const risks = useApi<any>(showDash ? `/reports/risks${qs(f)}` : null);
  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <PageHeader title={`Kuzuzangpo, ${me?.user.fullName.split(' ')[0] ?? ''}`} subtitle={me?.roles.find((r) => r.role === me.activeRole)?.roleName} />
      {showDash && (
        <>
          <ReportFilters value={f} onChange={setF} />
          <Async r={d}>
            {(x) => (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
                  <Stat label="Job seekers" value={x.counts.registeredJobSeekers} href="/app/staff/candidates" />
                  <Stat label="In screening" value={x.counts.inScreening} />
                  <Stat label="In training" value={x.counts.inTraining} />
                  <Stat label="On placement" value={x.counts.onPlacement} tone="green" href="/app/staff/placements" />
                  <Stat label="On bench" value={x.counts.onBench} tone={x.counts.onBench ? 'gold' : 'navy'} href="/app/staff/placements/bench" />
                  <Stat label="Conversions" value={x.counts.conversions} tone="green" />
                  <Stat label="Exits" value={x.counts.exits} />
                  <Stat label="Open vacancies" value={x.counts.openVacancies} href="/app/staff/vacancies" />
                  <Stat label="Active hosts" value={x.counts.activeHosts} href="/app/staff/hosts" />
                </div>
                <Card title="MVP measures">
                  <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                    {Object.entries(x.mvp).map(([k, v]: [string, any]) => (
                      <div key={k}>
                        <p className="text-xs font-medium text-slate-500 uppercase">{MVP[k] ?? label(k)}</p>
                        <p className="text-2xl font-bold text-navy-950">{v.pct ?? '—'}{v.pct !== null && v.pct !== undefined ? '%' : ''}</p>
                        <p className="text-xs text-slate-500">{v.value} of {v.of}</p>
                        <div className="mt-1 h-1.5 rounded bg-navy-50"><div className="h-1.5 rounded bg-gold-500" style={{ width: `${Math.min(100, v.pct ?? 0)}%` }} /></div>
                      </div>
                    ))}
                  </div>
                </Card>
              </>
            )}
          </Async>
          <Async r={risks}>
            {(rk) => (
              <Card title="Risks needing attention">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                  <RiskList title="Overdue check-ins" rows={rk.overdueCheckins} render={(c) => <Link className="link" href={`/app/staff/placements/${c.placementId}`}>Day {c.day} ({c.party}) · {c.apprentice} at {c.host}, due {date(c.dueDate)}</Link>} />
                  <RiskList title="Bench nearing deadline" rows={rk.redeploymentNearExpiry} render={(b) => <Link className="link" href="/app/staff/placements/bench">{b.name ?? b.apprentice} · deadline {date(b.deadline)}</Link>} />
                  <RiskList title="Unpaid invoices" rows={rk.unpaidInvoices} render={(i) => <Link className="link" href={`/app/staff/billing/${i.id}`}>{i.number ?? 'Invoice'} · {i.host} · {i.daysOverdue ?? 0} days overdue</Link>} />
                  <RiskList title="Grievances past target" rows={rk.overdueGrievances} render={(g) => <Link className="link" href={`/app/staff/grievances/${g.id}`}>{g.ref} · {label(g.category)} · S{g.severity}</Link>} />
                  <RiskList title="Unverified contacts" rows={rk.unverifiedContacts} render={(p) => <Link className="link" href={`/app/staff/candidates/${p.id}`}>{p.fullName ?? p.name}</Link>} />
                </div>
              </Card>
            )}
          </Async>
        </>
      )}
      {can(me, 'tasks.view') && <Card title="My tasks" actions={<Link className="btn-ghost btn-sm" href="/app/staff/tasks">All tasks</Link>}><TaskList limit={8} /></Card>}
    </div>
  );
}

function RiskList({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => React.ReactNode }) {
  return (
    <div>
      <p className="mb-1 text-sm font-semibold text-navy-900">{title} <span className={`ml-1 rounded-full px-1.5 text-xs ${rows.length ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'}`}>{rows.length}</span></p>
      {rows.length === 0 ? <p className="text-xs text-slate-500">None</p> : <ul className="space-y-1 text-sm">{rows.slice(0, 6).map((r, i) => <li key={r.id ?? i}>{render(r)}</li>)}</ul>}
    </div>
  );
}
