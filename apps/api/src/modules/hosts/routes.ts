import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit, recordChanges } from '../../lib/audit.js';
import { encrypt } from '../../lib/crypto.js';
import { addDays, displayDateTime, periodBounds, scheduledDaysInPeriod, todayBT } from '../../lib/dates.js';
import { badRequest, forbidden, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zDate, zMobile, zPage, zPeriod } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { issueOtp, verifyOtp } from '../../lib/otp.js';
import { getCalendar, getSetting } from '../../lib/settings.js';
import { newKey, putFile, validateUpload } from '../../lib/storage.js';
import { createTask } from '../../lib/tasks.js';
import { requireOrg, type AuthContext } from '../../middleware/auth.js';
import { buildTrustProfile } from '../candidates/service.js';
import { autoRisk, onCheckinCompleted, signDocument } from '../placements/service.js';
import { createPlacementRequest, requestBody } from '../placements/routes.js';
import { applicationOutcome } from '../vacancies/applications.js';
import { expectedDaysToFill, saveVacancy, transitionVacancy, vacancyInput } from '../vacancies/service.js';

/**
 * Host employer portal (SRS 3.4). Every query is scoped to the caller's
 * organisation; staff use the /hosts admin routes at the bottom.
 */
const m = createModule('/host', 'Host employer portal');
export default m;

const PORTAL = { any: ['host.portal'] };
const ADMIN = { any: ['host.admin'] };

async function ownApplication(appId: string, orgId: string) {
  const a = await one(
    `select a.*, v.org_id, v.title, v.wage from applications a join vacancies v on v.id = a.vacancy_id where a.id = $1`, [appId]);
  if (!a || a.org_id !== orgId) throw notFound('Candidate');
  // FR-PLC-02: hosts only ever see candidates BTBG has shared.
  if (!a.shared_with_host_at) throw forbidden('This candidate has not been shared with you.');
  return a;
}

async function ownPlacement(placementId: string, orgId: string) {
  const p = await one(`select * from placements where id = $1 and org_id = $2`, [placementId, orgId]);
  if (!p) throw notFound('Apprentice');
  return p;
}

// ---------------------------------------------------------------------------
// Dashboard and profile (FR-EMP-01..04)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/dashboard', summary: 'Host dashboard', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  const [org, counts, nextCheckins, invoices] = await Promise.all([
    one(`select id, name, verification_status as "verificationStatus", status from organisations where id = $1`, [orgId]),
    one(
      `select (select count(*)::int from vacancies where org_id = $1 and status = 'open') as "openVacancies",
              (select count(*)::int from vacancies where org_id = $1 and status in ('draft','submitted')) as "draftVacancies",
              (select count(*)::int from applications a join vacancies v on v.id = a.vacancy_id where v.org_id = $1 and a.shared_with_host_at is not null and a.stage in ('shortlisted','interview','offered') and a.host_decision is distinct from 'declined') as "candidatesToReview",
              (select count(*)::int from placements where org_id = $1 and status in ('active','ending')) as "activeApprentices",
              (select count(*)::int from host_placement_agreements h where h.org_id = $1 and exists (select 1 from agreement_documents d where d.kind = 'hpa' and d.agreement_id = h.id and d.status = 'pending_signature')) as "agreementsToSign"`,
      [orgId]),
    query(
      `select c.id, c.day, c.due_date as "dueDate", p.full_name as apprentice from checkins c join placements pl on pl.id = c.placement_id
         join person_profiles p on p.id = pl.person_id where pl.org_id = $1 and c.party = 'host' and c.completed_at is null and pl.status in ('active','ending')
        order by c.due_date limit 5`, [orgId]),
    one(`select count(*)::int as n, coalesce(sum(total - amount_paid), 0) as balance from invoices where org_id = $1 and status in ('issued','part_paid','overdue')`, [orgId]),
  ]);
  const period = todayBT().slice(0, 7);
  const attendancePending = await one<{ n: number }>(
    `select count(*)::int as n from placements pl where pl.org_id = $1 and pl.status in ('active','ending')
        and not exists (select 1 from attendance a where a.placement_id = pl.id and a.period = $2 and a.confirmed_at is not null)`, [orgId, period]);
  return { org, ...counts, nextCheckins, invoicesDue: invoices, attendancePending: attendancePending?.n ?? 0, period };
});

m.route({ method: 'get', path: '/profile', summary: 'Company profile', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  const org = await one(
    `select o.id, o.name, o.trade_licence_no as "tradeLicenceNo", o.sector_code as "sectorCode", o.star_rating as "starRating", o.dzongkhag_id as "dzongkhagId",
            o.gewog_id as "gewogId", o.address, o.owner_name as "ownerName", o.size_tier as "sizeTier", o.staff_count as "staffCount",
            o.peak_months as "peakMonths", o.off_peak_months as "offPeakMonths", o.culture, o.values_text as "valuesText", o.photos,
            o.compliance_needs as "complianceNeeds", o.verification_status as "verificationStatus", o.status
       from organisations o where o.id = $1`, [orgId]);
  const docs = await query(`select id, kind, file_name as "fileName", created_at as "createdAt" from org_documents where org_id = $1`, [orgId]);
  // FR-EE-32: show the average rating only once at least 3 exist.
  const rating = await one(`select count(*)::int as n, round(avg(stars), 1) as avg from ratings where org_id = $1 and to_party = 'host'`, [orgId]);
  return { ...org, documents: docs, rating: rating && rating.n >= 3 ? { average: rating.avg, count: rating.n } : { average: null, count: rating?.n ?? 0, hiddenUntil: 3 } };
});

const months = z.array(z.number().int().min(1).max(12));
m.route(
  { method: 'put', path: '/profile', summary: 'Update company profile', access: ADMIN,
    body: z.object({
      name: z.string().min(2), sectorCode: z.string(), starRating: z.number().int().min(1).max(5).nullable(), dzongkhagId: z.number().int(),
      gewogId: z.number().int().nullable(), address: z.string().nullable(), sizeTier: z.enum(['micro', 'small', 'medium', 'large']),
      staffCount: z.number().int().min(0).nullable(), peakMonths: months, offPeakMonths: months, culture: z.string().max(2000).nullable(),
      valuesText: z.string().max(2000).nullable(), complianceNeeds: z.string().max(2000).nullable(), ownerName: z.string().nullable(),
      ownerCid: z.string().regex(/^\d{11}$/).optional(),
    }) },
  async ({ body, auth, ip }) => {
    const orgId = requireOrg(auth);
    return tx(async (db) => {
      const before = await one('select * from organisations where id = $1 for update', [orgId], db);
      await db.query(
        `update organisations set name=$2, sector_code=$3, star_rating=$4, dzongkhag_id=$5, gewog_id=$6, address=$7, size_tier=$8, staff_count=$9,
                peak_months=$10, off_peak_months=$11, culture=$12, values_text=$13, compliance_needs=$14, owner_name=$15,
                owner_cid_enc = coalesce($16, owner_cid_enc) where id = $1`,
        [orgId, body.name, body.sectorCode, body.starRating, body.dzongkhagId, body.gewogId, body.address, body.sizeTier, body.staffCount,
          body.peakMonths, body.offPeakMonths, body.culture, body.valuesText, body.complianceNeeds, body.ownerName, encrypt(body.ownerCid)]);
      const { ownerCid: _c, ...visible } = body;
      await recordChanges('organisation', orgId, auth.userId, {
        name: before.name, sectorCode: before.sector_code, starRating: before.star_rating, dzongkhagId: before.dzongkhag_id, gewogId: before.gewog_id,
        address: before.address, sizeTier: before.size_tier, staffCount: before.staff_count, peakMonths: before.peak_months, offPeakMonths: before.off_peak_months,
        culture: before.culture, valuesText: before.values_text, complianceNeeds: before.compliance_needs, ownerName: before.owner_name,
      }, visible, db);
      await audit({ actorId: auth.userId, action: 'host.profile_updated', entityType: 'organisation', entityId: orgId, ip }, db);
      return { ok: true };
    });
  },
);

m.route({ method: 'post', path: '/profile/photos', summary: 'Add a workplace photo', access: ADMIN, upload: true }, async ({ auth, file }) => {
  const orgId = requireOrg(auth);
  if (!file) throw badRequest('Attach a photo.');
  const mime = validateUpload('image', file);
  const key = await putFile(newKey(`orgs/${orgId}/photos`, file.originalname), file.buffer, mime);
  await query(`update organisations set photos = array_append(photos, $2) where id = $1 and coalesce(array_length(photos, 1), 0) < 12`, [orgId, key]);
  return { path: key };
});

m.route({ method: 'post', path: '/documents', summary: 'Upload a verification document such as the trade licence', access: ADMIN, upload: true,
  body: z.object({ kind: z.enum(['trade_licence', 'owner_id', 'address_proof', 'other']) }) },
async ({ auth, file, body }) => {
  const orgId = requireOrg(auth);
  if (!file) throw badRequest('Attach the document.');
  const mime = validateUpload('document', file);
  const key = await putFile(newKey(`orgs/${orgId}/docs`, file.originalname), file.buffer, mime);
  return one(`insert into org_documents (org_id, kind, file_path, file_name, uploaded_by) values ($1,$2,$3,$4,$5) returning id`,
    [orgId, body.kind, key, file.originalname.slice(0, 120), auth.userId]);
});

// Host users (FR-EMP-04)
m.route({ method: 'get', path: '/users', summary: 'People who can use this host account', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  return query(
    `select u.id, u.full_name as "fullName", u.mobile, ur.role_code as role, u.last_login_at as "lastLoginAt", u.password_hash is not null as "hasPassword"
       from user_roles ur join users u on u.id = ur.user_id where ur.org_id = $1 order by ur.role_code, u.full_name`, [orgId]);
});

m.route(
  { method: 'post', path: '/users', summary: 'Add a Host Owner or Host Supervisor', access: ADMIN,
    body: z.object({ fullName: z.string().min(2), mobile: zMobile, role: z.enum(['host_owner', 'host_supervisor']) }) },
  async ({ auth, body, ip }) => {
    const orgId = requireOrg(auth);
    return tx(async (db) => {
      let user = await one<{ id: string }>('select id from users where mobile = $1', [body.mobile], db);
      if (!user) {
        user = await one<{ id: string }>(`insert into users (mobile, full_name, created_by) values ($1, $2, $3) returning id`, [body.mobile, body.fullName, auth.userId], db);
      }
      await db.query(`insert into user_roles (user_id, role_code, org_id, granted_by) values ($1, $2, $3, $4) on conflict do nothing`, [user!.id, body.role, orgId, auth.userId]);
      await notify({ userId: user!.id, code: 'generic', channels: ['sms'], vars: { body: `You were added to a BTBG host account. Sign in with this number; use "Forgot password" to set your password.` } }, db);
      await audit({ actorId: auth.userId, action: 'permissions.host_user_added', entityType: 'organisation', entityId: orgId, ip, details: { userId: user!.id, role: body.role } }, db);
      return { id: user!.id };
    });
  },
);

m.route({ method: 'delete', path: '/users/:userId', summary: 'Remove a host user', access: ADMIN }, async ({ auth, params, ip }) => {
  const orgId = requireOrg(auth);
  if (params.userId === auth.userId) throw badRequest('You cannot remove yourself.');
  await query(`delete from user_roles where user_id = $1 and org_id = $2`, [params.userId, orgId]);
  await audit({ actorId: auth.userId, action: 'permissions.host_user_removed', entityType: 'organisation', entityId: orgId, ip, details: { userId: params.userId } });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Vacancies (FR-EMP-10..17)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/vacancies', summary: 'This host\'s vacancies', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  return query(
    `select v.id, v.title, v.status, v.openings, v.filled, v.wage, v.share_slug as slug, v.review_comment as "reviewComment", v.is_seasonal as "isSeasonal",
            v.created_at as "createdAt", v.opened_at as "openedAt", greatest(0, current_date - v.opened_at::date) as "daysOpen",
            (select count(*)::int from applications a where a.vacancy_id = v.id and a.shared_with_host_at is not null and a.stage not in ('not_selected','withdrawn')) as "inProgress"
       from vacancies v where v.org_id = $1 order by v.created_at desc`, [orgId]);
});

m.route({ method: 'get', path: '/vacancies/:id', summary: 'Vacancy with the shortlist BTBG shared', access: PORTAL }, async ({ auth, params }) => {
  const orgId = requireOrg(auth);
  const v = await one(`select v.*, greatest(0, current_date - v.opened_at::date) as days_open from vacancies v where v.id = $1 and v.org_id = $2`, [params.id, orgId]);
  if (!v) throw notFound('Vacancy');
  const skills = await query('select skill_id as id from vacancy_skills where vacancy_id = $1', [params.id]);
  const shortlist = await query(
    `select a.id, a.stage, a.host_decision as "hostDecision", a.host_decision_reason as "hostDecisionReason", a.shared_with_host_at as "sharedAt",
            a.offer_wage as "offerWage", a.offer_start_date as "offerStartDate", p.full_name as name,
            (select total from screening_results r where r.person_id = p.id order by created_at desc limit 1) as "screeningScore",
            (select json_build_object('id', i.id, 'scheduledAt', i.scheduled_at, 'status', i.status, 'result', i.result, 'location', i.location)
               from interviews i where i.application_id = a.id order by i.created_at desc limit 1) as interview
       from applications a join person_profiles p on p.id = a.person_id
      where a.vacancy_id = $1 and a.shared_with_host_at is not null order by a.shared_with_host_at`, [params.id]);
  const noReady = v.status === 'open' && shortlist.length === 0;
  return { ...v, skillIds: skills.map((s) => s.id), shortlist, expectedDaysToFill: noReady ? await expectedDaysToFill() : null };
});

m.route({ method: 'post', path: '/vacancies', summary: 'Create a vacancy (draft)', access: PORTAL, body: vacancyInput }, async ({ auth, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => ({ id: await saveVacancy(orgId, body, auth.userId, db) }));
});

m.route({ method: 'put', path: '/vacancies/:id', summary: 'Edit a vacancy', access: PORTAL, body: vacancyInput }, async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const v = await one<{ status: string }>('select status from vacancies where id = $1 and org_id = $2', [params.id, orgId], db);
    if (!v) throw notFound('Vacancy');
    await saveVacancy(orgId, body, auth.userId, db, params.id);
    // Material edits to a live vacancy go back for BTBG review.
    if (v.status === 'open') {
      const floor = await getSetting('payroll.wage_floor', db);
      if (body.wage < floor) throw ruleViolation(`The wage cannot go below the floor of Nu ${floor}.`);
    }
    return { ok: true };
  });
});

m.route({ method: 'post', path: '/vacancies/:id/submit', summary: 'Submit a vacancy for BTBG review', access: PORTAL }, async ({ auth, params }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    if (!(await one('select 1 from vacancies where id = $1 and org_id = $2', [params.id, orgId], db))) throw notFound('Vacancy');
    await transitionVacancy(params.id, 'submitted', auth.userId, null, db);
    return { ok: true };
  });
});

m.route({ method: 'post', path: '/vacancies/:id/status', summary: 'Pause, reopen or close a vacancy', access: PORTAL,
  body: z.object({ status: z.enum(['open', 'paused', 'closed']) }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const v = await one<{ status: string }>('select status from vacancies where id = $1 and org_id = $2', [params.id, orgId], db);
    if (!v) throw notFound('Vacancy');
    if (body.status === 'open' && !['paused', 'filled'].includes(v.status)) throw ruleViolation('Only a paused or filled vacancy can be reopened here.');
    await transitionVacancy(params.id, body.status, auth.userId, null, db);
    return { ok: true };
  });
});

// ---------------------------------------------------------------------------
// Candidate review, interviews and offers (FR-EMP-20..23)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/applications/:appId/trust-profile', summary: 'Trust Profile of a shortlisted candidate', access: PORTAL }, async ({ auth, params, ip }) => {
  const orgId = requireOrg(auth);
  const a = await ownApplication(params.appId, orgId);
  const interviewBooked = Boolean(await one(`select 1 from interviews where application_id = $1 and status in ('scheduled','completed')`, [a.id]));
  const profile = await buildTrustProfile(a.person_id, { revealContact: interviewBooked });
  await audit({ actorId: auth.userId, action: 'host.trust_profile_viewed', entityType: 'person', entityId: a.person_id, ip });
  return { ...profile, application: { id: a.id, stage: a.stage, hostDecision: a.host_decision, vacancy: a.title, offeredWage: a.wage } };
});

m.route({ method: 'post', path: '/applications/:appId/decision', summary: 'Accept or decline a shortlisted candidate with a reason', access: PORTAL,
  body: z.object({ decision: z.enum(['accepted', 'declined']), reason: z.string().trim().min(3) }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const a = await ownApplication(params.appId, orgId);
    if (!['shortlisted', 'interview'].includes(a.stage)) throw ruleViolation('This candidate is no longer awaiting your decision.');
    await db.query(`update applications set host_decision = $2, host_decision_reason = $3 where id = $1`, [a.id, body.decision, body.reason]);
    await db.query(`insert into match_decisions (vacancy_id, person_id, decision, reason, decided_by) values ($1, $2, $3, $4, $5)`,
      [a.vacancy_id, a.person_id, body.decision === 'accepted' ? 'shared' : 'rejected', `Host ${body.decision}: ${body.reason}`, auth.userId]);
    if (body.decision === 'declined') await applicationOutcome(a.id, 'not_selected', body.reason, db);
    return { ok: true };
  });
});

m.route({ method: 'post', path: '/applications/:appId/interview', summary: 'Book an interview slot; both sides get SMS', access: PORTAL,
  body: z.object({ scheduledAt: z.string().datetime({ offset: true }), location: z.string().min(2), mode: z.enum(['in_person', 'phone', 'video']).default('in_person') }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const a = await ownApplication(params.appId, orgId);
    if (a.host_decision === 'declined' || ['not_selected', 'withdrawn', 'hired'].includes(a.stage)) throw ruleViolation('This candidate is not available for interview.');
    if (new Date(body.scheduledAt) < new Date()) throw badRequest('Choose a time in the future.');
    await db.query(`update interviews set status = 'cancelled' where application_id = $1 and status = 'scheduled'`, [a.id]);
    const i = await one(`insert into interviews (application_id, scheduled_at, location, mode, booked_by) values ($1,$2,$3,$4,$5) returning id`,
      [a.id, body.scheduledAt, body.location, body.mode, auth.userId], db);
    await db.query(`update applications set stage = 'interview', host_decision = coalesce(host_decision, 'accepted') where id = $1`, [a.id]);
    const p = await one('select user_id, mobile from person_profiles where id = $1', [a.person_id], db);
    const host = await one('select name from organisations where id = $1', [orgId], db);
    const vars = { title: a.title, host: host.name, when: displayDateTime(body.scheduledAt), location: body.location };
    await notify({ userId: p.user_id, mobile: p.mobile, code: 'interview_booked', vars }, db);
    await notify({ userId: auth.userId, code: 'interview_booked', vars }, db);
    return { id: i!.id };
  });
});

m.route({ method: 'post', path: '/interviews/:id/result', summary: 'Record interview result and make an offer', access: PORTAL,
  body: z.object({ result: z.enum(['pass', 'fail']), notes: z.string().optional(), offer: z.object({ wage: z.number().min(0), startDate: zDate }).optional(), reason: z.string().optional() }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const i = await one(`select i.*, a.id as app_id from interviews i join applications a on a.id = i.application_id where i.id = $1`, [params.id], db);
    if (!i) throw notFound('Interview');
    const a = await ownApplication(i.app_id, orgId);
    await db.query(`update interviews set status = 'completed', result = $2, notes = $3 where id = $1`, [params.id, body.result, body.notes ?? null]);
    if (body.result === 'fail') {
      await applicationOutcome(a.id, 'not_selected', body.reason ?? 'Not selected after interview', db);
      return { ok: true };
    }
    if (body.offer) {
      const floor = await getSetting('payroll.wage_floor', db);
      if (body.offer.wage < floor) throw ruleViolation(`The offered wage is below the wage floor of Nu ${floor}.`);
      if (body.offer.startDate < todayBT()) throw badRequest('The start date cannot be in the past.');
      await db.query(`update applications set stage = 'offered', offer_wage = $2, offer_start_date = $3 where id = $1`, [a.id, body.offer.wage, body.offer.startDate]);
      await createTask({ kind: 'confirm_offer', title: `Confirm offer and generate contracts: ${a.title}`, entityType: 'application', entityId: a.id,
        assigneeRole: 'operations_manager', priority: 'high', dueAt: addDays(todayBT(), 2), dedupeKey: `confirm_offer:${a.id}` }, db);
    }
    return { ok: true };
  });
});

// ---------------------------------------------------------------------------
// Host Placement Agreements (FR-EMP-24)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/agreements', summary: 'Host Placement Agreements', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  return query(
    `select h.id, h.status, h.start_date as "startDate", h.end_date as "endDate", h.placement_fee as "placementFee", h.monthly_service_fee as "monthlyServiceFee",
            h.admin_fee_pct as "adminFeePct", h.replacement_entitlement as "replacementEntitlement", h.replacements_used as "replacementsUsed",
            p.full_name as apprentice, pl.role_title as "roleTitle", pl.id as "placementId",
            (select json_build_object('id', d.id, 'version', d.version, 'status', d.status, 'body', d.body_text, 'signedAt', d.signed_at)
               from agreement_documents d where d.kind = 'hpa' and d.agreement_id = h.id order by d.version desc limit 1) as document
       from host_placement_agreements h join placements pl on pl.hpa_id = h.id join person_profiles p on p.id = pl.person_id
      where h.org_id = $1 order by h.created_at desc`, [orgId]);
});

m.route({ method: 'post', path: '/agreements/:hpaId/sign/start', summary: 'Send the signing code', access: ADMIN }, async ({ auth, params }) => {
  const orgId = requireOrg(auth);
  const h = await one(`select id from host_placement_agreements where id = $1 and org_id = $2`, [params.hpaId, orgId]);
  if (!h) throw notFound('Agreement');
  return issueOtp({ mobile: auth.mobile, purpose: 'sign_hpa', userId: auth.userId, refId: params.hpaId });
});

m.route({ method: 'post', path: '/agreements/:hpaId/sign', summary: 'Sign the HPA with the SMS code', access: ADMIN, body: z.object({ code: z.string().length(6) }) },
  async ({ auth, params, body, ip }) => {
    const orgId = requireOrg(auth);
    return tx(async (db) => {
      const h = await one(`select id from host_placement_agreements where id = $1 and org_id = $2`, [params.hpaId, orgId], db);
      if (!h) throw notFound('Agreement');
      await verifyOtp({ mobile: auth.mobile, purpose: 'sign_hpa', code: body.code, refId: params.hpaId }, db);
      return signDocument('hpa', params.hpaId, { userId: auth.userId, name: auth.fullName, ip }, db);
    });
  });

// ---------------------------------------------------------------------------
// Workforce oversight (FR-EMP-30..35)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/roster', summary: 'Current apprentices', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  return query(
    `select pl.id, pl.status, pl.role_title as "roleTitle", pl.start_date as "startDate", pl.planned_end_date as "plannedEndDate",
            p.full_name as name, s.full_name as supervisor, pl.supervisor_user_id as "supervisorId",
            (select min(due_date) from checkins c where c.placement_id = pl.id and c.completed_at is null) as "nextCheckin",
            (select json_build_object('period', a.period, 'confirmedAt', a.confirmed_at) from attendance a where a.placement_id = pl.id order by a.period desc limit 1) as "lastAttendance"
       from placements pl join person_profiles p on p.id = pl.person_id left join users s on s.id = pl.supervisor_user_id
      where pl.org_id = $1 and pl.status in ('contracted','active','ending') order by p.full_name`, [orgId]);
});

m.route({ method: 'put', path: '/roster/:id/supervisor', summary: 'Assign a supervisor', access: ADMIN, body: z.object({ userId: z.string().uuid() }) },
  async ({ auth, params, body }) => {
    const orgId = requireOrg(auth);
    await ownPlacement(params.id, orgId);
    if (!(await one(`select 1 from user_roles where user_id = $1 and org_id = $2`, [body.userId, orgId]))) throw badRequest('That person is not a user of this host.');
    await query('update placements set supervisor_user_id = $2 where id = $1', [params.id, body.userId]);
    return { ok: true };
  });

/** Attendance by exception: scheduled days are pre-filled; supervisors mark absences only (FR-EMP-31). */
m.route({ method: 'get', path: '/attendance', summary: 'Attendance sheet for a month', access: PORTAL, query: z.object({ period: zPeriod.optional() }) },
  async ({ auth, query: q }) => {
    const orgId = requireOrg(auth);
    const period = q.period ?? todayBT().slice(0, 7);
    const { start, end } = periodBounds(period);
    const cal = await getCalendar();
    const rows = await query(
      `select pl.id as "placementId", p.full_name as name, pl.role_title as "roleTitle", pl.start_date as "startDate", pl.actual_end_date as "endDate",
              a.absence_dates as "absenceDates", a.paid_leave_days as "paidLeaveDays", a.confirmed_at as "confirmedAt", a.defaulted
         from placements pl join person_profiles p on p.id = pl.person_id
         left join attendance a on a.placement_id = pl.id and a.period = $2
        where pl.org_id = $1 and pl.start_date <= $4 and coalesce(pl.actual_end_date, $4) >= $3 and pl.status in ('active','ending','ended','converted')
        order by p.full_name`, [orgId, period, start, end]);
    return {
      period,
      rows: rows.map((r) => ({ ...r, scheduledDays: scheduledDaysInPeriod(period, cal, r.startDate, r.endDate ?? undefined), absenceDates: r.absenceDates ?? [], paidLeaveDays: r.paidLeaveDays ?? 0 })),
    };
  });

m.route({ method: 'put', path: '/attendance', summary: 'Confirm attendance for a month', access: PORTAL,
  body: z.object({ period: zPeriod, entries: z.array(z.object({ placementId: z.string().uuid(), absenceDates: z.array(zDate).default([]), paidLeaveDays: z.number().int().min(0).default(0) })).min(1) }) },
async ({ auth, body, ip }) => {
  const orgId = requireOrg(auth);
  const cal = await getCalendar();
  const { start, end } = periodBounds(body.period);
  return tx(async (db) => {
    const locked = await one(`select status from payroll_runs where period = $1 and status in ('approved','paid','closed')`, [body.period], db);
    if (locked) throw ruleViolation('Payroll for this month is already approved. Contact BTBG to correct attendance in the next run.');
    for (const e of body.entries) {
      const pl = await one(`select start_date, actual_end_date from placements where id = $1 and org_id = $2`, [e.placementId, orgId], db);
      if (!pl) throw notFound('Apprentice');
      const bad = e.absenceDates.find((d) => d < start || d > end);
      if (bad) throw badRequest(`Absence date ${bad} is outside ${body.period}.`);
      const scheduled = scheduledDaysInPeriod(body.period, cal, pl.start_date, pl.actual_end_date ?? undefined);
      const absences = new Set(e.absenceDates).size;
      if (absences + e.paidLeaveDays > scheduled) throw badRequest('Absences and leave cannot be more than the scheduled days.');
      const worked = scheduled - absences - e.paidLeaveDays;
      await db.query(
        `insert into attendance (placement_id, period, scheduled_days, absence_dates, paid_leave_days, days_worked, confirmed_by, confirmed_at, defaulted)
         values ($1,$2,$3,$4,$5,$6,$7,now(),false)
         on conflict (placement_id, period) do update set scheduled_days = excluded.scheduled_days, absence_dates = excluded.absence_dates,
           paid_leave_days = excluded.paid_leave_days, days_worked = excluded.days_worked, confirmed_by = excluded.confirmed_by, confirmed_at = now(), defaulted = false`,
        [e.placementId, body.period, scheduled, [...new Set(e.absenceDates)], e.paidLeaveDays, worked, auth.userId]);
    }
    await audit({ actorId: auth.userId, action: 'host.attendance_confirmed', entityType: 'organisation', entityId: orgId, ip, details: { period: body.period, count: body.entries.length } }, db);
    return { ok: true };
  });
});

m.route({ method: 'post', path: '/roster/:id/notes', summary: 'Performance note and indicators', access: PORTAL,
  body: z.object({ note: z.string().max(1000).optional(), punctuality: z.number().int().min(1).max(5), skills: z.number().int().min(1).max(5),
    attitude: z.number().int().min(1).max(5), teamwork: z.number().int().min(1).max(5), customerCare: z.number().int().min(1).max(5) }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  await ownPlacement(params.id, orgId);
  return one(`insert into performance_notes (placement_id, author_id, note, punctuality, skills, attitude, teamwork, customer_care) values ($1,$2,$3,$4,$5,$6,$7,$8) returning id`,
    [params.id, auth.userId, body.note ?? null, body.punctuality, body.skills, body.attitude, body.teamwork, body.customerCare]);
});

m.route({ method: 'post', path: '/roster/:id/requests', summary: 'Request a conversation, warning, move, end or conversion', access: PORTAL, body: requestBody },
  async ({ auth, params, body }) => {
    const orgId = requireOrg(auth);
    await ownPlacement(params.id, orgId);
    if (body.kind === 'conversion' && auth.role !== 'host_owner') throw forbidden('Only a Host Owner can request a conversion.');
    return tx((db) => createPlacementRequest(params.id, 'host', body, auth.userId, db));
  });

m.route({ method: 'get', path: '/checkins', summary: 'Host check-ins due', access: PORTAL }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  return query(
    `select c.id, c.day, c.due_date as "dueDate", c.completed_at as "completedAt", c.risk_rating as "riskRating", p.full_name as apprentice, pl.id as "placementId"
       from checkins c join placements pl on pl.id = c.placement_id join person_profiles p on p.id = pl.person_id
      where pl.org_id = $1 and c.party = 'host' order by c.completed_at nulls first, c.due_date`, [orgId]);
});

const ratingCriteria = z.object({ punctuality: z.number().int().min(1).max(5), skills: z.number().int().min(1).max(5), attitude: z.number().int().min(1).max(5),
  teamwork: z.number().int().min(1).max(5), customerCare: z.number().int().min(1).max(5) });

m.route({ method: 'post', path: '/checkins/:id', summary: 'Complete the host check-in and rate the apprentice (FR-EMP-40)', access: PORTAL,
  body: z.object({
    attendance: z.number().int().min(1).max(5), performance: z.number().int().min(1).max(5), wellbeing: z.number().int().min(1).max(5),
    concerns: z.string().max(1000).optional(), criteria: ratingCriteria, comment: z.string().max(1000).optional(),
  }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  return tx(async (db) => {
    const c = await one(`select c.*, pl.org_id, pl.person_id from checkins c join placements pl on pl.id = c.placement_id where c.id = $1 and c.party = 'host' for update of c`, [params.id], db);
    if (!c || c.org_id !== orgId) throw notFound('Check-in');
    if (c.completed_at) throw ruleViolation('This check-in is already complete.');
    const risk = autoRisk(body);
    await db.query(`update checkins set form_data = $2, risk_rating = $3, completed_at = now(), completed_by = $4 where id = $1`, [params.id, JSON.stringify(body), risk, auth.userId]);
    const stars = Math.round(Object.values(body.criteria).reduce((a, b) => a + b, 0) / 5);
    await db.query(
      `insert into ratings (placement_id, checkin_id, from_party, from_user_id, to_party, org_id, person_id, context, stars, criteria_scores, comment)
       values ($1,$2,'host',$3,'apprentice',$4,$5,'checkin',$6,$7,$8)`,
      [c.placement_id, params.id, auth.userId, orgId, c.person_id, stars, JSON.stringify(body.criteria), body.comment ?? null]);
    await onCheckinCompleted(params.id, auth.userId, db);
    return { ok: true, riskRating: risk };
  });
});

m.route({ method: 'post', path: '/roster/:id/rating', summary: 'Rate the apprentice at placement end', access: PORTAL,
  body: z.object({ criteria: ratingCriteria, comment: z.string().max(1000).optional() }) },
async ({ auth, params, body }) => {
  const orgId = requireOrg(auth);
  const pl = await ownPlacement(params.id, orgId);
  if (!['ending', 'ended', 'converted'].includes(pl.status) && pl.planned_end_date > addDays(todayBT(), 14)) throw ruleViolation('End-of-placement ratings open in the last two weeks of the placement.');
  const stars = Math.round(Object.values(body.criteria).reduce((a, b) => a + b, 0) / 5);
  return one(`insert into ratings (placement_id, from_party, from_user_id, to_party, org_id, person_id, context, stars, criteria_scores, comment)
              values ($1,'host',$2,'apprentice',$3,$4,'placement_end',$5,$6,$7) returning id`,
    [params.id, auth.userId, orgId, pl.person_id, stars, JSON.stringify(body.criteria), body.comment ?? null]);
});

m.route({ method: 'post', path: '/rate-btbg', summary: 'Rate BTBG service quarterly or after a placement (FR-EMP-41)', access: PORTAL,
  body: z.object({ stars: z.number().int().min(1).max(5), context: z.enum(['quarterly', 'placement_end']), placementId: z.string().uuid().optional(),
    criteria: z.object({ candidateQuality: z.number().int().min(1).max(5), responsiveness: z.number().int().min(1).max(5), billingClarity: z.number().int().min(1).max(5) }).partial().default({}),
    comment: z.string().max(1000).optional() }) },
async ({ auth, body }) => {
  const orgId = requireOrg(auth);
  if (body.placementId) await ownPlacement(body.placementId, orgId);
  return one(`insert into ratings (placement_id, from_party, from_user_id, to_party, org_id, context, stars, criteria_scores, comment)
              values ($1,'host',$2,'btbg',$3,$4,$5,$6,$7) returning id`,
    [body.placementId ?? null, auth.userId, orgId, body.context, body.stars, JSON.stringify(body.criteria), body.comment ?? null]);
});

// ---------------------------------------------------------------------------
// Invoices (FR-EMP-42) and reports (FR-EMP-35, FR-RPT-02)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/invoices', summary: 'Invoices and payment history', access: ADMIN }, async ({ auth }) => {
  const orgId = requireOrg(auth);
  const [invoices, payments] = await Promise.all([
    query(`select id, number, period, issue_date as "issueDate", due_date as "dueDate", total, amount_paid as "amountPaid", total - amount_paid as balance, status
             from invoices where org_id = $1 and status <> 'draft' order by period desc`, [orgId]),
    query(`select id, amount, method, reference, received_on as "receivedOn" from payments where org_id = $1 order by received_on desc`, [orgId]),
  ]);
  return { invoices, payments };
});

m.route({ method: 'get', path: '/invoices/:id', summary: 'Invoice detail', access: ADMIN }, async ({ auth, params }) => {
  const orgId = requireOrg(auth);
  const inv = await one(`select * from invoices where id = $1 and org_id = $2 and status <> 'draft'`, [params.id, orgId]);
  if (!inv) throw notFound('Invoice');
  const lines = await query(`select line_type as "type", description, amount from invoice_lines where invoice_id = $1 order by line_type`, [params.id]);
  return { ...inv, lines };
});

m.route({ method: 'get', path: '/report', summary: 'Host report: vacancy ageing, performance, attendance and cost', access: PORTAL,
  query: z.object({ from: zDate.optional(), to: zDate.optional() }) },
async ({ auth, query: q }) => hostReport(auth, q.from, q.to));

export async function hostReport(auth: AuthContext | { orgId: string }, from?: string, to?: string) {
  const orgId = 'role' in auth ? requireOrg(auth as AuthContext) : auth.orgId;
  const end = to ?? todayBT();
  const start = from ?? addDays(end, -90);
  const [vacancies, performance, attendance, cost] = await Promise.all([
    query(`select title, status, openings, filled, greatest(0, current_date - opened_at::date) as "daysOpen" from vacancies where org_id = $1 and status in ('open','paused','filled') order by opened_at`, [orgId]),
    query(`select p.full_name as apprentice, round(avg(n.punctuality),1) as punctuality, round(avg(n.skills),1) as skills, round(avg(n.attitude),1) as attitude,
                  round(avg(n.teamwork),1) as teamwork, round(avg(n.customer_care),1) as "customerCare", count(n.*)::int as notes
             from placements pl join person_profiles p on p.id = pl.person_id left join performance_notes n on n.placement_id = pl.id and n.created_at::date between $2 and $3
            where pl.org_id = $1 and pl.status in ('active','ending','ended','converted') group by p.full_name order by p.full_name`, [orgId, start, end]),
    query(`select a.period, sum(a.scheduled_days)::int as scheduled, sum(a.days_worked)::numeric as worked, sum(cardinality(a.absence_dates))::int as absences
             from attendance a join placements pl on pl.id = a.placement_id where pl.org_id = $1 and a.period between $2 and $3 group by a.period order by a.period`,
      [orgId, start.slice(0, 7), end.slice(0, 7)]),
    query(`select i.period, sum(l.amount) filter (where l.line_type = 'wage') as wage, sum(l.amount) filter (where l.line_type = 'service') as service,
                  sum(l.amount) filter (where l.line_type = 'admin') as admin, sum(l.amount) filter (where l.line_type = 'credit') as credit, i.total
             from invoices i join invoice_lines l on l.invoice_id = i.id where i.org_id = $1 and i.period between $2 and $3 and i.status <> 'draft'
            group by i.id order by i.period`, [orgId, start.slice(0, 7), end.slice(0, 7)]),
  ]);
  return { from: start, to: end, vacancies, performance, attendance, cost };
}

// ---------------------------------------------------------------------------
// Staff-side host management (FR-ENT-01, 03, 04)
// ---------------------------------------------------------------------------
export const hostsAdmin = createModule('/hosts', 'Host management (staff)');

hostsAdmin.route({ method: 'get', path: '/', summary: 'Host employers', access: { any: ['hosts.view'] },
  query: zPage.extend({ verification: z.enum(['pending', 'verified', 'rejected']).optional(), status: z.enum(['active', 'suspended']).optional() }) },
async ({ query: q }) => {
  const rows = await query(
    `select o.id, o.name, o.trade_licence_no as "tradeLicenceNo", o.sector_code as "sectorCode", o.size_tier as "sizeTier", d.name as dzongkhag,
            o.verification_status as "verificationStatus", o.status, o.created_at as "createdAt",
            (select count(*)::int from placements pl where pl.org_id = o.id and pl.status in ('active','ending')) as "activeApprentices",
            (select count(*)::int from vacancies v where v.org_id = o.id and v.status = 'open') as "openVacancies",
            count(*) over() as total
       from organisations o left join dzongkhags d on d.id = o.dzongkhag_id
      where ($1::text is null or o.verification_status = $1) and ($2::text is null or o.status = $2)
        and ($3::text is null or o.name ilike '%' || $3 || '%' or o.trade_licence_no ilike '%' || $3 || '%')
      order by case o.verification_status when 'pending' then 0 else 1 end, o.name ${pageClause(q)}`,
    [q.verification ?? null, q.status ?? null, q.q ?? null]);
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
});

hostsAdmin.route({ method: 'get', path: '/:id', summary: 'Host detail with verification history', access: { any: ['hosts.view'] } }, async ({ params }) => {
  const o = await one(`select o.*, d.name as dzongkhag, g.name as gewog from organisations o left join dzongkhags d on d.id = o.dzongkhag_id left join gewogs g on g.id = o.gewog_id where o.id = $1`, [params.id]);
  if (!o) throw notFound('Host');
  const [docs, decisions, users, changes, placements, rating] = await Promise.all([
    query(`select id, kind, file_name as "fileName", created_at as "createdAt" from org_documents where org_id = $1`, [params.id]),
    query(`select v.item, v.decision, v.reason, v.created_at as "at", u.full_name as "by" from verification_decisions v left join users u on u.id = v.decided_by
            where v.entity_type = 'organisation' and v.entity_id = $1 order by v.created_at desc`, [params.id]),
    query(`select u.id, u.full_name as "fullName", u.mobile, ur.role_code as role from user_roles ur join users u on u.id = ur.user_id where ur.org_id = $1`, [params.id]),
    query(`select h.changes, h.created_at as "at", u.full_name as "by" from change_history h left join users u on u.id = h.changed_by where h.entity_type = 'organisation' and h.entity_id = $1 order by h.id desc limit 30`, [params.id]),
    query(`select pl.id, pl.status, pl.role_title as "roleTitle", p.full_name as apprentice, pl.start_date as "startDate" from placements pl join person_profiles p on p.id = pl.person_id where pl.org_id = $1 order by pl.created_at desc`, [params.id]),
    one(`select count(*)::int as n, round(avg(stars),1) as avg from ratings where org_id = $1 and to_party = 'host'`, [params.id]),
  ]);
  const { owner_cid_enc, ...rest } = o;
  return { ...rest, ownerCidOnFile: Boolean(owner_cid_enc), documents: docs, decisions, users, changes, placements, apprenticeRating: rating };
});

hostsAdmin.route({ method: 'post', path: '/:id/verify', summary: 'Verify a host: trade licence, address and owner identity', access: { any: ['hosts.verify'] },
  body: z.object({ decision: z.enum(['verified', 'pending', 'rejected']), checks: z.object({ tradeLicence: z.boolean(), address: z.boolean(), ownerIdentity: z.boolean() }), reason: z.string().optional() }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    if (body.decision === 'verified' && !(body.checks.tradeLicence && body.checks.address && body.checks.ownerIdentity)) {
      throw ruleViolation('Check the trade licence, address and owner identity before verifying.');
    }
    const o = await one('select id, name from organisations where id = $1', [params.id], db);
    if (!o) throw notFound('Host');
    await db.query(`update organisations set verification_status = $2, verified_by = $3, verified_at = case when $2 = 'verified' then now() end where id = $1`, [params.id, body.decision, auth.userId]);
    for (const [item, ok] of Object.entries(body.checks)) {
      await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('organisation', $1, $2, $3, $4, $5)`,
        [params.id, item, ok ? 'verified' : 'pending', body.reason ?? null, auth.userId]);
    }
    await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('organisation', $1, 'overall', $2, $3, $4)`,
      [params.id, body.decision, body.reason ?? null, auth.userId]);
    await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where dedupe_key = $1`, [`verify_host:${params.id}`, auth.userId]);
    const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code = 'host_owner'`, [params.id], db);
    for (const ow of owners) {
      await notify({ userId: ow.user_id, code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Verification update', body: body.decision === 'verified' ? `${o.name} is now Verified by BTBG. Your vacancies can go live after review.` : `BTBG could not verify ${o.name} yet. ${body.reason ?? ''}` } }, db);
    }
    await audit({ actorId: auth.userId, action: 'verification.host', entityType: 'organisation', entityId: params.id, ip, details: body }, db);
    return { ok: true };
  }),
);

hostsAdmin.route({ method: 'post', path: '/:id/status', summary: 'Suspend or reactivate a host; suspension triggers redeployment planning', access: { any: ['accounts.suspend'] },
  body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().min(5) }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const o = await one('select name from organisations where id = $1', [params.id], db);
    if (!o) throw notFound('Host');
    await db.query(`update organisations set status = $2, suspended_reason = $3 where id = $1`, [params.id, body.status, body.status === 'suspended' ? body.reason : null]);
    await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('organisation', $1, $2, $3, $4, $5)`,
      [params.id, `account_${body.status}`, body.status === 'active' ? 'verified' : 'rejected', body.reason, auth.userId]);
    let redeployTasks = 0;
    if (body.status === 'suspended') {
      await db.query(`update vacancies set status = 'paused' where org_id = $1 and status = 'open'`, [params.id]);
      const active = await query(`select pl.id, p.full_name from placements pl join person_profiles p on p.id = pl.person_id where pl.org_id = $1 and pl.status in ('active','ending','contracted','offered')`, [params.id], db);
      for (const a of active) {
        if (await createTask({ kind: 'redeploy_planning', title: `Plan redeployment: ${a.full_name} (host ${o.name} suspended)`, entityType: 'placement', entityId: a.id,
          assigneeRole: 'operations_manager', priority: 'urgent', dueAt: addDays(todayBT(), 1), dedupeKey: `redeploy_planning:${a.id}` }, db)) redeployTasks++;
      }
    }
    await audit({ actorId: auth.userId, action: `account.host_${body.status}`, entityType: 'organisation', entityId: params.id, ip, details: body }, db);
    return { ok: true, redeployTasks };
  }),
);
