import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { daysBetween, todayBT } from '../../lib/dates.js';
import { badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zDate, zPage } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { createTask } from '../../lib/tasks.js';
import { issueCertificate } from '../certificates/service.js';
import {
  confirmOffer, contractVars, endPlacementEarly, newDocumentVersion, onCheckinCompleted, PLACEMENT_STATUSES, recordOutcome, tryActivate, validateTerms,
} from './service.js';

const m = createModule('/placements', 'Placements and Employer of Record');
export default m;

const VIEW = { any: ['placements.view'] };
const MANAGE = { any: ['placements.manage'] };
const APPROVE = { any: ['placements.approve_end'] };

m.route(
  { method: 'get', path: '/', summary: 'Placements (case files)', access: VIEW,
    query: zPage.extend({ status: z.enum(PLACEMENT_STATUSES).optional(), orgId: z.string().uuid().optional(), mine: z.enum(['true']).optional() }) },
  async ({ query: q, auth }) => {
    const rows = await query(
      `select pl.id, pl.status, pl.role_title as "roleTitle", pl.start_date as "startDate", pl.planned_end_date as "plannedEndDate", pl.wage,
              pl.outcome, p.id as "personId", p.full_name as apprentice, o.id as "orgId", o.name as host, u.full_name as officer,
              c.status as "contractStatus", h.status as "hpaStatus",
              (select min(due_date) from checkins ck where ck.placement_id = pl.id and ck.completed_at is null) as "nextCheckin",
              (select risk_rating from checkins ck where ck.placement_id = pl.id and ck.completed_at is not null order by completed_at desc limit 1) as "lastRisk",
              count(*) over() as total
         from placements pl join person_profiles p on p.id = pl.person_id join organisations o on o.id = pl.org_id
         left join users u on u.id = pl.officer_id left join employment_contracts c on c.id = pl.contract_id
         left join host_placement_agreements h on h.id = pl.hpa_id
        where ($1::text is null or pl.status = $1) and ($2::uuid is null or pl.org_id = $2) and ($3::uuid is null or pl.officer_id = $3)
          and ($4::text is null or p.full_name ilike '%' || $4 || '%' or o.name ilike '%' || $4 || '%')
        order by case pl.status when 'active' then 0 when 'ending' then 0 when 'offered' then 1 when 'contracted' then 1 else 2 end, pl.start_date desc
        ${pageClause(q)}`,
      [q.status ?? null, q.orgId ?? null, q.mine ? auth.userId : null, q.q ?? null],
    );
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  },
);

m.route({ method: 'get', path: '/bench', summary: 'Apprentices on bench with redeployment timers', access: VIEW }, async () =>
  query(
    `select b.id, b.start_date as "startDate", b.deadline, b.pay_rule as "payRule", b.alerted_50 as "alerted50", b.alerted_80 as "alerted80", b.escalated,
            p.id as "personId", p.full_name as name, p.dzongkhag_id as "dzongkhagId", c.id as "contractId", c.wage,
            o.name as "previousHost", pl.end_reason_text as "endReason"
       from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles p on p.id = c.person_id
       left join placements pl on pl.id = b.previous_placement_id left join organisations o on o.id = pl.org_id
      where b.ended_at is null order by b.deadline`,
  ).then((rows) => rows.map((r) => {
    const total = Math.max(1, daysBetween(r.startDate, r.deadline));
    const elapsed = Math.max(0, daysBetween(r.startDate, todayBT()));
    return { ...r, pctElapsed: Math.min(100, Math.round((elapsed / total) * 100)), daysLeft: daysBetween(todayBT(), r.deadline) };
  })),
);

m.route({ method: 'get', path: '/requests', summary: 'Requests from hosts and apprentices', access: { any: ['placements.view', 'grievances.handle'] },
  query: z.object({ status: z.enum(['pending', 'approved', 'rejected']).default('pending') }) },
async ({ query: q }) =>
  query(
    `select r.id, r.kind, r.requester_party as "requesterParty", r.reason_code as "reasonCode", r.reason, r.status, r.created_at as "createdAt",
            r.direct_hire_wage as "directHireWage", r.direct_hire_date as "directHireDate", r.decision_note as "decisionNote",
            r.grievance_signoff_at as "grievanceSignoffAt", pl.id as "placementId", p.full_name as apprentice, o.name as host, u.full_name as "requestedBy",
            exists (select 1 from grievances g where g.placement_id = pl.id and g.status not in ('resolved','closed','referred')) as "openGrievance"
       from placement_requests r join placements pl on pl.id = r.placement_id join person_profiles p on p.id = pl.person_id
       join organisations o on o.id = pl.org_id left join users u on u.id = r.requested_by
      where r.status = $1 order by r.created_at`,
    [q.status],
  ),
);

m.route({ method: 'get', path: '/:id', summary: 'Case file: agreements, check-ins, attendance, ratings', access: VIEW }, async ({ params, auth }) => {
  const pl = await one(
    `select pl.*, p.full_name as apprentice, p.mobile as apprentice_mobile, o.name as host, u.full_name as officer, s.full_name as supervisor
       from placements pl join person_profiles p on p.id = pl.person_id join organisations o on o.id = pl.org_id
       left join users u on u.id = pl.officer_id left join users s on s.id = pl.supervisor_user_id where pl.id = $1`, [params.id]);
  if (!pl) throw notFound('Placement');
  const [contract, hpa, docs, checkins, attendance, notes, ratings, requests, history, bench, grievances, certificates] = await Promise.all([
    one('select * from employment_contracts where id = $1', [pl.contract_id]),
    one('select * from host_placement_agreements where id = $1', [pl.hpa_id]),
    query(`select id, kind, version, status, signed_at as "signedAt", sha256, file_path is not null as "hasPdf", created_at as "createdAt"
             from agreement_documents where (kind = 'employment_contract' and agreement_id = $1) or (kind = 'hpa' and agreement_id = $2) order by kind, version desc`,
      [pl.contract_id, pl.hpa_id]),
    query(`select c.id, c.day, c.party, c.due_date as "dueDate", c.form_data as "formData", c.risk_rating as "riskRating", c.completed_at as "completedAt",
                  c.due_date < current_date and c.completed_at is null as overdue, u.full_name as "completedBy"
             from checkins c left join users u on u.id = c.completed_by where c.placement_id = $1 order by c.day, c.party`, [params.id]),
    query(`select period, scheduled_days as "scheduledDays", absence_dates as "absenceDates", paid_leave_days as "paidLeaveDays", days_worked as "daysWorked",
                  confirmed_at as "confirmedAt", defaulted from attendance where placement_id = $1 order by period desc`, [params.id]),
    query(`select n.note, n.punctuality, n.skills, n.attitude, n.teamwork, n.customer_care as "customerCare", n.created_at as "at", u.full_name as author
             from performance_notes n left join users u on u.id = n.author_id where n.placement_id = $1 order by n.created_at desc`, [params.id]),
    query(`select from_party as "fromParty", to_party as "toParty", context, stars, criteria_scores as "criteria", comment, created_at as "at"
             from ratings where placement_id = $1 order by created_at desc`, [params.id]),
    query(`select id, kind, requester_party as "requesterParty", reason, status, created_at as "createdAt", decision_note as "decisionNote"
             from placement_requests where placement_id = $1 order by created_at desc`, [params.id]),
    query(`select h.from_status as "from", h.to_status as "to", h.reason, h.created_at as "at", u.full_name as "by"
             from placement_status_history h left join users u on u.id = h.changed_by where h.placement_id = $1 order by h.id`, [params.id]),
    query(`select id, start_date as "startDate", deadline, ended_at as "endedAt", end_reason as "endReason" from bench_periods where contract_id = $1 order by start_date desc`, [pl.contract_id]),
    auth.permissions.has('grievances.view_all')
      ? query(`select id, ref, category, severity, status from grievances where placement_id = $1`, [params.id])
      : query(`select count(*)::int as open from grievances where placement_id = $1 and status not in ('resolved','closed')`, [params.id]),
    query(`select title, verification_code as code, issued_at as "issuedAt" from certificates where placement_id = $1`, [params.id]),
  ]);
  return { ...pl, contract, hpa, documents: docs, checkins, attendance, notes, ratings, requests, history, bench, grievances, certificates };
});

const termsBody = z.object({
  wage: z.number().min(0), hoursPerWeek: z.number().min(1), daysPerWeek: z.number().int().min(1).max(7),
  restDaysPerWeek: z.number().int().min(0).max(6), leaveDaysPerYear: z.number().int().min(0),
});

m.route(
  { method: 'post', path: '/confirm-offer', summary: 'Confirm a host offer and generate the Employment Contract and HPA', access: MANAGE,
    body: termsBody.extend({ applicationId: z.string().uuid(), startDate: zDate, months: z.number().int().min(3).max(6).optional(),
      officerId: z.string().uuid().nullable().optional(), feeRuleId: z.string().uuid().nullable().optional() }) },
  async ({ body, auth, ip }) =>
    tx(async (db) => {
      const r = await confirmOffer(body.applicationId, body, auth.userId, db);
      await audit({ actorId: auth.userId, action: 'contract.generated', entityType: 'placement', entityId: r.placementId, ip, details: { applicationId: body.applicationId } }, db);
      return r;
    }),
);

m.route({ method: 'post', path: '/:id/start', summary: 'Start a contracted placement now (both agreements must be signed)', access: MANAGE },
  async ({ params, auth }) => tx(async (db) => ({ status: await tryActivate(params.id, auth.userId, db, { force: true }) })),
);

m.route(
  { method: 'post', path: '/:id/amend-contract', summary: 'Change contract terms; creates a new version to sign', access: MANAGE, body: termsBody.extend({ reason: z.string().min(3) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const pl = await one('select contract_id, person_id from placements where id = $1', [params.id], db);
      if (!pl) throw notFound('Placement');
      await validateTerms(body, db);
      await db.query(
        `update employment_contracts set wage = $2, hours_per_week = $3, days_per_week = $4, rest_days_per_week = $5, leave_days_per_year = $6 where id = $1`,
        [pl.contract_id, body.wage, body.hoursPerWeek, body.daysPerWeek, body.restDaysPerWeek, body.leaveDaysPerYear]);
      await db.query('update placements set wage = $2 where id = $1', [params.id, body.wage]);
      const doc = await newDocumentVersion('employment_contract', pl.contract_id, await contractVars(pl.contract_id, params.id, db), db);
      const person = await one('select user_id, mobile from person_profiles where id = $1', [pl.person_id], db);
      await notify({ userId: person.user_id, mobile: person.mobile, code: 'contract_to_sign', vars: { link: '/app/seeker/contract' } }, db);
      await audit({ actorId: auth.userId, action: 'contract.amended', entityType: 'employment_contract', entityId: pl.contract_id, ip, details: body }, db);
      return doc;
    }),
);

m.route(
  { method: 'post', path: '/:id/checkins/:checkinId', summary: 'Complete a check-in with a risk rating (FR-PLC-17)', access: { any: ['checkins.manage'] },
    body: z.object({
      formData: z.object({ attendance: z.string(), performance: z.string(), wellbeing: z.string(), concerns: z.string().optional() }),
      riskRating: z.enum(['green', 'amber', 'red']),
    }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const res = await db.query(
        `update checkins set form_data = $3, risk_rating = $4, completed_at = now(), completed_by = $5 where id = $2 and placement_id = $1 returning id`,
        [params.id, params.checkinId, JSON.stringify(body.formData), body.riskRating, auth.userId]);
      if (!res.rowCount) throw notFound('Check-in');
      await onCheckinCompleted(params.checkinId, auth.userId, db);
      return { ok: true };
    }),
);

const requestBody = z.object({
  kind: z.enum(['conversation', 'warning', 'move', 'end', 'conversion']),
  reasonCode: z.enum(['host_decision', 'apprentice_request', 'btbg_monitoring', 'other']).optional(),
  reason: z.string().trim().min(5),
  directHireWage: z.number().optional(), directHireDate: zDate.optional(),
});
export type PlacementRequestBody = z.infer<typeof requestBody>;
export { requestBody };

/** Shared by host, apprentice and staff request endpoints (FR-EMP-33/34, FR-EE-24). */
export async function createPlacementRequest(placementId: string, party: 'host' | 'apprentice' | 'officer', b: PlacementRequestBody, userId: string, db: any) {
  const pl = await one(`select status, officer_id from placements where id = $1`, [placementId], db);
  if (!pl || !['active', 'ending'].includes(pl.status)) throw ruleViolation('Requests can only be made for an active placement.');
  if (b.kind === 'conversion' && (!b.directHireWage || !b.directHireDate)) throw badRequest('A conversion request needs the direct-hire wage and start date.');
  const reasonCode = b.reasonCode ?? (party === 'host' ? 'host_decision' : party === 'apprentice' ? 'apprentice_request' : 'btbg_monitoring');
  const r = await one(
    `insert into placement_requests (placement_id, kind, requester_party, requested_by, reason_code, reason, direct_hire_wage, direct_hire_date)
     values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [placementId, b.kind, party, userId, reasonCode, b.reason, b.directHireWage ?? null, b.directHireDate ?? null], db);
  if (['move', 'end'].includes(b.kind)) {
    await db.query(`update placements set status = 'ending' where id = $1 and status = 'active'`, [placementId]);
    await db.query(`insert into placement_status_history (placement_id, from_status, to_status, reason, changed_by) values ($1, 'active', 'ending', $2, $3)`, [placementId, `${b.kind} requested by ${party}`, userId]);
  }
  await createTask({
    kind: `placement_request_${b.kind}`, title: `${party === 'host' ? 'Host' : party === 'apprentice' ? 'Apprentice' : 'Officer'} requests ${b.kind}`,
    description: b.reason, entityType: 'placement', entityId: placementId,
    assigneeRole: ['conversation', 'warning'].includes(b.kind) ? 'field_officer' : 'operations_manager',
    assigneeId: ['conversation', 'warning'].includes(b.kind) ? pl.officer_id : null,
    priority: ['end', 'move'].includes(b.kind) ? 'high' : 'normal', dedupeKey: `placement_request:${r!.id}`,
  }, db);
  return { id: r!.id };
}

m.route({ method: 'post', path: '/:id/requests', summary: 'Officer raises a request on a placement', access: { any: ['checkins.manage', 'placements.manage'] }, body: requestBody },
  async ({ params, body, auth }) => tx((db) => createPlacementRequest(params.id, 'officer', body, auth.userId, db)),
);

m.route(
  { method: 'post', path: '/requests/:requestId/grievance-signoff', summary: 'Grievance Officer signs off an end request on a placement with an open grievance', access: { any: ['grievances.handle'] },
    body: z.object({ note: z.string().min(3) }) },
  async ({ params, body, auth, ip }) => {
    await query(`update placement_requests set grievance_signoff_by = $2, grievance_signoff_at = now(), decision_note = coalesce(decision_note || E'\\n', '') || $3 where id = $1`,
      [params.requestId, auth.userId, `Grievance Officer: ${body.note}`]);
    await audit({ actorId: auth.userId, action: 'placement.grievance_signoff', entityType: 'placement_request', entityId: params.requestId, ip });
    return { ok: true };
  },
);

m.route(
  { method: 'post', path: '/requests/:requestId/decide', summary: 'Approve or reject a request (Workflow 4 step 2)', access: APPROVE,
    body: z.object({ approve: z.boolean(), note: z.string().min(3), endDate: zDate.optional(), ncMapping: z.string().optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const r = await one(`select r.*, pl.status as placement_status from placement_requests r join placements pl on pl.id = r.placement_id where r.id = $1 for update of r`, [params.requestId], db);
      if (!r) throw notFound('Request');
      if (r.status !== 'pending') throw ruleViolation('This request was already decided.');
      let result: unknown = null;
      if (body.approve && ['end', 'move'].includes(r.kind)) {
        // Workflow 4 exception: an open grievance needs Grievance Officer sign-off first.
        const open = await one(`select 1 from grievances where placement_id = $1 and status not in ('resolved','closed','referred')`, [r.placement_id], db);
        if (open && !r.grievance_signoff_at) throw ruleViolation('A grievance is open on this placement. The Grievance Officer must sign off before it ends.');
        result = await endPlacementEarly(r.placement_id, { reasonCode: r.reason_code, reason: r.reason, endDate: body.endDate }, auth.userId, db);
      } else if (body.approve && r.kind === 'conversion') {
        result = await recordOutcome(r.placement_id, { outcome: 'conversion', reason: r.reason, directHireWage: Number(r.direct_hire_wage), directHireDate: r.direct_hire_date, ncMapping: body.ncMapping }, auth.userId, db);
      } else if (!body.approve && r.placement_status === 'ending') {
        await db.query(`update placements set status = 'active' where id = $1`, [r.placement_id]);
        await db.query(`insert into placement_status_history (placement_id, from_status, to_status, reason, changed_by) values ($1, 'ending', 'active', $2, $3)`, [r.placement_id, `Request rejected: ${body.note}`, auth.userId]);
      }
      await db.query(`update placement_requests set status = $2, decided_by = $3, decided_at = now(), decision_note = coalesce(decision_note || E'\\n', '') || $4 where id = $1`,
        [params.requestId, body.approve ? 'approved' : 'rejected', auth.userId, body.note]);
      await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where dedupe_key = $1`, [`placement_request:${params.requestId}`, auth.userId]);
      if (r.requested_by) {
        await notify({ userId: r.requested_by, code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Request decided', body: `BTBG ${body.approve ? 'approved' : 'did not approve'} your ${r.kind} request. ${body.note}` } }, db);
      }
      await audit({ actorId: auth.userId, action: `placement.request_${body.approve ? 'approved' : 'rejected'}`, entityType: 'placement', entityId: r.placement_id, ip, details: { kind: r.kind } }, db);
      return { ok: true, result };
    }),
);

m.route(
  { method: 'post', path: '/:id/end', summary: 'End a placement early and move the apprentice to bench (staff decision)', access: APPROVE,
    body: z.object({ reasonCode: z.enum(['host_decision', 'apprentice_request', 'btbg_monitoring', 'other']), reason: z.string().min(5), endDate: zDate.optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const open = await one(`select 1 from grievances where placement_id = $1 and status not in ('resolved','closed','referred')`, [params.id], db);
      if (open) throw ruleViolation('A grievance is open on this placement. Raise an end request so the Grievance Officer can sign off.');
      const r = await endPlacementEarly(params.id, body, auth.userId, db);
      await audit({ actorId: auth.userId, action: 'placement.ended', entityType: 'placement', entityId: params.id, ip, details: body }, db);
      return r;
    }),
);

m.route(
  { method: 'post', path: '/:id/outcome', summary: 'Record the programme outcome: conversion, move or exit', access: APPROVE,
    body: z.object({ outcome: z.enum(['conversion', 'move', 'exit']), reason: z.string().min(3), directHireWage: z.number().optional(), directHireDate: zDate.optional(), ncMapping: z.string().optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const r = await recordOutcome(params.id, body, auth.userId, db);
      await audit({ actorId: auth.userId, action: `placement.outcome_${body.outcome}`, entityType: 'placement', entityId: params.id, ip, details: body }, db);
      return r;
    }),
);

m.route({ method: 'post', path: '/bench/:benchId/exit', summary: 'Apprentice resigns while on bench: contract ends with a certificate', access: APPROVE,
  body: z.object({ reason: z.string().min(3) }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const b = await one(`select b.*, c.person_id from bench_periods b join employment_contracts c on c.id = b.contract_id where b.id = $1 and b.ended_at is null`, [params.benchId], db);
    if (!b) throw notFound('Bench period');
    await db.query(`update bench_periods set ended_at = now(), end_reason = $2 where id = $1`, [params.benchId, `Exit: ${body.reason}`]);
    await db.query(`update employment_contracts set status = 'ended', ended_at = now(), end_reason = $2 where id = $1`, [b.contract_id, `Exit: ${body.reason}`]);
    await db.query(`update person_profiles set lifecycle = 'alumni', stage = 'withdrawn' where id = $1`, [b.person_id]);
    const cert = await issueCertificate({ personId: b.person_id, kind: 'btbg_programme', title: 'BTBG Apprenticeship', programme: 'BTBG apprenticeship programme', outcome: 'Exited', issuedBy: auth.userId }, db);
    await audit({ actorId: auth.userId, action: 'contract.ended_exit', entityType: 'employment_contract', entityId: b.contract_id, ip, details: body }, db);
    return { ok: true, certificate: cert };
  }),
);
