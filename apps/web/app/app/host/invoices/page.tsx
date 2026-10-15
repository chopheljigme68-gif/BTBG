'use client';
import { Async, Badge, Card, ModalButton, PageHeader, Table } from '@/components/ui';
import { fileUrl, useApi } from '@/lib/api';
import { date, label, money } from '@/lib/format';

/** Invoices and payments (FR-EMP-42). */
export default function Invoices() {
  const r = useApi<any>('/host/invoices');
  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <PageHeader title="Invoices" subtitle="Monthly invoice: apprentice wages, BTBG service fee and administration fee." />
      <Async r={r}>
        {(d) => (
          <>
            <div className="card overflow-hidden">
              <Table rows={d.invoices} empty="No invoices yet." columns={[
                { key: 'number', label: 'Invoice', render: (i) => <InvoiceDetail id={i.id} number={i.number} /> },
                { key: 'period', label: 'Month' },
                { key: 'issueDate', label: 'Issued', render: (i) => date(i.issueDate) },
                { key: 'dueDate', label: 'Due', render: (i) => date(i.dueDate) },
                { key: 'total', label: 'Total', render: (i) => money(i.total) },
                { key: 'balance', label: 'Balance', render: (i) => <b>{money(i.balance)}</b> },
                { key: 'status', label: 'Status', render: (i) => <Badge status={i.status} /> },
                { key: 'pdf', label: '', render: (i) => <a className="link" href={fileUrl(`/files/invoices/${i.id}`)} target="_blank" rel="noreferrer">PDF</a> },
              ]} />
            </div>
            <Card title="Payments received">
              <Table rows={d.payments} empty="No payments recorded." columns={[
                { key: 'receivedOn', label: 'Date', render: (p) => date(p.receivedOn) }, { key: 'amount', label: 'Amount', render: (p) => money(p.amount) },
                { key: 'method', label: 'Method', render: (p) => label(p.method) }, { key: 'reference', label: 'Reference' },
              ]} />
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}

function InvoiceDetail({ id, number }: { id: string; number: string }) {
  return (
    <ModalButton label={number} className="link font-medium" title={`Invoice ${number}`}>
      {() => <Lines id={id} />}
    </ModalButton>
  );
}

function Lines({ id }: { id: string }) {
  const r = useApi<any>(`/host/invoices/${id}`);
  return (
    <Async r={r}>
      {(inv) => (
        <table className="table"><tbody>
          {inv.lines.map((l: any, i: number) => <tr key={i}><td>{l.description}</td><td className="text-right">{money(l.amount)}</td></tr>)}
          <tr className="font-semibold"><td>Total</td><td className="text-right">{money(inv.total)}</td></tr>
        </tbody></table>
      )}
    </Async>
  );
}
