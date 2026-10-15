'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Alert, Async, Badge, Card, PageHeader, SubmitButton, useAction } from '@/components/ui';
import { put, qs, useApi } from '@/lib/api';
import { dateTime, todayBT } from '@/lib/format';

export default function AttendancePage() {
  return <Suspense><Attendance /></Suspense>;
}

/** Attendance by exception (FR-EMP-31): scheduled days count as worked; mark only absences and paid leave. */
function Attendance() {
  const sp = useSearchParams();
  const router = useRouter();
  const period = sp.get('period') ?? todayBT().slice(0, 7);
  const r = useApi<any>(`/host/attendance${qs({ period })}`);
  const [rows, setRows] = useState<any[]>([]);
  useEffect(() => { if (r.data) setRows(r.data.rows.map((x: any) => ({ ...x, absenceDates: [...x.absenceDates] }))); }, [r.data]);
  const [save, busy] = useAction(() => put('/host/attendance', { period, entries: rows.map((x) => ({ placementId: x.placementId, absenceDates: x.absenceDates, paidLeaveDays: Number(x.paidLeaveDays) || 0 })) }), { success: 'Attendance confirmed', onDone: () => r.mutate() });
  const [y, m] = period.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const shift = (n: number) => { const d = new Date(Date.UTC(y, m - 1 + n, 1)); router.push(`?period=${d.toISOString().slice(0, 7)}`); };
  const toggle = (i: number, d: string) => setRows((rs) => rs.map((x, k) => k !== i ? x : { ...x, absenceDates: x.absenceDates.includes(d) ? x.absenceDates.filter((z: string) => z !== d) : [...x.absenceDates, d].sort() }));
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Attendance" subtitle="Everyone is counted present on scheduled days. Tap a day to mark an absence."
        actions={<div className="flex items-center gap-2"><button className="btn-outline btn-sm" onClick={() => shift(-1)}>‹</button><span className="font-semibold">{new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' })}</span><button className="btn-outline btn-sm" onClick={() => shift(1)}>›</button></div>} />
      <Alert tone="info">Confirm by the 20th. If you do not, BTBG pays full scheduled days and may correct it next month.</Alert>
      <Async r={r}>
        {() => rows.length === 0 ? <p className="text-sm text-slate-500">No apprentices this month.</p> : (
          <form onSubmit={(e) => { e.preventDefault(); save(); }} className="space-y-4">
            {rows.map((x, i) => (
              <Card key={x.placementId} title={<>{x.name} <span className="text-sm font-normal text-slate-500">{x.roleTitle}</span></>}
                actions={x.confirmedAt ? <Badge tone="green">Confirmed {dateTime(x.confirmedAt)}</Badge> : x.defaulted ? <Badge tone="amber">Defaulted</Badge> : <Badge tone="gray">Not confirmed</Badge>}>
                <div className="flex flex-wrap gap-1">
                  {Array.from({ length: days }, (_, k) => {
                    const d = `${period}-${String(k + 1).padStart(2, '0')}`;
                    const absent = x.absenceDates.includes(d);
                    const out = d < x.startDate || (x.endDate && d > x.endDate);
                    return <button key={d} type="button" disabled={Boolean(out)} onClick={() => toggle(i, d)} aria-pressed={absent} aria-label={`${d} ${absent ? 'absent' : 'present'}`}
                      className={`h-8 w-8 rounded text-xs font-medium ${out ? 'bg-slate-50 text-slate-300' : absent ? 'bg-red-600 text-white' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100'}`}>{k + 1}</button>;
                  })}
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-4 text-sm">
                  <span>Scheduled: <b>{x.scheduledDays}</b></span>
                  <span>Absent: <b className="text-red-700">{x.absenceDates.length}</b></span>
                  <label className="flex items-center gap-2">Paid leave days <input type="number" min={0} className="input w-20 py-1" value={x.paidLeaveDays} onChange={(e) => setRows((rs) => rs.map((z, k) => k === i ? { ...z, paidLeaveDays: e.target.value } : z))} /></label>
                  <span>Worked: <b>{Math.max(0, x.scheduledDays - x.absenceDates.length - (Number(x.paidLeaveDays) || 0))}</b></span>
                </div>
              </Card>
            ))}
            <SubmitButton busy={busy} className="btn-gold">Confirm attendance for {period}</SubmitButton>
          </form>
        )}
      </Async>
    </div>
  );
}
