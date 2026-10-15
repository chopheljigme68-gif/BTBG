import { env } from '../../config/env.js';
import { type Db, one, query } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { sha256 } from '../../lib/crypto.js';
import { addDays, addMonths, addWorkingDays, daysBetween, displayDate, todayBT } from '../../lib/dates.js';
import { badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { notify, notifyRole } from '../../lib/notify.js';
import { agreementPdf } from '../../lib/pdf.js';
import { getCalendar, getSetting } from '../../lib/settings.js';
import { putFile } from '../../lib/storage.js';
import { createTask } from '../../lib/tasks.js';
import { issueCertificate } from '../certificates/service.js';
import { setStage } from '../people/service.js';

export const PLACEMENT_STATUSES = ['proposed', 'interview', 'offered', 'contracted', 'active', 'ending', 'ended', 'converted'] as const;

export interface ContractTerms {
  wage: number;
  hoursPerWeek: number;
  daysPerWeek: number;
  restDaysPerWeek: number;
  leaveDaysPerYear: number;
}

/** FR-PLC-15 and Labour and Employment Act 2007 checks. */
export async function validateTerms(t: ContractTerms, db: Db) {
  const [floor, maxHours, maxDays, minRest, minLeave] = await Promise.all([
    getSetting('payroll.wage_floor', db), getSetting('labour.max_hours_per_week', db), getSetting('labour.max_days_per_week', db),
    getSetting('labour.min_rest_days', db), getSetting('labour.min_leave_days', db),
  ]);
  if (t.wage < floor) throw ruleViolation(`The wage Nu ${t.wage} is below the wage floor of Nu ${floor}.`);
  if (t.hoursPerWeek > maxHours) throw ruleViolation(`Contracted hours (${t.hoursPerWeek}) exceed the legal limit of ${maxHours} per week.`);
  if (t.daysPerWeek > maxDays) throw ruleViolation(`Working days (${t.daysPerWeek}) exceed the limit of ${maxDays} per week.`);
  if (t.restDaysPerWeek < minRest) throw ruleViolation(`At least ${minRest} rest day(s) per week are required.`);
  if (t.daysPerWeek + t.restDaysPerWeek > 7) throw ruleViolation('Working days plus rest days cannot exceed 7.');
  if (t.leaveDaysPerYear < minLeave) throw ruleViolation(`At least ${minLeave} days of annual leave are required.`);
}

/** Pick the most specific active fee rule for a host and role (FR-ACC-02). */
export async function pickFeeRule(org: { size_tier: string; sector_code: string }, roleTitle: string, months: number, db: Db) {
  return one(
    `select * from fee_rules
      where active and (size_tier is null or size_tier = $1) and (sector_code is null or sector_code = $2)
        and (role_keyword is null or $3 ilike '%' || role_keyword || '%')
        and (min_months is null or $4 >= min_months) and (max_months is null or $4 <= max_months)
      order by priority, (size_tier is not null)::int + (sector_code is not null)::int + (role_keyword is not null)::int desc
      limit 1`,
    [org.size_tier, org.sector_code, roleTitle, months],
    db,
  );
}

const render = (tpl: string, vars: Record<string, unknown>) =>
  tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '—' : String(vars[k])));

export async function contractVars(contractId: string, placementId: string | null, db: Db) {
  const c = await one(
    `select c.*, p.full_name, p.cid_last4 from employment_contracts c join person_profiles p on p.id = c.person_id where c.id = $1`, [contractId], db);
  const pl = placementId
    ? await one(`select pl.role_title, o.name as host from placements pl join organisations o on o.id = pl.org_id where pl.id = $1`, [placementId], db)
    : null;
  return {
    apprentice_name: c.full_name, cid_last4: c.cid_last4 ?? '—', start_date: displayDate(c.start_date), end_date: displayDate(c.end_date),
    host_name: pl?.host ?? 'to be assigned', role_title: pl?.role_title ?? 'apprentice', wage: Number(c.wage).toLocaleString('en-IN'),
    pay_day: await getSetting('payroll.pay_day', db), hours_per_week: c.hours_per_week, days_per_week: c.days_per_week,
    rest_days: c.rest_days_per_week, leave_days: c.leave_days_per_year, bench_pay_pct: await getSetting('placement.bench_pay_pct', db),
  };
}

export async function hpaVars(hpaId: string, placementId: string, db: Db) {
  const h = await one(
    `select h.*, o.name as host, o.trade_licence_no, pl.role_title, pl.wage, p.full_name
       from host_placement_agreements h join organisations o on o.id = h.org_id
       join placements pl on pl.id = $2 join person_profiles p on p.id = pl.person_id where h.id = $1`, [hpaId, placementId], db);
  return {
    host_name: h.host, trade_licence_no: h.trade_licence_no, apprentice_name: h.full_name, role_title: h.role_title,
    start_date: displayDate(h.start_date), end_date: displayDate(h.end_date), wage: Number(h.wage).toLocaleString('en-IN'),
    monthly_service_fee: Number(h.monthly_service_fee).toLocaleString('en-IN'), placement_fee: Number(h.placement_fee).toLocaleString('en-IN'),
    admin_fee_desc: [Number(h.admin_fee_pct) ? `${h.admin_fee_pct}% of wage` : null, Number(h.admin_fee_fixed) ? `Nu ${h.admin_fee_fixed}` : null].filter(Boolean).join(' + ') || 'none',
    replacement_entitlement: h.replacement_entitlement, replacement_period_days: h.replacement_period_days,
  };
}

/** Create a new pending version of a contract or HPA document (FR-PLC-13). */
export async function newDocumentVersion(kind: 'employment_contract' | 'hpa', agreementId: string, vars: Record<string, unknown>, db: Db) {
  const tpl = await getSetting(kind === 'hpa' ? 'templates.hpa' : 'templates.employment_contract', db);
  const v = await one<{ v: number }>('select coalesce(max(version), 0) + 1 as v from agreement_documents where kind = $1 and agreement_id = $2', [kind, agreementId], db);
  await db.query(`update agreement_documents set status = 'superseded' where kind = $1 and agreement_id = $2 and status = 'pending_signature'`, [kind, agreementId]);
  const doc = await one<{ id: string }>(
    `insert into agreement_documents (kind, agreement_id, version, content, body_text) values ($1, $2, $3, $4, $5) returning id`,
    [kind, agreementId, v!.v, JSON.stringify(vars), render(tpl, vars)], db);
  const table = kind === 'hpa' ? 'host_placement_agreements' : 'employment_contracts';
  await db.query(`update ${table} set version = $2, status = case when status in ('draft','signed','sent') then 'sent' else status end where id = $1`, [agreementId, v!.v]);
  return { id: doc!.id, version: v!.v };
}

/**
 * Turn a host's offer into the three-agreement set (Workflow 3, step 1):
 * Employment Contract (BTBG and apprentice), HPA (BTBG and host) and the Case File (placement).
 * A benched apprentice keeps their contract; it is only re-issued if the terms change.
 */
export async function confirmOffer(
  applicationId: string,
  input: ContractTerms & { startDate: string; months?: number; officerId?: string | null; feeRuleId?: string | null },
  actorId: string,
  db: Db,
) {
  const a = await one(
    `select a.id, a.stage, a.person_id, a.vacancy_id, a.offer_wage, v.org_id, v.title, v.status as vacancy_status,
            o.size_tier, o.sector_code, o.verification_status, o.status as org_status, p.full_name, p.user_id, p.mobile, p.assigned_officer_id
       from applications a join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id
       join person_profiles p on p.id = a.person_id where a.id = $1 for update of a`,
    [applicationId], db);
  if (!a) throw notFound('Application');
  if (a.stage !== 'offered') throw ruleViolation('The host must record an offer before BTBG confirms it.');
  if (a.verification_status !== 'verified' || a.org_status !== 'active') throw ruleViolation('The host must be verified and active.');
  if (await one(`select 1 from placements where application_id = $1`, [applicationId], db)) throw ruleViolation('Contracts were already generated for this offer.');
  await validateTerms(input, db);

  const months = input.months ?? (await getSetting('placement.apprenticeship_months', db));
  const plannedEnd = addDays(addMonths(input.startDate, months), -1);

  // One live contract per person: reuse it if the apprentice is on bench.
  let contract = await one(`select * from employment_contracts where person_id = $1 and status in ('draft','sent','signed','active','bench')`, [a.person_id], db);
  let contractNeedsSignature = true;
  if (contract && contract.status === 'active') throw ruleViolation('This apprentice is already on an active placement.');
  if (contract) {
    const same = Number(contract.wage) === input.wage && Number(contract.hours_per_week) === input.hoursPerWeek &&
      contract.days_per_week === input.daysPerWeek && contract.rest_days_per_week === input.restDaysPerWeek && contract.leave_days_per_year === input.leaveDaysPerYear;
    contractNeedsSignature = !same || contract.status !== 'bench';
    if (!same) {
      await db.query(
        `update employment_contracts set wage = $2, hours_per_week = $3, days_per_week = $4, rest_days_per_week = $5, leave_days_per_year = $6 where id = $1`,
        [contract.id, input.wage, input.hoursPerWeek, input.daysPerWeek, input.restDaysPerWeek, input.leaveDaysPerYear]);
    }
  } else {
    contract = await one(
      `insert into employment_contracts (person_id, status, wage, hours_per_week, days_per_week, rest_days_per_week, leave_days_per_year, start_date, end_date, created_by)
       values ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9) returning *`,
      [a.person_id, input.wage, input.hoursPerWeek, input.daysPerWeek, input.restDaysPerWeek, input.leaveDaysPerYear, input.startDate, plannedEnd, actorId], db);
  }

  const rule = input.feeRuleId
    ? await one('select * from fee_rules where id = $1 and active', [input.feeRuleId], db)
    : await pickFeeRule(a, a.title, months, db);
  if (!rule) throw ruleViolation('No active fee rule applies to this host. Add one in Configuration.');
  const [entitlement, periodDays] = await Promise.all([getSetting('placement.replacement_entitlement', db), getSetting('placement.replacement_period_days', db)]);
  const hpa = await one<{ id: string }>(
    `insert into host_placement_agreements (org_id, fee_rule_id, placement_fee, monthly_service_fee, admin_fee_pct, admin_fee_fixed,
            replacement_entitlement, replacement_period_days, start_date, end_date, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'draft',$11) returning id`,
    [a.org_id, rule.id, rule.placement_fee, rule.monthly_service_fee, rule.admin_fee_pct, rule.admin_fee_fixed, entitlement, periodDays, input.startDate, plannedEnd, actorId], db);

  const placement = await one<{ id: string }>(
    `insert into placements (contract_id, hpa_id, person_id, org_id, vacancy_id, application_id, officer_id, role_title, wage, start_date, planned_end_date, status, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'offered',$12) returning id`,
    [contract.id, hpa!.id, a.person_id, a.org_id, a.vacancy_id, applicationId, input.officerId ?? a.assigned_officer_id ?? actorId,
      a.title, input.wage, input.startDate, plannedEnd, actorId], db);
  await db.query(`insert into placement_status_history (placement_id, to_status, reason, changed_by) values ($1, 'offered', 'Offer confirmed by BTBG', $2)`, [placement!.id, actorId]);

  if (contractNeedsSignature) {
    await newDocumentVersion('employment_contract', contract.id, await contractVars(contract.id, placement!.id, db), db);
    await notify({ userId: a.user_id, mobile: a.mobile, code: 'contract_to_sign', vars: { link: `${env.WEB_URL}/app/seeker/contract` }, link: '/app/seeker/contract' }, db);
  }
  await newDocumentVersion('hpa', hpa!.id, await hpaVars(hpa!.id, placement!.id, db), db);
  const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code = 'host_owner'`, [a.org_id], db);
  for (const o of owners) {
    await notify({ userId: o.user_id, code: 'hpa_to_sign', vars: { apprentice: a.full_name, link: `${env.WEB_URL}/app/host/agreements` }, link: '/app/host/agreements' }, db);
  }
  await tryActivate(placement!.id, actorId, db);
  return { placementId: placement!.id, contractId: contract.id, hpaId: hpa!.id, contractNeedsSignature };
}

/** Lock the signed version as a PDF and fingerprint it (FR-PLC-13). */
export async function signDocument(kind: 'employment_contract' | 'hpa', agreementId: string, signer: { userId: string; name: string; ip: string | null }, db: Db) {
  const doc = await one(
    `select * from agreement_documents where kind = $1 and agreement_id = $2 and status = 'pending_signature' order by version desc limit 1 for update`,
    [kind, agreementId], db);
  if (!doc) throw badRequest('There is nothing waiting for your signature.');
  const signedAt = new Date();
  const bodyHash = sha256(doc.body_text);
  const pdf = await agreementPdf({
    title: kind === 'hpa' ? 'Host Placement Agreement' : 'Employment Contract',
    reference: agreementId.slice(0, 8).toUpperCase(), version: doc.version, body: doc.body_text,
    signature: { name: signer.name, at: signedAt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC', method: 'SMS one-time password', ip: signer.ip, hash: bodyHash },
  });
  const path = await putFile(`agreements/${kind}/${agreementId}/v${doc.version}.pdf`, pdf, 'application/pdf');
  await db.query(
    `update agreement_documents set status = 'signed', signed_by = $2, signed_at = $3, signer_ip = $4, file_path = $5, sha256 = $6 where id = $1`,
    [doc.id, signer.userId, signedAt, signer.ip, path, sha256(pdf)]);
  const table = kind === 'hpa' ? 'host_placement_agreements' : 'employment_contracts';
  await db.query(
    `update ${table} set status = case when status in ('draft','sent') then 'signed' else status end, signed_at = $2 ${kind === 'hpa' ? ', signed_by = $3' : ''} where id = $1`,
    kind === 'hpa' ? [agreementId, signedAt, signer.userId] : [agreementId, signedAt]);
  await audit({ actorId: signer.userId, action: `contract.signed_${kind}`, entityType: kind, entityId: agreementId, ip: signer.ip, details: { version: doc.version, sha256: bodyHash } }, db);
  const placements = await query<{ id: string }>(
    `select id from placements where ${kind === 'hpa' ? 'hpa_id' : 'contract_id'} = $1 and status in ('offered','contracted')`, [agreementId], db);
  for (const p of placements) await tryActivate(p.id, signer.userId, db);
  return { version: doc.version, filePath: path };
}

/**
 * FR-PLC-14: a placement cannot start until both the Employment Contract and
 * the HPA are signed. Once both are, it becomes Contracted, and Active on its start date.
 */
export async function tryActivate(placementId: string, actorId: string | null, db: Db, opts: { force?: boolean } = {}) {
  const p = await one(
    `select pl.*, c.status as contract_status, h.status as hpa_status,
            exists (select 1 from agreement_documents d where d.kind = 'employment_contract' and d.agreement_id = c.id and d.status = 'pending_signature') as contract_pending,
            exists (select 1 from agreement_documents d where d.kind = 'hpa' and d.agreement_id = h.id and d.status = 'pending_signature') as hpa_pending
       from placements pl join employment_contracts c on c.id = pl.contract_id join host_placement_agreements h on h.id = pl.hpa_id
      where pl.id = $1 for update of pl`, [placementId], db);
  if (!p || !['offered', 'contracted'].includes(p.status)) return p?.status;
  const contractSigned = !p.contract_pending && ['signed', 'active', 'bench'].includes(p.contract_status);
  const hpaSigned = !p.hpa_pending && p.hpa_status === 'signed';
  if (!contractSigned || !hpaSigned) {
    if (opts.force) throw ruleViolation('Both the Employment Contract and the Host Placement Agreement must be signed before the placement starts.');
    return p.status;
  }
  if (p.status === 'offered') await setPlacementStatus(placementId, 'contracted', 'Both agreements signed', actorId, db);
  if (p.start_date > todayBT() && !opts.force) return 'contracted';
  await activate(p, actorId, db);
  return 'active';
}

async function activate(p: any, actorId: string | null, db: Db) {
  await setPlacementStatus(p.id, 'active', 'Placement started', actorId, db);
  await db.query(`update employment_contracts set status = 'active' where id = $1`, [p.contract_id]);
  await db.query(`update host_placement_agreements set status = 'active' where id = $1`, [p.hpa_id]);
  await db.query(`update bench_periods set ended_at = now(), end_reason = 'Redeployed' where contract_id = $1 and ended_at is null`, [p.contract_id]);
  // FR-PLC-16: check-ins with both the apprentice and the host.
  const days = await getSetting('placement.checkin_days', db);
  for (const d of days) {
    for (const party of ['apprentice', 'host']) {
      await db.query(`insert into checkins (placement_id, day, party, due_date) values ($1, $2, $3, $4) on conflict do nothing`, [p.id, d, party, addDays(p.start_date, d)]);
    }
  }
  await db.query(`update person_profiles set lifecycle = 'apprentice' where id = $1`, [p.person_id]);
  await setStage(p.person_id, 'placed', `Placed as ${p.role_title}`, actorId, db);
  if (p.application_id) await db.query(`update applications set stage = 'hired' where id = $1`, [p.application_id]);
  if (p.vacancy_id) {
    const v = await one(`update vacancies set filled = filled + 1 where id = $1 returning filled, openings, status`, [p.vacancy_id], db);
    if (v && v.filled >= v.openings && v.status === 'open') {
      await db.query(`update vacancies set status = 'filled' where id = $1`, [p.vacancy_id]);
      await db.query(`insert into vacancy_status_history (vacancy_id, from_status, to_status, comment) values ($1, 'open', 'filled', 'All openings filled')`, [p.vacancy_id]);
    }
  }
  const person = await one('select user_id, mobile from person_profiles where id = $1', [p.person_id], db);
  const host = await one('select name from organisations where id = $1', [p.org_id], db);
  await notify({ userId: person.user_id, mobile: person.mobile, code: 'placement_started', vars: { host: host.name, date: displayDate(p.start_date), checkin: displayDate(addDays(p.start_date, days[0])) }, channels: ['in_app'] }, db);
}

export async function setPlacementStatus(id: string, to: string, reason: string | null, actorId: string | null, db: Db) {
  const cur = await one<{ status: string }>('select status from placements where id = $1', [id], db);
  if (!cur || cur.status === to) return;
  await db.query('update placements set status = $2 where id = $1', [id, to]);
  await db.query(`insert into placement_status_history (placement_id, from_status, to_status, reason, changed_by) values ($1,$2,$3,$4,$5)`, [id, cur.status, to, reason, actorId]);
}

/**
 * End a placement early and start redeployment (FR-PLC-20..23, Workflow 4).
 * The Employment Contract stays alive; the apprentice moves to Bench.
 */
export async function endPlacementEarly(
  placementId: string,
  input: { reasonCode: 'host_decision' | 'apprentice_request' | 'btbg_monitoring' | 'other'; reason: string; endDate?: string },
  actorId: string,
  db: Db,
) {
  const p = await one(`select * from placements where id = $1 for update`, [placementId], db);
  if (!p) throw notFound('Placement');
  if (!['active', 'ending'].includes(p.status)) throw ruleViolation('Only an active placement can be ended.');
  const endDate = input.endDate ?? todayBT();
  await db.query(
    `update placements set actual_end_date = $2, end_reason_code = $3, end_reason_text = $4 where id = $1`,
    [placementId, endDate, input.reasonCode, input.reason]);
  await setPlacementStatus(placementId, 'ended', input.reason, actorId, db);
  await db.query(`update host_placement_agreements set status = 'ended', ended_at = now(), end_reason = $2 where id = $1`, [p.hpa_id, input.reason]);
  await db.query(`update checkins set completed_at = coalesce(completed_at, now()), form_data = coalesce(form_data, '{"skipped":"placement ended"}') where placement_id = $1 and completed_at is null`, [placementId]);

  // FR-PLC-23: one free replacement within the placement period, if the host has entitlement left.
  const hpa = await one(`select * from host_placement_agreements where id = $1`, [p.hpa_id], db);
  let replacementApplied = false;
  const withinPeriod = daysBetween(p.start_date, endDate) <= hpa.replacement_period_days;
  if (withinPeriod && hpa.replacements_used < hpa.replacement_entitlement) {
    await db.query(`update host_placement_agreements set replacements_used = replacements_used + 1 where id = $1`, [p.hpa_id]);
    await db.query(`update placements set replacement_applied = true where id = $1`, [placementId]);
    replacementApplied = true;
  }
  const bench = await startBench(p.contract_id, placementId, actorId, db);
  await createTask({
    kind: 'redeploy', title: 'Redeploy apprentice from bench', description: `Placement ended: ${input.reason}`,
    entityType: 'person', entityId: p.person_id, assigneeRole: 'operations_manager', priority: 'high',
    dueAt: bench.deadline, dedupeKey: `redeploy:${bench.id}`,
  }, db);
  return { benchId: bench.id, deadline: bench.deadline, replacementApplied };
}

export async function startBench(contractId: string, previousPlacementId: string | null, actorId: string | null, db: Db) {
  const [days, pct, cal] = await Promise.all([getSetting('placement.redeploy_working_days', db), getSetting('placement.bench_pay_pct', db), getCalendar(db)]);
  const start = todayBT();
  const deadline = addWorkingDays(start, days, cal);
  await db.query(`update employment_contracts set status = 'bench' where id = $1`, [contractId]);
  const b = await one<{ id: string }>(
    `insert into bench_periods (contract_id, previous_placement_id, start_date, deadline, pay_rule) values ($1, $2, $3, $4, $5) returning id`,
    [contractId, previousPlacementId, start, deadline, JSON.stringify({ pct, workingDays: days })], db);
  const person = await one(`select p.id, p.user_id, p.mobile from employment_contracts c join person_profiles p on p.id = c.person_id where c.id = $1`, [contractId], db);
  await setStage(person.id, 'ready', 'On bench awaiting redeployment', actorId, db);
  await notify({ userId: person.user_id, mobile: person.mobile, code: 'generic', channels: ['in_app', 'sms'],
    vars: { subject: 'You are still employed by BTBG', body: `Your placement has ended, but your BTBG contract continues and you will be paid ${pct}% of your wage while we find your next host (by ${displayDate(deadline)}).` } }, db);
  return { id: b!.id, deadline };
}

/** FR-PLC-24/25/26: every programme ends by conversion, move to a new host, or exit, with a certificate. */
export async function recordOutcome(
  placementId: string,
  input: { outcome: 'conversion' | 'move' | 'exit'; reason: string; directHireWage?: number; directHireDate?: string; ncMapping?: string | null },
  actorId: string,
  db: Db,
) {
  const p = await one(
    `select pl.*, o.name as host, per.full_name, per.user_id, per.mobile from placements pl join organisations o on o.id = pl.org_id
       join person_profiles per on per.id = pl.person_id where pl.id = $1 for update of pl`, [placementId], db);
  if (!p) throw notFound('Placement');
  if (!['active', 'ending'].includes(p.status)) throw ruleViolation('Only an active placement can be given an outcome.');
  if (input.outcome === 'conversion' && (!input.directHireWage || !input.directHireDate)) {
    throw badRequest('A conversion needs the direct-hire wage and date.');
  }
  const today = todayBT();
  await db.query(
    `update placements set outcome = $2, outcome_reason = $3, outcome_at = now(), actual_end_date = coalesce(actual_end_date, $4),
            direct_hire_wage = $5, direct_hire_date = $6 where id = $1`,
    [placementId, input.outcome, input.reason, input.directHireDate ?? today, input.directHireWage ?? null, input.directHireDate ?? null]);
  await db.query(`update host_placement_agreements set status = 'ended', ended_at = now(), end_reason = $2 where id = $1`, [p.hpa_id, `Outcome: ${input.outcome}`]);

  let result: Record<string, unknown> = {};
  if (input.outcome === 'move') {
    await setPlacementStatus(placementId, 'ended', 'Move to new host', actorId, db);
    const bench = await startBench(p.contract_id, placementId, actorId, db);
    await createTask({ kind: 'redeploy', title: `Find a new host for ${p.full_name}`, entityType: 'person', entityId: p.person_id,
      assigneeRole: 'operations_manager', priority: 'high', dueAt: bench.deadline, dedupeKey: `redeploy:${bench.id}` }, db);
    result = { bench };
  } else {
    await setPlacementStatus(placementId, input.outcome === 'conversion' ? 'converted' : 'ended', input.reason, actorId, db);
    await db.query(`update employment_contracts set status = 'ended', ended_at = now(), end_reason = $2 where id = $1`, [p.contract_id, `${input.outcome}: ${input.reason}`]);
    await db.query(`update person_profiles set lifecycle = 'alumni' where id = $1`, [p.person_id]);
    if (input.outcome === 'conversion') {
      // Alumni follow-up at 6 and 12 months (FR-PLC-27, Workflow 3 step 9).
      for (const months of [6, 12]) {
        await createTask({
          kind: 'alumni_survey', title: `${months}-month alumni follow-up: ${p.full_name} at ${p.host}`,
          entityType: 'person', entityId: p.person_id, assigneeRole: 'field_officer',
          dueAt: addMonths(input.directHireDate!, months), dedupeKey: `alumni_survey:${placementId}:${months}`,
        }, db);
      }
    }
  }
  const certificate = await issueCertificate({
    personId: p.person_id, placementId, kind: 'btbg_programme', title: 'BTBG Apprenticeship',
    programme: `${p.role_title} at ${p.host}`, outcome: { conversion: 'Hired directly by host', move: 'Moving to a new host', exit: 'Programme completed' }[input.outcome],
    ncMapping: input.ncMapping ?? null, issuedBy: actorId,
  }, db);
  await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where entity_id = $1 and kind = 'record_outcome' and status = 'open'`, [placementId, actorId]);
  return { ...result, certificate };
}

/** Red check-ins create an action task for the Operations Manager within one working day (FR-PLC-18). */
export async function onCheckinCompleted(checkinId: string, actorId: string, db: Db) {
  const c = await one(
    `select c.*, p.full_name, o.name as host from checkins c join placements pl on pl.id = c.placement_id
       join person_profiles p on p.id = pl.person_id join organisations o on o.id = pl.org_id where c.id = $1`, [checkinId], db);
  if (c?.risk_rating === 'red') {
    const cal = await getCalendar(db);
    await createTask({
      kind: 'red_checkin', title: `Red risk at day ${c.day} check-in: ${c.full_name} at ${c.host}`,
      description: c.form_data?.concerns ?? null, entityType: 'placement', entityId: c.placement_id,
      assigneeRole: 'operations_manager', priority: 'urgent', dueAt: addWorkingDays(todayBT(), 1, cal), dedupeKey: `red_checkin:${checkinId}`,
    }, db);
    await notifyRole('operations_manager', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Red check-in', body: `Red risk flagged for ${c.full_name} at ${c.host} (day ${c.day}). Act within 1 working day.` } }, db);
  }
  await audit({ actorId, action: 'checkin.completed', entityType: 'checkin', entityId: checkinId, details: { risk: c?.risk_rating } }, db);
}

/**
 * Risk rating for a self-completed party check-in. Field Officers can override it.
 * Scores are 1 (poor) to 5 (good).
 */
export function autoRisk(form: { performance?: number; wellbeing?: number; attendance?: number; concerns?: string | null; wantsToLeave?: boolean }) {
  const scores = [form.performance, form.wellbeing, form.attendance].filter((x): x is number => typeof x === 'number');
  const min = scores.length ? Math.min(...scores) : 5;
  if (form.wantsToLeave || min <= 1 || (min <= 2 && form.concerns)) return 'red' as const;
  if (min <= 3 || (form.concerns && form.concerns.trim().length > 0)) return 'amber' as const;
  return 'green' as const;
}
