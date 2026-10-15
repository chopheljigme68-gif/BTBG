import { type Db, one, query } from '../../db/pool.js';
import { addDays, periodBounds, scheduledDaysInPeriod, todayBT } from '../../lib/dates.js';
import { ruleViolation } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { getCalendar, getSetting } from '../../lib/settings.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

type Line = { hpaId: string | null; placementId: string | null; type: 'wage' | 'service' | 'admin' | 'credit'; description: string; amount: number };

/**
 * Build host invoices from active HPAs with three separate parts: wage,
 * service and admin (FR-ACC-01, 03), applying replacement credits (FR-PLC-23).
 * Draft invoices are rebuilt; issued invoices are never changed.
 */
export async function generateInvoices(period: string, actorId: string | null, db: Db, opts: { orgId?: string } = {}) {
  const { start, end } = periodBounds(period);
  const cal = await getCalendar(db);
  const fullMonthDays = scheduledDaysInPeriod(period, cal);
  const placements = await query(
    `select pl.id, pl.org_id, pl.hpa_id, pl.wage, pl.start_date, pl.actual_end_date, pl.role_title, p.full_name,
            h.placement_fee, h.monthly_service_fee, h.admin_fee_pct, h.admin_fee_fixed, h.placement_fee_invoiced,
            a.days_worked, a.paid_leave_days, a.scheduled_days
       from placements pl join host_placement_agreements h on h.id = pl.hpa_id join person_profiles p on p.id = pl.person_id
       left join attendance a on a.placement_id = pl.id and a.period = $3
      where pl.status in ('active','ending','ended','converted') and pl.start_date <= $2 and coalesce(pl.actual_end_date, $2) >= $1
        and ($4::uuid is null or pl.org_id = $4)
      order by pl.org_id, p.full_name`,
    [start, end, period, opts.orgId ?? null], db);

  const byOrg = new Map<string, Line[]>();
  for (const pl of placements) {
    const lines = byOrg.get(pl.org_id) ?? [];
    const scheduled = pl.scheduled_days ?? scheduledDaysInPeriod(period, cal, pl.start_date, pl.actual_end_date ?? undefined);
    const paidDays = pl.days_worked !== null ? Number(pl.days_worked) + Number(pl.paid_leave_days) : scheduled;
    const wagePart = round2(fullMonthDays ? (Number(pl.wage) / fullMonthDays) * paidDays : 0);
    lines.push({ hpaId: pl.hpa_id, placementId: pl.id, type: 'wage', description: `${pl.full_name}, ${pl.role_title}: ${paidDays} day(s)`, amount: wagePart });
    if (Number(pl.monthly_service_fee) > 0) {
      lines.push({ hpaId: pl.hpa_id, placementId: pl.id, type: 'service', description: `Monthly management fee: ${pl.full_name}`, amount: Number(pl.monthly_service_fee) });
    }
    if (!pl.placement_fee_invoiced && Number(pl.placement_fee) > 0) {
      lines.push({ hpaId: pl.hpa_id, placementId: pl.id, type: 'service', description: `One-time placement fee: ${pl.full_name}`, amount: Number(pl.placement_fee) });
      // A free replacement is owed if an earlier placement at this host failed in its placement period.
      const failed = await one(
        `select pl.id, p.full_name from placements pl join person_profiles p on p.id = pl.person_id
          where pl.org_id = $1 and pl.replacement_applied and pl.id <> $2
            and not exists (select 1 from invoice_lines l join invoices i on i.id = l.invoice_id where l.line_type = 'credit' and l.placement_id = pl.id and i.period <> $3)
          order by pl.actual_end_date limit 1`, [pl.org_id, pl.id, period], db);
      if (failed && !lines.some((l) => l.type === 'credit' && l.placementId === failed.id)) {
        lines.push({ hpaId: pl.hpa_id, placementId: failed.id, type: 'credit', description: `Free replacement for ${failed.full_name}: placement fee waived`, amount: -Number(pl.placement_fee) });
      }
    }
    const admin = round2((wagePart * Number(pl.admin_fee_pct)) / 100 + Number(pl.admin_fee_fixed));
    if (admin > 0) lines.push({ hpaId: pl.hpa_id, placementId: pl.id, type: 'admin', description: `Admin fee: ${pl.full_name}`, amount: admin });
    byOrg.set(pl.org_id, lines);
  }

  const results: Array<{ orgId: string; invoiceId: string; number: string; total: number; skipped?: string }> = [];
  for (const [orgId, lines] of byOrg) {
    const existing = await one('select id, number, status from invoices where org_id = $1 and period = $2 for update', [orgId, period], db);
    if (existing && existing.status !== 'draft') {
      results.push({ orgId, invoiceId: existing.id, number: existing.number, total: 0, skipped: `already ${existing.status}` });
      continue;
    }
    const subtotal = round2(lines.filter((l) => l.type !== 'credit').reduce((a, l) => a + l.amount, 0));
    const credits = round2(-lines.filter((l) => l.type === 'credit').reduce((a, l) => a + l.amount, 0));
    const total = round2(Math.max(0, subtotal - credits));
    let invoiceId: string;
    let number: string;
    if (existing) {
      invoiceId = existing.id;
      number = existing.number;
      await db.query('delete from invoice_lines where invoice_id = $1', [invoiceId]);
      await db.query('update invoices set subtotal = $2, credits = $3, total = $4 where id = $1', [invoiceId, subtotal, credits, total]);
    } else {
      const row = await one<{ id: string; number: string }>(
        `insert into invoices (number, org_id, period, subtotal, credits, total, created_by)
         values ('INV-' || nextval('invoice_number_seq'), $1, $2, $3, $4, $5, $6) returning id, number`,
        [orgId, period, subtotal, credits, total, actorId], db);
      invoiceId = row!.id;
      number = row!.number;
    }
    for (const l of lines) {
      await db.query(`insert into invoice_lines (invoice_id, hpa_id, placement_id, line_type, description, amount) values ($1,$2,$3,$4,$5,$6)`,
        [invoiceId, l.hpaId, l.placementId, l.type, l.description, l.amount]);
    }
    results.push({ orgId, invoiceId, number, total });
  }
  return results;
}

export async function issueInvoice(invoiceId: string, db: Db) {
  const inv = await one('select * from invoices where id = $1 for update', [invoiceId], db);
  if (!inv) throw ruleViolation('Invoice not found.');
  if (inv.status !== 'draft') throw ruleViolation('Only a draft invoice can be issued.');
  const dueDays = await getSetting('billing.invoice_due_days', db);
  const issue = todayBT();
  const due = addDays(issue, dueDays);
  await db.query(`update invoices set status = case when total = 0 then 'paid' else 'issued' end, issue_date = $2, due_date = $3 where id = $1`, [invoiceId, issue, due]);
  // The one-time fee is charged once per HPA.
  await db.query(`update host_placement_agreements set placement_fee_invoiced = true where id in (
      select hpa_id from invoice_lines where invoice_id = $1 and description like 'One-time placement fee%')`, [invoiceId]);
  const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code = 'host_owner'`, [inv.org_id], db);
  for (const o of owners) {
    await notify({ userId: o.user_id, code: 'invoice_issued', vars: { number: inv.number, period: inv.period, total: Number(inv.total).toLocaleString('en-IN'), due }, link: '/app/host/invoices', channels: ['in_app', 'email'] }, db);
  }
  return { issueDate: issue, dueDate: due };
}

export async function refreshInvoiceStatus(invoiceId: string, db: Db) {
  await db.query(
    `update invoices i set amount_paid = coalesce((select sum(amount) from payment_allocations where invoice_id = i.id), 0) where id = $1`, [invoiceId]);
  await db.query(
    `update invoices set status = case
        when status = 'written_off' then status
        when amount_paid >= total then 'paid'
        when amount_paid > 0 and due_date < current_date then 'overdue'
        when amount_paid > 0 then 'part_paid'
        when due_date < current_date then 'overdue'
        else 'issued' end
      where id = $1 and status <> 'draft'`, [invoiceId]);
}

/** Record a payment and match it to invoices, oldest first unless told otherwise (FR-ACC-04). */
export async function recordPayment(
  input: { orgId: string; amount: number; method: 'bank_transfer' | 'cash' | 'cheque'; reference?: string; receivedOn: string; allocations?: Array<{ invoiceId: string; amount: number }> },
  actorId: string,
  db: Db,
) {
  const p = await one<{ id: string }>(
    `insert into payments (org_id, amount, method, reference, received_on, recorded_by) values ($1,$2,$3,$4,$5,$6) returning id`,
    [input.orgId, input.amount, input.method, input.reference ?? null, input.receivedOn, actorId], db);
  let remaining = input.amount;
  const plan: Array<{ invoiceId: string; amount: number }> = [];
  if (input.allocations?.length) {
    for (const a of input.allocations) {
      const inv = await one(`select id, total - amount_paid as balance from invoices where id = $1 and org_id = $2 and status in ('issued','part_paid','overdue')`, [a.invoiceId, input.orgId], db);
      if (!inv) throw ruleViolation('An allocation points to an invoice that is not open for this host.');
      if (a.amount > Number(inv.balance) + 0.001) throw ruleViolation('An allocation is larger than the invoice balance.');
      plan.push(a);
    }
    if (plan.reduce((s, a) => s + a.amount, 0) > input.amount + 0.001) throw ruleViolation('Allocations add up to more than the payment.');
  } else {
    const open = await query(`select id, total - amount_paid as balance from invoices where org_id = $1 and status in ('issued','part_paid','overdue') order by due_date, period`, [input.orgId], db);
    for (const inv of open) {
      if (remaining <= 0) break;
      const amt = round2(Math.min(remaining, Number(inv.balance)));
      if (amt > 0) plan.push({ invoiceId: inv.id, amount: amt });
      remaining = round2(remaining - amt);
    }
  }
  for (const a of plan) {
    await db.query('insert into payment_allocations (payment_id, invoice_id, amount) values ($1, $2, $3)', [p!.id, a.invoiceId, a.amount]);
    await refreshInvoiceStatus(a.invoiceId, db);
  }
  const allocated = round2(plan.reduce((s, a) => s + a.amount, 0));
  return { paymentId: p!.id, allocated, unallocated: round2(input.amount - allocated) };
}

/** Receivables ageing buckets (FR-ACC-05). */
export async function ageing(db: Db) {
  return query(
    `select o.id as "orgId", o.name as host,
            sum(case when i.due_date >= current_date then i.total - i.amount_paid else 0 end) as current,
            sum(case when current_date - i.due_date between 1 and 30 then i.total - i.amount_paid else 0 end) as "d30",
            sum(case when current_date - i.due_date between 31 and 60 then i.total - i.amount_paid else 0 end) as "d60",
            sum(case when current_date - i.due_date between 61 and 90 then i.total - i.amount_paid else 0 end) as "d90",
            sum(case when current_date - i.due_date > 90 then i.total - i.amount_paid else 0 end) as "d90plus",
            sum(i.total - i.amount_paid) as total
       from invoices i join organisations o on o.id = i.org_id
      where i.status in ('issued','part_paid','overdue')
      group by o.id order by total desc`, [], db);
}

/**
 * BTBG's cash exposure: wages already paid to apprentices that hosts have not
 * yet reimbursed (FR-ACC-08). Host payments cover the wage part first.
 */
export async function cashExposure(db: Db) {
  const rows = await query(
    `with wage as (
       select i.id, i.org_id, i.period, i.amount_paid, i.status,
              coalesce(sum(l.amount) filter (where l.line_type = 'wage'), 0) as wage_part
         from invoices i join invoice_lines l on l.invoice_id = i.id
        where i.status <> 'draft' group by i.id)
     select o.id as "orgId", o.name as host,
            sum(w.wage_part) as "wageInvoiced",
            sum(least(w.amount_paid, w.wage_part)) as "wageCollected",
            sum(w.wage_part - least(w.amount_paid, w.wage_part)) filter (where w.status <> 'written_off') as "exposure"
       from wage w join organisations o on o.id = w.org_id
       join payroll_runs r on r.period = w.period and r.status in ('paid','closed')
      group by o.id order by "exposure" desc nulls last`, [], db);
  const wagesPaid = await one(`select coalesce(sum(ps.net), 0) as total from payslips ps join payroll_runs r on r.id = ps.run_id where r.status in ('paid','closed')`, [], db);
  const uninvoiced = await one(
    `select coalesce(sum(ps.gross), 0) as total from payslips ps join payroll_runs r on r.id = ps.run_id
      where r.status in ('paid','closed') and ps.bench_days > 0 and ps.days_worked = 0`, [], db);
  return {
    wagesPaidToDate: Number(wagesPaid?.total ?? 0),
    benchPayNotRecoverable: Number(uninvoiced?.total ?? 0),
    outstandingWageRecovery: round2(rows.reduce((a, r) => a + Number(r.exposure ?? 0), 0)),
    byHost: rows,
  };
}
