import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, zPeriod } from '../../lib/http.js';
import { getSetting } from '../../lib/settings.js';
import { createTask } from '../../lib/tasks.js';
import { bankFile, prepareRun, publishPayslips } from './service.js';

/** Apprentice payroll with maker and checker (SRS 3.3.6, Workflow 5). */
const m = createModule('/payroll', 'Apprentice payroll');
export default m;

const VIEW = { any: ['payroll.view', 'payroll.prepare', 'payroll.approve'] };

m.route({ method: 'get', path: '/runs', summary: 'Payroll runs', access: VIEW }, async () =>
  query(`select r.id, r.period, r.pay_date as "payDate", r.status, r.total_gross as "totalGross", r.total_net as "totalNet", r.line_count as "lineCount",
                r.flagged_count as "flaggedCount", p.full_name as "preparedBy", a.full_name as "approvedBy", r.approved_at as "approvedAt", r.paid_at as "paidAt"
           from payroll_runs r left join users p on p.id = r.prepared_by left join users a on a.id = r.approved_by order by r.period desc`),
);

m.route({ method: 'get', path: '/runs/:id', summary: 'Run with payslip lines', access: VIEW }, async ({ params }) => {
  const run = await one('select * from payroll_runs where id = $1', [params.id]);
  if (!run) throw notFound('Payroll run');
  const slips = await query(
    `select ps.id, p.id as "personId", p.full_name as name, ps.monthly_wage as "monthlyWage", ps.scheduled_days as "scheduledDays", ps.days_worked as "daysWorked",
            ps.bench_days as "benchDays", ps.paid_leave_days as "paidLeaveDays", ps.gross, ps.total_deductions as deductions, ps.total_adjustments as adjustments,
            ps.net, ps.flagged, ps.flag_reasons as "flagReasons", ps.bank_status as "bankStatus", ps.bank_reject_reason as "bankRejectReason",
            p.bank_name as "bankName", p.bank_account_last4 as "bankLast4",
            coalesce((select json_agg(json_build_object('kind', l.kind, 'label', l.label, 'amount', l.amount)) from payslip_lines l where l.payslip_id = ps.id), '[]') as lines
       from payslips ps join person_profiles p on p.id = ps.person_id where ps.run_id = $1 order by ps.flagged desc, p.full_name`, [params.id]);
  return { ...run, payslips: slips };
});

m.route({ method: 'post', path: '/runs', summary: 'Prepare (or rebuild) the draft run for a month', access: { any: ['payroll.prepare'] }, body: z.object({ period: zPeriod }) },
  async ({ body, auth, ip }) =>
    tx(async (db) => {
      const r = await prepareRun(body.period, auth.userId, db);
      await audit({ actorId: auth.userId, action: 'payroll.prepared', entityType: 'payroll_run', entityId: r.runId, ip, details: r }, db);
      return r;
    }),
);

m.route({ method: 'post', path: '/payslips/:id/resolve', summary: 'Mark a flagged line as reviewed', access: { any: ['payroll.prepare'] }, body: z.object({ note: z.string().min(3) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const s = await one(`select ps.id, ps.run_id, ps.flag_reasons, r.status from payslips ps join payroll_runs r on r.id = ps.run_id where ps.id = $1`, [params.id], db);
      if (!s) throw notFound('Payslip');
      if (s.status !== 'draft') throw ruleViolation('Only lines in a draft run can be reviewed.');
      if ((s.flag_reasons as string[]).some((f) => f.startsWith('BLOCKED'))) throw ruleViolation('This line is blocked by the wage floor. Amend the contract wage first.');
      await db.query(`update payslips set flagged = false, flag_reasons = array_append(flag_reasons, $2) where id = $1`, [params.id, `Reviewed: ${body.note}`]);
      await db.query(`update payroll_runs set flagged_count = (select count(*) from payslips where run_id = $1 and flagged) where id = $1`, [s.run_id]);
      await audit({ actorId: auth.userId, action: 'payroll.flag_resolved', entityType: 'payslip', entityId: params.id, ip, details: body }, db);
      return { ok: true };
    }),
);

m.route({ method: 'post', path: '/runs/:id/submit', summary: 'Payroll Officer submits the run for approval', access: { any: ['payroll.prepare'] } }, async ({ params, auth, ip }) =>
  tx(async (db) => {
    const run = await one('select * from payroll_runs where id = $1 for update', [params.id], db);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'draft') throw ruleViolation('Only a draft run can be submitted.');
    if (run.line_count === 0) throw ruleViolation('This run has no lines.');
    const floor = await getSetting('payroll.wage_floor', db);
    const below = await one<{ n: number }>('select count(*)::int as n from payslips where run_id = $1 and monthly_wage < $2', [params.id, floor], db);
    // FR-PAY-09: no wage below the configured floor is ever paid.
    if (below!.n > 0) throw ruleViolation(`${below!.n} line(s) are below the wage floor of Nu ${floor}. Amend those contracts and rebuild the run.`);
    if (run.flagged_count > 0) throw ruleViolation(`Review the ${run.flagged_count} flagged line(s) before submitting.`);
    await db.query(`update payroll_runs set status = 'submitted', submitted_at = now(), prepared_by = $2 where id = $1`, [params.id, auth.userId]);
    await createTask({ kind: 'approve_payroll', title: `Approve payroll ${run.period}`, entityType: 'payroll_run', entityId: params.id, assigneeRole: 'finance_officer', priority: 'high', dedupeKey: `approve_payroll:${params.id}` }, db);
    await audit({ actorId: auth.userId, action: 'payroll.submitted', entityType: 'payroll_run', entityId: params.id, ip }, db);
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/runs/:id/return', summary: 'Approver returns the run to draft', access: { any: ['payroll.approve'] }, body: z.object({ reason: z.string().min(3) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const res = await db.query(`update payroll_runs set status = 'draft', submitted_at = null where id = $1 and status = 'submitted'`, [params.id]);
      if (!res.rowCount) throw ruleViolation('Only a submitted run can be returned.');
      await audit({ actorId: auth.userId, action: 'payroll.returned', entityType: 'payroll_run', entityId: params.id, ip, details: body }, db);
      return { ok: true };
    }),
);

m.route({ method: 'post', path: '/runs/:id/approve', summary: 'A second person approves and locks the run (maker and checker)', access: { any: ['payroll.approve'] } }, async ({ params, auth, ip }) =>
  tx(async (db) => {
    const run = await one('select * from payroll_runs where id = $1 for update', [params.id], db);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'submitted') throw ruleViolation('Only a submitted run can be approved.');
    // FR-PAY-06: the approver must be a different person from the preparer.
    if (run.prepared_by === auth.userId) throw forbidden('You prepared this run. A different person must approve it.');
    await db.query(`update payroll_runs set status = 'approved', approved_by = $2, approved_at = now() where id = $1`, [params.id, auth.userId]);
    await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where dedupe_key = $1`, [`approve_payroll:${params.id}`, auth.userId]);
    await audit({ actorId: auth.userId, action: 'payroll.approved', entityType: 'payroll_run', entityId: params.id, ip, details: { total: run.total_net } }, db);
    return { ok: true };
  }),
);

m.route({ method: 'get', path: '/runs/:id/bank-file', summary: 'Download the salary payment file', access: { any: ['payroll.approve', 'payroll.prepare'] },
  query: z.object({ format: z.enum(['generic_csv', 'bob_csv', 'bnb_txt']).optional() }) },
async ({ params, query: q, res, auth, ip }) => {
  const run = await one('select status from payroll_runs where id = $1', [params.id]);
  if (!run) throw notFound('Payroll run');
  if (!['approved', 'paid', 'closed'].includes(run.status)) throw ruleViolation('The bank file is available after approval.');
  const file = await bankFile(params.id, q.format ?? (await getSetting('payroll.bank_file_format')), pool);
  await audit({ actorId: auth.userId, action: 'data.bank_file_exported', entityType: 'payroll_run', entityId: params.id, ip, details: { format: q.format } });
  res.setHeader('content-type', file.contentType);
  res.setHeader('content-disposition', `attachment; filename="${file.filename}"`);
  res.send(file.content);
});

m.route({ method: 'post', path: '/runs/:id/pay', summary: 'Mark paid and publish payslips with SMS', access: { any: ['payroll.approve'] } }, async ({ params, auth, ip }) =>
  tx(async (db) => {
    const run = await one('select * from payroll_runs where id = $1 for update', [params.id], db);
    if (!run) throw notFound('Payroll run');
    if (run.status !== 'approved') throw ruleViolation('Approve the run before marking it paid.');
    await db.query(`update payroll_runs set status = 'paid', paid_at = now() where id = $1`, [params.id]);
    const published = await publishPayslips(params.id, db);
    await audit({ actorId: auth.userId, action: 'payroll.paid', entityType: 'payroll_run', entityId: params.id, ip, details: { published } }, db);
    return { ok: true, published };
  }),
);

m.route({ method: 'post', path: '/runs/:id/close', summary: 'Close a paid run', access: { any: ['payroll.approve'] } }, async ({ params, auth }) => {
  const res = await query(`update payroll_runs set status = 'closed' where id = $1 and status = 'paid' returning id`, [params.id]);
  if (!res.length) throw ruleViolation('Only a paid run can be closed.');
  await audit({ actorId: auth.userId, action: 'payroll.closed', entityType: 'payroll_run', entityId: params.id });
  return { ok: true };
});

/** Workflow 5 exception: the bank rejects a payment. Flag it and re-pay in the next run. */
m.route({ method: 'post', path: '/payslips/:id/bank-reject', summary: 'Record a bank rejection', access: { any: ['payroll.approve', 'payroll.prepare'] },
  body: z.object({ reason: z.string().min(3) }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const s = await one(`select ps.*, p.full_name from payslips ps join person_profiles p on p.id = ps.person_id where ps.id = $1`, [params.id], db);
    if (!s) throw notFound('Payslip');
    if (s.bank_status === 'rejected') throw badRequest('Already recorded as rejected.');
    await db.query(`update payslips set bank_status = 'rejected', bank_reject_reason = $2 where id = $1`, [params.id, body.reason]);
    await db.query(`insert into payroll_adjustments (person_id, amount, reason, source_payslip_id, created_by) values ($1, $2, $3, $4, $5)`,
      [s.person_id, s.net, `Re-payment of rejected transfer (${body.reason})`, params.id, auth.userId]);
    await createTask({ kind: 'bank_reject', title: `Correct bank details for ${s.full_name} and re-pay`, description: body.reason, entityType: 'person', entityId: s.person_id,
      assigneeRole: 'finance_officer', priority: 'urgent', dedupeKey: `bank_reject:${params.id}` }, db);
    await audit({ actorId: auth.userId, action: 'payroll.bank_rejected', entityType: 'payslip', entityId: params.id, ip, details: body }, db);
    return { ok: true };
  }),
);

m.route({ method: 'get', path: '/adjustments', summary: 'Pending corrections for the next run', access: VIEW }, async () =>
  query(`select a.id, a.amount, a.reason, a.created_at as "createdAt", p.full_name as name, u.full_name as "createdBy"
           from payroll_adjustments a join person_profiles p on p.id = a.person_id left join users u on u.id = a.created_by where a.applied_run_id is null order by a.created_at`),
);
