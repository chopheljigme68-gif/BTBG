'use client';
import { useState } from 'react';
import { Async, Badge, Card, Checkbox, Input, ModalButton, PageHeader, Select, SubmitButton, Table, Tabs, useAction } from '@/components/ui';
import { ListView } from '@/components/staff';
import { post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label, money, todayBT } from '@/lib/format';

/** Invoicing, payments, receivables ageing and cash exposure (FR-BIL). */
export default function Billing() {
  const [tab, setTab] = useState('invoices');
  const { me } = useMe();
  const [key, setKey] = useState(0);
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Billing" actions={can(me, 'billing.manage') && <div className="flex gap-2"><GenerateButton onDone={() => setKey((k) => k + 1)} /><PaymentButton onDone={() => setKey((k) => k + 1)} /></div>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'invoices', label: 'Invoices' }, { id: 'payments', label: 'Payments' }, { id: 'ageing', label: 'Receivables ageing' }, { id: 'exposure', label: 'Cash exposure' }]} />
      {tab === 'invoices' && (
        <ListView key={key} path="/billing/invoices" rowHref={(i: any) => `/app/staff/billing/${i.id}`} searchPlaceholder="Invoice number or host"
          filters={[{ name: 'status', label: 'Status', options: ['draft', 'issued', 'part_paid', 'paid', 'overdue', 'written_off'].map((s) => ({ value: s, label: label(s) })) }]}
          columns={[
            { key: 'number', label: 'Invoice', render: (i: any) => <b>{i.number}</b> }, { key: 'host', label: 'Host' }, { key: 'period', label: 'Month' },
            { key: 'status', label: 'Status', render: (i: any) => <Badge status={i.status} /> },
            { key: 'total', label: 'Total', render: (i: any) => money(i.total) }, { key: 'balance', label: 'Balance', render: (i: any) => <b>{money(i.balance)}</b> },
            { key: 'dueDate', label: 'Due', render: (i: any) => <>{date(i.dueDate)}{i.daysOverdue > 0 && i.balance > 0 && <span className="ml-1 text-xs text-red-700">{i.daysOverdue}d late</span>}</> },
          ]} />
      )}
      {tab === 'payments' && <Payments key={key} />}
      {tab === 'ageing' && <Ageing />}
      {tab === 'exposure' && <Exposure />}
    </div>
  );
}

function Payments() {
  const r = useApi<any>('/billing/payments');
  return (
    <Card padded={false}>
      <Async r={r}>{(d) => <Table rows={Array.isArray(d) ? d : d.items} empty="No payments yet." columns={[
        { key: 'receivedOn', label: 'Received', render: (p: any) => date(p.receivedOn) }, { key: 'host', label: 'Host' }, { key: 'amount', label: 'Amount', render: (p: any) => money(p.amount) },
        { key: 'allocated', label: 'Allocated', render: (p: any) => money(p.allocated) }, { key: 'method', label: 'Method', render: (p: any) => label(p.method) }, { key: 'reference', label: 'Reference' }, { key: 'recordedBy', label: 'Recorded by' },
      ]} />}</Async>
    </Card>
  );
}

function Ageing() {
  const r = useApi<any[]>('/billing/ageing');
  return (
    <Card padded={false}>
      <Async r={r}>{(rows) => <Table rows={rows.map((x) => ({ ...x, id: x.orgId }))} empty="Nothing owed." columns={[
        { key: 'host', label: 'Host' }, { key: 'current', label: 'Not yet due', render: (x: any) => money(x.current) }, { key: 'd30', label: '1-30 days', render: (x: any) => money(x.d30) },
        { key: 'd60', label: '31-60', render: (x: any) => money(x.d60) }, { key: 'd90', label: '61-90', render: (x: any) => money(x.d90) },
        { key: 'd90plus', label: '90+', render: (x: any) => <span className={Number(x.d90plus) > 0 ? 'font-semibold text-red-700' : ''}>{money(x.d90plus)}</span> }, { key: 'total', label: 'Total', render: (x: any) => <b>{money(x.total)}</b> },
      ]} />}</Async>
    </Card>
  );
}

function Exposure() {
  const r = useApi<any>('/billing/exposure');
  return (
    <Async r={r}>{(x) => (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="card p-4"><p className="text-xs text-slate-500 uppercase">Wages paid to date</p><p className="text-2xl font-bold">{money(x.wagesPaidToDate)}</p></div>
          <div className="card p-4"><p className="text-xs text-slate-500 uppercase">Wages not yet recovered</p><p className="text-2xl font-bold text-red-700">{money(x.outstandingWageRecovery)}</p></div>
          <div className="card p-4"><p className="text-xs text-slate-500 uppercase">Bench pay (not billable)</p><p className="text-2xl font-bold">{money(x.benchPayNotRecoverable)}</p></div>
        </div>
        <Card padded={false}><Table rows={x.byHost.map((h: any) => ({ ...h, id: h.orgId }))} empty="No exposure." columns={[{ key: 'host', label: 'Host' }, { key: 'wageInvoiced', label: 'Wages invoiced', render: (h: any) => money(h.wageInvoiced) }, { key: 'wageCollected', label: 'Collected', render: (h: any) => money(h.wageCollected) }, { key: 'exposure', label: 'Exposure', render: (h: any) => <b>{money(h.exposure)}</b> }]} /></Card>
      </div>
    )}</Async>
  );
}

function GenerateButton({ onDone }: { onDone: () => void }) {
  const hosts = useApi<any>('/reports/filters');
  const [run, busy] = useAction((b: any) => post('/billing/invoices/generate', b), { success: (r: any) => `${Array.isArray(r) ? r.length : ''} invoice(s) generated`, onDone });
  return (
    <ModalButton label="Generate invoices" className="btn-outline" title="Generate monthly invoices">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await run({ period: f.get('period'), orgId: f.get('orgId') || undefined, issue: f.get('issue') === 'on' })) close(); }}>
          <Input name="period" type="month" label="Month" defaultValue={todayBT().slice(0, 7)} required />
          <Select name="orgId" label="Host" placeholder="All hosts with active agreements" options={hosts.data?.hosts.map((h: any) => ({ value: h.id, label: h.name })) ?? []} />
          <Checkbox name="issue" label="Issue immediately (sends to hosts)" />
          <SubmitButton busy={busy}>Generate</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function PaymentButton({ onDone }: { onDone: () => void }) {
  const hosts = useApi<any>('/reports/filters');
  const [orgId, setOrg] = useState('');
  const open = useApi<any>(orgId ? `/billing/invoices?orgId=${orgId}&pageSize=50` : null);
  const [alloc, setAlloc] = useState<Record<string, string>>({});
  const [run, busy] = useAction((b: any) => post('/billing/payments', b), { success: 'Payment recorded', onDone });
  const unpaid = (open.data?.items ?? []).filter((i: any) => ['issued', 'part_paid', 'overdue'].includes(i.status));
  return (
    <ModalButton label="Record payment" className="btn-gold" title="Record a payment" wide>
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => {
          e.preventDefault(); const f = new FormData(e.currentTarget);
          const allocations = Object.entries(alloc).filter(([, v]) => Number(v) > 0).map(([invoiceId, v]) => ({ invoiceId, amount: Number(v) }));
          if (await run({ orgId, amount: Number(f.get('amount')), method: f.get('method'), reference: f.get('reference') || undefined, receivedOn: f.get('receivedOn'), allocations: allocations.length ? allocations : undefined })) { setAlloc({}); close(); }
        }}>
          <Select label="Host" required placeholder="Choose" value={orgId} onChange={(e) => setOrg(e.target.value)} options={hosts.data?.hosts.map((h: any) => ({ value: h.id, label: h.name })) ?? []} />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input name="amount" type="number" step="0.01" label="Amount (Nu)" required />
            <Select name="method" label="Method" options={[{ value: 'bank_transfer', label: 'Bank transfer' }, { value: 'cash', label: 'Cash' }, { value: 'cheque', label: 'Cheque' }]} />
            <Input name="reference" label="Reference" />
            <Input name="receivedOn" type="date" label="Received on" defaultValue={todayBT()} required />
          </div>
          {unpaid.length > 0 && (
            <div><p className="label">Allocate to invoices (leave blank to apply oldest first)</p>
              {unpaid.map((i: any) => <div key={i.id} className="flex items-center justify-between gap-2 py-1 text-sm"><span>{i.number} · {i.period} · balance {money(i.balance)}</span><input className="input w-32 py-1" type="number" step="0.01" value={alloc[i.id] ?? ''} onChange={(e) => setAlloc((a) => ({ ...a, [i.id]: e.target.value }))} aria-label={`Allocate to ${i.number}`} /></div>)}
            </div>
          )}
          <SubmitButton busy={busy} disabled={!orgId}>Record</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
