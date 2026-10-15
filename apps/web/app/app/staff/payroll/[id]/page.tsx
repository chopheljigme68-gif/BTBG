'use client';
import { use } from 'react';
import { Alert, Async, Badge, Card, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Table, Textarea, useAction } from '@/components/ui';
import { fileUrl, post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label, money } from '@/lib/format';

/** Payroll run review, maker/checker approval, bank file and payment (Workflow 5). */
export default function PayrollRun({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/payroll/runs/${id}`);
  const { me } = useMe();
  const refresh = () => r.mutate();
  const useStep = (path: string, msg: string) => useAction((b: any = {}) => post(`/payroll/runs/${id}/${path}`, b), { success: msg, onDone: refresh });
  const [submit, s1] = useStep('submit', 'Sent for approval');
  const [approve, s2] = useStep('approve', 'Approved and locked');
  const [pay, s3] = useStep('pay', 'Marked paid; payslips published and SMS sent');
  const [close, s4] = useStep('close', 'Run closed');
  const [ret, s5] = useStep('return', 'Returned to draft');
  const [resolve] = useAction((sid: string, note: string) => post(`/payroll/payslips/${sid}/resolve`, { note }), { success: 'Marked reviewed', onDone: refresh });
  const [reject] = useAction((sid: string, reason: string) => post(`/payroll/payslips/${sid}/bank-reject`, { reason }), { success: 'Bank rejection recorded; correction created', onDone: refresh });
  const busy = s1 || s2 || s3 || s4 || s5;
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <Async r={r}>
        {(run) => {
          const flagged = run.payslips.filter((p: any) => p.flagged).length;
          return (
            <>
              <PageHeader title={`Payroll ${run.period}`} back={{ href: '/app/staff/payroll', label: 'Payroll' }} subtitle={<Badge status={run.status} />}
                actions={<div className="flex flex-wrap gap-2">
                  {run.status === 'draft' && can(me, 'payroll.prepare') && <button className="btn-primary btn-sm" disabled={busy || flagged > 0} title={flagged ? 'Review flagged lines first' : undefined} onClick={() => submit()}>Submit for approval</button>}
                  {run.status === 'submitted' && can(me, 'payroll.approve') && <>
                    <button className="btn-gold btn-sm" disabled={busy} onClick={() => approve()}>Approve and lock</button>
                    <ModalButton label="Return" title="Return to draft">{(c) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await ret({ reason: new FormData(e.currentTarget).get('reason') })) c(); }}><Textarea name="reason" label="Reason" required /><SubmitButton busy={busy}>Return</SubmitButton></form>}</ModalButton>
                  </>}
                  {['approved', 'paid', 'closed'].includes(run.status) && <BankFile id={id} />}
                  {run.status === 'approved' && can(me, 'payroll.approve', 'payroll.prepare') && <button className="btn-gold btn-sm" disabled={busy} onClick={() => confirm('Confirm the bank has paid these salaries?') && pay()}>Mark paid</button>}
                  {run.status === 'paid' && <button className="btn-outline btn-sm" disabled={busy} onClick={() => close()}>Close run</button>}
                </div>} />
              {run.status === 'draft' && flagged > 0 && <Alert tone="warn">{flagged} payslip(s) are flagged. Review each one before submitting.</Alert>}
              {run.status === 'submitted' && run.prepared_by === me?.user.id && <Alert tone="info">You prepared this run, so someone else must approve it.</Alert>}
              <Card>
                <KeyValue items={[['Payslips', run.line_count], ['Gross', money(run.total_gross)], ['Net', money(run.total_net)], ['Pay date', date(run.pay_date)], ['Submitted', dateTime(run.submitted_at)], ['Approved', dateTime(run.approved_at)], ['Paid', dateTime(run.paid_at)], run.return_reason && ['Returned because', run.return_reason]]} />
              </Card>
              <Card padded={false}>
                <Table rows={run.payslips} columns={[
                  { key: 'name', label: 'Apprentice', render: (p: any) => <><b>{p.name}</b><p className="text-xs text-slate-500">{p.bankName ?? 'No bank'} {p.bankLast4 && `••${p.bankLast4}`}</p></> },
                  { key: 'days', label: 'Days', render: (p: any) => <span className="text-xs">{p.daysWorked}/{p.scheduledDays} worked{Number(p.paidLeaveDays) > 0 && `, ${p.paidLeaveDays} leave`}{Number(p.benchDays) > 0 && `, ${p.benchDays} bench`}</span> },
                  { key: 'monthlyWage', label: 'Wage', render: (p: any) => money(p.monthlyWage) },
                  { key: 'gross', label: 'Gross', render: (p: any) => money(p.gross) },
                  { key: 'deductions', label: 'Deductions', render: (p: any) => <span title={p.lines.filter((l: any) => l.kind !== 'earning').map((l: any) => `${l.label}: ${l.amount}`).join('\n')}>{money(p.deductions)}</span> },
                  { key: 'adjustments', label: 'Adjust.', render: (p: any) => money(p.adjustments) },
                  { key: 'net', label: 'Net', render: (p: any) => <b>{money(p.net)}</b> },
                  { key: 'flagged', label: 'Checks', render: (p: any) => p.flagged ? <span className="text-xs text-amber-800">⚠ {(p.flagReasons ?? []).join('; ')}</span> : p.bankStatus ? <Badge status={p.bankStatus} /> : '✓' },
                  { key: 'x', label: '', render: (p: any) => (
                    <div className="flex gap-1">
                      {p.flagged && run.status === 'draft' && <button className="btn-outline btn-sm" onClick={() => { const n = prompt('What did you check?'); if (n) resolve(p.id, n); }}>Reviewed</button>}
                      {['paid', 'closed'].includes(run.status) && p.bankStatus !== 'rejected' && <button className="btn-ghost btn-sm" onClick={() => { const n = prompt('Bank rejection reason'); if (n) reject(p.id, n); }}>Bank rejected</button>}
                      {['paid', 'closed'].includes(run.status) && <a className="btn-ghost btn-sm" target="_blank" rel="noreferrer" href={fileUrl(`/files/payslips/${p.id}`)}>PDF</a>}
                    </div>
                  ) },
                ]} />
              </Card>
            </>
          );
        }}
      </Async>
    </div>
  );
}

function BankFile({ id }: { id: string }) {
  return (
    <ModalButton label="Bank file" title="Download salary payment file">
      {() => (
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); window.open(fileUrl(`/payroll/runs/${id}/bank-file?format=${new FormData(e.currentTarget).get('format')}`)); }}>
          <Select name="format" label="Format" options={[{ value: 'generic_csv', label: 'Generic CSV' }, { value: 'bob_csv', label: 'Bank of Bhutan CSV' }, { value: 'bnb_txt', label: 'BNB text file' }]} />
          <SubmitButton>Download</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
