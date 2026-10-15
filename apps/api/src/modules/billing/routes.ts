import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zDate, zPage, zPeriod } from '../../lib/http.js';
import { ageing, cashExposure, generateInvoices, issueInvoice, recordPayment } from './service.js';

/** Host invoicing, payments and receivables (SRS 3.3.7). */
const m = createModule('/billing', 'Billing and accounting');
export default m;

const VIEW = { any: ['billing.view', 'billing.manage'] };
const MANAGE = { any: ['billing.manage'] };

m.route({ method: 'get', path: '/invoices', summary: 'Invoices', access: VIEW,
  query: zPage.extend({ status: z.enum(['draft', 'issued', 'part_paid', 'paid', 'overdue', 'written_off']).optional(), period: zPeriod.optional(), orgId: z.string().uuid().optional() }) },
async ({ query: q }) => {
  const rows = await query(
    `select i.id, i.number, i.period, i.status, i.issue_date as "issueDate", i.due_date as "dueDate", i.subtotal, i.credits, i.total,
            i.amount_paid as "amountPaid", i.total - i.amount_paid as balance, o.id as "orgId", o.name as host,
            greatest(0, current_date - i.due_date) as "daysOverdue", count(*) over() as total_count
       from invoices i join organisations o on o.id = i.org_id
      where ($1::text is null or i.status = $1) and ($2::text is null or i.period = $2) and ($3::uuid is null or i.org_id = $3)
        and ($4::text is null or i.number ilike '%' || $4 || '%' or o.name ilike '%' || $4 || '%')
      order by i.period desc, o.name ${pageClause(q)}`,
    [q.status ?? null, q.period ?? null, q.orgId ?? null, q.q ?? null]);
  return { items: rows.map(({ total_count, ...r }) => r), total: rows[0]?.total_count ?? 0 };
});

m.route({ method: 'get', path: '/invoices/:id', summary: 'Invoice with lines and allocations', access: VIEW }, async ({ params }) => {
  const inv = await one(`select i.*, o.name as host from invoices i join organisations o on o.id = i.org_id where i.id = $1`, [params.id]);
  if (!inv) throw notFound('Invoice');
  const [lines, allocations] = await Promise.all([
    query(`select l.line_type as "type", l.description, l.amount, l.placement_id as "placementId" from invoice_lines l where l.invoice_id = $1 order by l.line_type, l.description`, [params.id]),
    query(`select pa.amount, p.method, p.reference, p.received_on as "receivedOn" from payment_allocations pa join payments p on p.id = pa.payment_id where pa.invoice_id = $1`, [params.id]),
  ]);
  const parts = { wage: 0, service: 0, admin: 0, credit: 0 } as Record<string, number>;
  for (const l of lines) parts[l.type] += Number(l.amount);
  return { ...inv, lines, allocations, parts };
});

m.route({ method: 'post', path: '/invoices/generate', summary: 'Generate draft invoices for a month from active HPAs', access: MANAGE,
  body: z.object({ period: zPeriod, orgId: z.string().uuid().optional(), issue: z.boolean().default(false) }) },
async ({ body, auth, ip }) =>
  tx(async (db) => {
    const results = await generateInvoices(body.period, auth.userId, db, { orgId: body.orgId });
    if (body.issue) for (const r of results.filter((x) => !x.skipped)) await issueInvoice(r.invoiceId, db);
    await audit({ actorId: auth.userId, action: 'billing.invoices_generated', ip, details: { period: body.period, count: results.length } }, db);
    return results;
  }),
);

m.route({ method: 'post', path: '/invoices/:id/issue', summary: 'Issue an invoice to the host', access: MANAGE }, async ({ params, auth, ip }) =>
  tx(async (db) => {
    const r = await issueInvoice(params.id, db);
    await audit({ actorId: auth.userId, action: 'billing.invoice_issued', entityType: 'invoice', entityId: params.id, ip }, db);
    return r;
  }),
);

m.route({ method: 'post', path: '/invoices/:id/write-off', summary: 'Write off an unpaid balance', access: MANAGE, body: z.object({ reason: z.string().min(5) }) },
  async ({ params, body, auth, ip }) => {
    const r = await query(`update invoices set status = 'written_off' where id = $1 and status in ('issued','part_paid','overdue') returning id`, [params.id]);
    if (!r.length) throw ruleViolation('Only an open invoice can be written off.');
    await audit({ actorId: auth.userId, action: 'billing.invoice_written_off', entityType: 'invoice', entityId: params.id, ip, details: body });
    return { ok: true };
  });

m.route({ method: 'get', path: '/payments', summary: 'Payments received', access: VIEW, query: zPage }, async ({ query: q }) =>
  query(`select p.id, p.amount, p.method, p.reference, p.received_on as "receivedOn", o.name as host, u.full_name as "recordedBy",
                coalesce((select sum(amount) from payment_allocations where payment_id = p.id), 0) as allocated
           from payments p join organisations o on o.id = p.org_id left join users u on u.id = p.recorded_by order by p.received_on desc ${pageClause(q)}`),
);

m.route({ method: 'post', path: '/payments', summary: 'Record a payment by bank transfer, cash or cheque', access: MANAGE,
  body: z.object({ orgId: z.string().uuid(), amount: z.number().positive(), method: z.enum(['bank_transfer', 'cash', 'cheque']), reference: z.string().optional(),
    receivedOn: zDate, allocations: z.array(z.object({ invoiceId: z.string().uuid(), amount: z.number().positive() })).optional() }) },
async ({ body, auth, ip }) =>
  tx(async (db) => {
    const r = await recordPayment(body, auth.userId, db);
    await audit({ actorId: auth.userId, action: 'billing.payment_recorded', entityType: 'payment', entityId: r.paymentId, ip, details: { amount: body.amount, method: body.method } }, db);
    return r;
  }),
);

m.route({ method: 'get', path: '/ageing', summary: 'Receivables ageing: current, 30, 60, 90+ days', access: VIEW }, async () => ageing(pool));
m.route({ method: 'get', path: '/exposure', summary: 'Wages paid ahead of host payment', access: VIEW }, async () => cashExposure(pool));
