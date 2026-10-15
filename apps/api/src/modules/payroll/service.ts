import type { PoolClient } from 'pg';
import { type Db, one, query } from '../../db/pool.js';
import { decrypt } from '../../lib/crypto.js';
import { addDays, addWorkingDays, displayDate, isWorkingDay, periodBounds, scheduledDaysInPeriod, workingDaysBetween, type Calendar } from '../../lib/dates.js';
import { ruleViolation } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';
import { getCalendar, getSetting } from '../../lib/settings.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The configured pay date, moved back to the previous working day if needed. */
export async function payDateFor(period: string, db: Db) {
  const day = await getSetting('payroll.pay_day', db);
  const cal = await getCalendar(db);
  let d = `${period}-${String(day).padStart(2, '0')}`;
  while (!isWorkingDay(d, cal)) d = addDays(d, -1);
  return d;
}

type Line = { kind: 'earning' | 'deduction' | 'adjustment'; label: string; amount: number };

/** Pure pay calculation for one contract and period (FR-PAY-03, 05, 09). Exported for tests. */
export function calculatePay(input: {
  wage: number;
  fullMonthDays: number;
  worked: number;
  paidLeave: number;
  benchDays: number;
  benchPct: number;
  deductions: Array<{ label: string; pct: number; enabled: boolean }>;
  adjustments: Array<{ reason: string; amount: number }>;
}) {
  const daily = input.fullMonthDays > 0 ? input.wage / input.fullMonthDays : 0;
  const lines: Line[] = [];
  const workPay = round2(daily * input.worked);
  const leavePay = round2(daily * input.paidLeave);
  const benchPay = round2(daily * input.benchDays * (input.benchPct / 100));
  if (input.worked) lines.push({ kind: 'earning', label: `Wage: ${input.worked} day(s) worked`, amount: workPay });
  if (input.paidLeave) lines.push({ kind: 'earning', label: `Paid leave: ${input.paidLeave} day(s)`, amount: leavePay });
  if (input.benchDays) lines.push({ kind: 'earning', label: `Bench pay: ${input.benchDays} day(s) at ${input.benchPct}%`, amount: benchPay });
  const gross = round2(Math.min(input.wage, workPay + leavePay + benchPay));
  let totalDeductions = 0;
  for (const d of input.deductions.filter((x) => x.enabled && x.pct > 0)) {
    const amt = round2((gross * d.pct) / 100);
    totalDeductions += amt;
    lines.push({ kind: 'deduction', label: `${d.label} (${d.pct}%)`, amount: -amt });
  }
  let totalAdjustments = 0;
  for (const a of input.adjustments) {
    totalAdjustments += a.amount;
    lines.push({ kind: 'adjustment', label: `Correction: ${a.reason}`, amount: round2(a.amount) });
  }
  return { gross, totalDeductions: round2(totalDeductions), totalAdjustments: round2(totalAdjustments), net: round2(gross - totalDeductions + totalAdjustments), lines };
}

/**
 * FR-PAY-04: three days before pay date, missing attendance defaults to
 * scheduled days, the host is told, and the line is flagged for review.
 */
export async function defaultMissingAttendance(period: string, db: Db, cal?: Calendar) {
  cal ??= await getCalendar(db);
  const { start, end } = periodBounds(period);
  const rows = await query(
    `select pl.id, pl.org_id, pl.start_date, pl.actual_end_date, p.full_name
       from placements pl join person_profiles p on p.id = pl.person_id
      where pl.start_date <= $2 and coalesce(pl.actual_end_date, $2) >= $1 and pl.status in ('active','ending','ended','converted')
        and not exists (select 1 from attendance a where a.placement_id = pl.id and a.period = $3)`,
    [start, end, period], db);
  const orgs = new Set<string>();
  for (const r of rows) {
    const scheduled = scheduledDaysInPeriod(period, cal, r.start_date, r.actual_end_date ?? undefined);
    await db.query(
      `insert into attendance (placement_id, period, scheduled_days, days_worked, defaulted) values ($1, $2, $3::int, $3::int, true) on conflict do nothing`,
      [r.id, period, scheduled]);
    orgs.add(r.org_id);
  }
  for (const orgId of orgs) {
    const users = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code in ('host_owner','host_supervisor')`, [orgId], db);
    for (const u of users) await notify({ userId: u.user_id, code: 'attendance_defaulted', vars: { period } }, db);
  }
  return rows.length;
}

/** Build or rebuild a draft payroll run (Workflow 5). Never depends on invoices (FR-PAY-02). */
export async function prepareRun(period: string, actorId: string, db: PoolClient) {
  const existing = await one('select * from payroll_runs where period = $1 for update', [period], db);
  if (existing && existing.status !== 'draft') throw ruleViolation(`The ${period} run is ${existing.status}. Make corrections as adjustments in the next run.`);
  const payDate = await payDateFor(period, db);
  const cal = await getCalendar(db);
  const [floor, benchPct, deductions] = await Promise.all([
    getSetting('payroll.wage_floor', db), getSetting('placement.bench_pay_pct', db), getSetting('payroll.deductions', db),
  ]);
  let runId: string;
  if (existing) {
    runId = existing.id;
    await db.query('update payroll_adjustments set applied_run_id = null where applied_run_id = $1', [runId]);
    await db.query('delete from payslips where run_id = $1', [runId]);
    await db.query('update payroll_runs set prepared_by = $2, pay_date = $3 where id = $1', [runId, actorId, payDate]);
  } else {
    const r = await one<{ id: string }>(`insert into payroll_runs (period, pay_date, prepared_by) values ($1, $2, $3) returning id`, [period, payDate, actorId], db);
    runId = r!.id;
  }

  await defaultMissingAttendance(period, db, cal);
  const { start, end } = periodBounds(period);
  const fullMonthDays = scheduledDaysInPeriod(period, cal);
  const contracts = await query(
    `select c.id, c.person_id, c.wage, c.start_date, c.ended_at, p.full_name, p.bank_account_enc is not null as has_bank
       from employment_contracts c join person_profiles p on p.id = c.person_id
      where c.status in ('active','bench','ended') and c.start_date <= $2 and (c.ended_at is null or c.ended_at::date >= $1)`,
    [start, end], db);

  let totalGross = 0;
  let totalNet = 0;
  let flaggedCount = 0;
  for (const c of contracts) {
    const att = await query(
      `select a.days_worked, a.paid_leave_days, a.defaulted, a.scheduled_days from attendance a join placements pl on pl.id = a.placement_id
        where pl.contract_id = $1 and a.period = $2`, [c.id, period], db);
    const benches = await query(`select start_date, coalesce(ended_at::date, $3::date) as end_date from bench_periods where contract_id = $1 and start_date <= $3 and (ended_at is null or ended_at::date >= $2)`,
      [c.id, start, end], db);
    let benchDays = 0;
    for (const b of benches) {
      const lo = b.start_date > start ? b.start_date : start;
      const hi = b.end_date < end ? b.end_date : end;
      benchDays += workingDaysBetween(addDays(lo, -1), hi, cal);
    }
    const worked = att.reduce((a, r) => a + Number(r.days_worked), 0);
    const paidLeave = att.reduce((a, r) => a + Number(r.paid_leave_days), 0);
    const scheduled = att.reduce((a, r) => a + Number(r.scheduled_days), 0) + benchDays;
    const adjustments = await query(`select id, reason, amount from payroll_adjustments where person_id = $1 and applied_run_id is null`, [c.person_id], db);
    if (worked + paidLeave + benchDays === 0 && adjustments.length === 0) continue;

    const pay = calculatePay({ wage: Number(c.wage), fullMonthDays, worked, paidLeave, benchDays, benchPct, deductions, adjustments: adjustments.map((a) => ({ reason: a.reason, amount: Number(a.amount) })) });
    const flags: string[] = [];
    if (Number(c.wage) < floor) flags.push(`BLOCKED: contract wage Nu ${c.wage} is below the wage floor of Nu ${floor}`);
    if (att.some((a) => a.defaulted)) flags.push('Attendance not confirmed by host; scheduled days used');
    if (!c.has_bank) flags.push('No bank account on file');
    if (pay.net < 0) flags.push('Net pay is negative');

    const slip = await one<{ id: string }>(
      `insert into payslips (run_id, person_id, contract_id, monthly_wage, scheduled_days, days_worked, bench_days, paid_leave_days, gross,
              total_deductions, total_adjustments, net, flagged, flag_reasons)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) returning id`,
      [runId, c.person_id, c.id, c.wage, scheduled, worked, benchDays, paidLeave, pay.gross, pay.totalDeductions, pay.totalAdjustments, pay.net, flags.length > 0, flags], db);
    for (const l of pay.lines) await db.query('insert into payslip_lines (payslip_id, kind, label, amount) values ($1,$2,$3,$4)', [slip!.id, l.kind, l.label, l.amount]);
    if (adjustments.length) await db.query('update payroll_adjustments set applied_run_id = $2 where id = any($1)', [adjustments.map((a) => a.id), runId]);
    totalGross += pay.gross;
    totalNet += pay.net;
    if (flags.length) flaggedCount++;
  }
  const count = await one<{ n: number }>('select count(*)::int as n from payslips where run_id = $1', [runId], db);
  await db.query(`update payroll_runs set total_gross = $2, total_net = $3, line_count = $4, flagged_count = $5 where id = $1`,
    [runId, round2(totalGross), round2(totalNet), count!.n, flaggedCount]);
  return { runId, payDate, lines: count!.n, flagged: flaggedCount, totalGross: round2(totalGross), totalNet: round2(totalNet) };
}

/** Salary payment file in the paying bank's format (FR-PAY-07). */
export async function bankFile(runId: string, format: 'generic_csv' | 'bob_csv' | 'bnb_txt', db: Db) {
  const run = await one('select period, pay_date from payroll_runs where id = $1', [runId], db);
  const rows = await query(
    `select p.full_name, p.bank_name, p.bank_account_enc, p.bank_account_holder, ps.net, ps.id
       from payslips ps join person_profiles p on p.id = ps.person_id where ps.run_id = $1 and ps.net > 0 order by p.full_name`, [runId], db);
  const ref = `BTBG SAL ${run.period}`;
  const items = rows.map((r) => ({ name: (r.bank_account_holder ?? r.full_name).replace(/[",\n]/g, ' '), bank: r.bank_name ?? '', account: decrypt(r.bank_account_enc) ?? '', amount: Number(r.net).toFixed(2) }));
  const missing = items.filter((i) => !i.account);
  if (missing.length) throw ruleViolation(`Bank details are missing for: ${missing.map((m) => m.name).join(', ')}.`);
  const total = items.reduce((a, i) => a + Number(i.amount), 0).toFixed(2);
  if (format === 'bnb_txt') {
    const header = `H${'BTBG'.padEnd(20)}${run.pay_date.replace(/-/g, '')}${String(items.length).padStart(6, '0')}${total.padStart(15, '0')}`;
    const body = items.map((i) => `D${i.account.padEnd(20)}${i.name.slice(0, 35).padEnd(35)}${i.amount.padStart(15, '0')}${ref.padEnd(20)}`);
    return { filename: `btbg-salary-${run.period}.txt`, contentType: 'text/plain', content: [header, ...body].join('\r\n') + '\r\n' };
  }
  const head = format === 'bob_csv' ? 'BeneficiaryAccount,BeneficiaryName,Amount,Narration,ValueDate' : 'account_number,account_name,bank,amount,reference';
  const body = items.map((i) => (format === 'bob_csv'
    ? `${i.account},"${i.name}",${i.amount},${ref},${displayDate(run.pay_date)}`
    : `${i.account},"${i.name}",${i.bank},${i.amount},${ref}`));
  return { filename: `btbg-salary-${run.period}.csv`, contentType: 'text/csv', content: [head, ...body].join('\n') + '\n' };
}

/** Publish payslips in the app and by SMS on the pay date (FR-PAY-08). */
export async function publishPayslips(runId: string, db: Db) {
  const run = await one('select period, pay_date from payroll_runs where id = $1', [runId], db);
  const slips = await query(
    `update payslips ps set published_at = now(), bank_status = case when bank_status = 'pending' then 'paid' else bank_status end
      from person_profiles p where ps.person_id = p.id and ps.run_id = $1 and ps.published_at is null
      returning ps.net, p.user_id, p.mobile`, [runId], db);
  for (const s of slips) {
    await notify({ userId: s.user_id, mobile: s.mobile, code: 'payslip', vars: { period: run.period, net: Number(s.net).toLocaleString('en-IN'), date: displayDate(run.pay_date) }, link: '/app/seeker/payslips' }, db);
  }
  return slips.length;
}

/** Workflow 5 trigger: preparation starts this many working days before pay date. */
export async function preparationDate(period: string, db: Db) {
  const [payDate, days, cal] = await Promise.all([payDateFor(period, db), getSetting('payroll.prep_working_days', db), getCalendar(db)]);
  return addWorkingDays(payDate, -days, cal);
}
