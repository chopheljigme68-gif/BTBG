import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit, recordChanges } from '../../lib/audit.js';
import { blindIndex, encrypt } from '../../lib/crypto.js';
import { addDays, todayBT } from '../../lib/dates.js';
import { AppError, badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, zDate, zMobile } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { issueOtp, verifyOtp } from '../../lib/otp.js';
import { newKey, putFile, validateUpload } from '../../lib/storage.js';
import { createTask } from '../../lib/tasks.js';
import type { AuthContext } from '../../middleware/auth.js';
import { completeness } from '../candidates/service.js';
import { personForUser } from '../people/service.js';
import { autoRisk, onCheckinCompleted, signDocument } from '../placements/service.js';
import { createPlacementRequest } from '../placements/routes.js';
import { recommendVacancies } from '../vacancies/matching.js';
import { applicationOutcome } from '../vacancies/applications.js';

/** Job seeker, apprentice and alumni portal (SRS 3.5). */
const m = createModule('/me', 'Job seeker portal');
export default m;

const SEEKER = { any: ['seeker.portal'] };

async function me(auth: AuthContext) {
  const p = await personForUser(auth.userId);
  if (!p) throw new AppError(403, 'no_profile', 'Switch to your job seeker role to do this.');
  return p;
}

async function currentPlacement(personId: string) {
  return one(
    `select pl.*, o.name as host, o.address as host_address, s.full_name as supervisor, s.mobile as supervisor_mobile
       from placements pl join organisations o on o.id = pl.org_id left join users s on s.id = pl.supervisor_user_id
      where pl.person_id = $1 and pl.status in ('offered','contracted','active','ending') order by pl.created_at desc limit 1`, [personId]);
}

m.route({ method: 'get', path: '/dashboard', summary: 'Job seeker home', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const [score, recs, apps, placement, contract, payslip, interviews] = await Promise.all([
    completeness(p.id),
    recommendVacancies(p.id, 5),
    query(`select a.id, a.stage, v.title, o.name as host from applications a join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id
            where a.person_id = $1 order by a.updated_at desc limit 5`, [p.id]),
    currentPlacement(p.id),
    one(`select c.id, c.status, exists (select 1 from agreement_documents d where d.kind = 'employment_contract' and d.agreement_id = c.id and d.status = 'pending_signature') as "toSign"
           from employment_contracts c where c.person_id = $1 and c.status <> 'ended' order by c.created_at desc limit 1`, [p.id]),
    one(`select ps.net, r.period, r.pay_date as "payDate" from payslips ps join payroll_runs r on r.id = ps.run_id where ps.person_id = $1 and ps.published_at is not null order by r.period desc limit 1`, [p.id]),
    query(`select i.scheduled_at as "scheduledAt", i.location, v.title, o.name as host from interviews i join applications a on a.id = i.application_id
             join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id where a.person_id = $1 and i.status = 'scheduled' and i.scheduled_at > now() order by i.scheduled_at`, [p.id]),
  ]);
  const nextCheckin = placement
    ? await one(`select id, day, due_date as "dueDate" from checkins where placement_id = $1 and party = 'apprentice' and completed_at is null order by due_date limit 1`, [placement.id])
    : null;
  const bench = await one(`select b.deadline from bench_periods b join employment_contracts c on c.id = b.contract_id where c.person_id = $1 and b.ended_at is null`, [p.id]);
  return {
    person: p, completeness: score, recommendations: recs, applications: apps, interviews,
    placement: placement && { id: placement.id, status: placement.status, host: placement.host, roleTitle: placement.role_title, startDate: placement.start_date, plannedEndDate: placement.planned_end_date },
    contract, nextCheckin, latestPayslip: payslip, bench,
  };
});

// ---------------------------------------------------------------------------
// Profile and portfolio (FR-EE-01..06). PATCH saves partial changes so forms
// can autosave field by field on slow connections.
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/profile', summary: 'My profile', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const [row, skills, credentials, work, media, score] = await Promise.all([
    one(`select full_name as "fullName", mobile, email, cid_last4 as "cidLast4", date_of_birth as "dateOfBirth", gender, dzongkhag_id as "dzongkhagId", gewog_id as "gewogId",
                village, alt_contact_name as "altContactName", alt_contact_mobile as "altContactMobile", alt_contact_relation as "altContactRelation",
                expected_wage as "expectedWage", available_from as "availableFrom", employment_type as "employmentType", preferred_roles as "preferredRoles",
                preferred_dzongkhags as "preferredDzongkhags", languages, willing_to_relocate as "willingToRelocate", bio, stage, lifecycle,
                bank_name as "bankName", bank_account_last4 as "bankAccountLast4", bank_account_holder as "bankAccountHolder", identity_status as "identityStatus",
                updated_at as "updatedAt"
           from person_profiles where id = $1`, [p.id]),
    query(`select s.id, s.name, ps.level from person_skills ps join skills s on s.id = ps.skill_id where ps.person_id = $1 order by s.name`, [p.id]),
    query(`select id, type, institution, qualification, year, file_path is not null as "hasFile", verification_status as "verificationStatus" from person_credentials where person_id = $1 order by year desc nulls last`, [p.id]),
    query(`select id, employer, role, start_date as "startDate", end_date as "endDate", description from work_history where person_id = $1 order by start_date desc nulls last`, [p.id]),
    query(`select id, kind, caption, duration_seconds as "durationSeconds", file_path as "filePath" from portfolio_media where person_id = $1 order by created_at desc`, [p.id]),
    completeness(p.id),
  ]);
  return { ...row, skills, credentials, workHistory: work, portfolio: media, completeness: score };
});

const profilePatch = z.object({
  fullName: z.string().trim().min(2).max(120), email: z.string().email().nullable(), cid: z.string().regex(/^\d{11}$/, 'CID must be 11 digits'),
  dateOfBirth: zDate.nullable(), gender: z.enum(['female', 'male', 'other', 'prefer_not']).nullable(),
  dzongkhagId: z.number().int().nullable(), gewogId: z.number().int().nullable(), village: z.string().max(120).nullable(),
  altContactName: z.string().max(120).nullable(), altContactMobile: zMobile.nullable(), altContactRelation: z.string().max(60).nullable(),
  expectedWage: z.number().min(0).max(1_000_000).nullable(), availableFrom: zDate.nullable(), employmentType: z.enum(['full_time', 'freelance']),
  preferredRoles: z.array(z.string().max(60)).max(10), preferredDzongkhags: z.array(z.number().int()).max(20), languages: z.array(z.string().max(30)).max(10),
  willingToRelocate: z.boolean().nullable(), bio: z.string().max(1000).nullable(),
}).partial();

const COL: Record<string, string> = {
  fullName: 'full_name', email: 'email', dateOfBirth: 'date_of_birth', gender: 'gender', dzongkhagId: 'dzongkhag_id', gewogId: 'gewog_id', village: 'village',
  altContactName: 'alt_contact_name', altContactMobile: 'alt_contact_mobile', altContactRelation: 'alt_contact_relation', expectedWage: 'expected_wage',
  availableFrom: 'available_from', employmentType: 'employment_type', preferredRoles: 'preferred_roles', preferredDzongkhags: 'preferred_dzongkhags',
  languages: 'languages', willingToRelocate: 'willing_to_relocate', bio: 'bio',
};

m.route({ method: 'patch', path: '/profile', summary: 'Save profile changes (autosave)', access: SEEKER, body: profilePatch }, async ({ auth, body }) => {
  const p = await me(auth);
  return tx(async (db) => {
    const before = await one('select * from person_profiles where id = $1 for update', [p.id], db);
    const sets: string[] = [];
    const vals: unknown[] = [p.id];
    const b: Record<string, unknown> = {};
    const a: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || k === 'cid') continue;
      vals.push(v);
      sets.push(`${COL[k]} = $${vals.length}`);
      b[k] = before[COL[k]];
      a[k] = v;
    }
    if (body.cid) {
      if (before.identity_status === 'verified' && before.cid_last4 !== body.cid.slice(-4)) throw ruleViolation('Your CID is verified. Contact BTBG to change it.');
      const dup = await one('select 1 from person_profiles where cid_hash = $1 and id <> $2', [blindIndex(body.cid), p.id], db);
      if (dup) throw badRequest('This CID is already registered to another account. Contact BTBG for help.');
      vals.push(encrypt(body.cid), blindIndex(body.cid), body.cid.slice(-4));
      sets.push(`cid_enc = $${vals.length - 2}`, `cid_hash = $${vals.length - 1}`, `cid_last4 = $${vals.length}`);
      a.cid = `…${body.cid.slice(-4)}`;
      b.cid = before.cid_last4 ? `…${before.cid_last4}` : null;
    }
    if (sets.length) await db.query(`update person_profiles set ${sets.join(', ')} where id = $1`, vals);
    if (body.fullName) await db.query('update users set full_name = $2 where id = $1', [auth.userId, body.fullName]);
    await recordChanges('person', p.id, auth.userId, b, a, db);
    return { ok: true, savedAt: new Date().toISOString() };
  });
});

m.route({ method: 'put', path: '/skills', summary: 'Replace my skills', access: SEEKER,
  body: z.object({ skills: z.array(z.object({ skillId: z.number().int(), level: z.number().int().min(1).max(5) })).max(30) }) },
async ({ auth, body }) => {
  const p = await me(auth);
  await tx(async (db) => {
    await db.query('delete from person_skills where person_id = $1', [p.id]);
    for (const s of body.skills) await db.query('insert into person_skills (person_id, skill_id, level) values ($1, $2, $3) on conflict do nothing', [p.id, s.skillId, s.level]);
  });
  return { ok: true };
});

m.route({ method: 'post', path: '/credentials', summary: 'Add education or a certificate with an optional file', access: SEEKER, upload: true,
  body: z.object({ type: z.enum(['school', 'tvet', 'university', 'certificate']), institution: z.string().min(2), qualification: z.string().optional(), year: z.number().int().min(1970).max(2100).optional() }) },
async ({ auth, body, file }) => {
  const p = await me(auth);
  let path: string | null = null;
  if (file) {
    const mime = validateUpload('document', file);
    path = await putFile(newKey(`people/${p.id}/credentials`, file.originalname), file.buffer, mime);
  }
  return one(`insert into person_credentials (person_id, type, institution, qualification, year, file_path) values ($1,$2,$3,$4,$5,$6) returning id`,
    [p.id, body.type, body.institution, body.qualification ?? null, body.year ?? null, path]);
});

m.route({ method: 'delete', path: '/credentials/:id', summary: 'Remove an unverified credential', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  const r = await query(`delete from person_credentials where id = $1 and person_id = $2 and verification_status <> 'verified' returning id`, [params.id, p.id]);
  if (!r.length) throw ruleViolation('Verified credentials cannot be removed. Contact BTBG.');
  return { ok: true };
});

m.route({ method: 'post', path: '/work', summary: 'Add work history', access: SEEKER,
  body: z.object({ employer: z.string().min(2), role: z.string().min(2), startDate: zDate.optional(), endDate: zDate.optional(), description: z.string().max(500).optional() }) },
async ({ auth, body }) => {
  const p = await me(auth);
  return one(`insert into work_history (person_id, employer, role, start_date, end_date, description) values ($1,$2,$3,$4,$5,$6) returning id`,
    [p.id, body.employer, body.role, body.startDate ?? null, body.endDate ?? null, body.description ?? null]);
});

m.route({ method: 'delete', path: '/work/:id', summary: 'Remove work history', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  await query('delete from work_history where id = $1 and person_id = $2', [params.id, p.id]);
  return { ok: true };
});

m.route({ method: 'post', path: '/portfolio', summary: 'Upload a photo or a video up to 60 seconds', access: SEEKER, upload: true,
  body: z.object({ caption: z.string().max(200).optional(), durationSeconds: z.number().int().min(1).max(60).optional() }) },
async ({ auth, body, file }) => {
  const p = await me(auth);
  if (!file) throw badRequest('Attach a photo or video.');
  const isVideo = file.mimetype.startsWith('video/');
  if (isVideo && !body.durationSeconds) throw badRequest('Videos must be 60 seconds or shorter.');
  if (isVideo && file.size > 60 * 1024 * 1024) throw badRequest('Portfolio videos can be at most 60 MB.');
  const mime = validateUpload(isVideo ? 'video' : 'image', file);
  const count = await one<{ n: number }>('select count(*)::int as n from portfolio_media where person_id = $1', [p.id]);
  if ((count?.n ?? 0) >= 12) throw badRequest('You can keep up to 12 portfolio items.');
  const path = await putFile(newKey(`people/${p.id}/portfolio`, file.originalname), file.buffer, mime);
  return one(`insert into portfolio_media (person_id, kind, file_path, caption, duration_seconds) values ($1,$2,$3,$4,$5) returning id`,
    [p.id, isVideo ? 'video' : 'photo', path, body.caption ?? null, body.durationSeconds ?? null]);
});

m.route({ method: 'delete', path: '/portfolio/:id', summary: 'Remove a portfolio item', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  await query('delete from portfolio_media where id = $1 and person_id = $2', [params.id, p.id]);
  return { ok: true };
});

m.route({ method: 'put', path: '/bank', summary: 'Bank account for salary (encrypted)', access: SEEKER,
  body: z.object({ bankName: z.enum(['BoB', 'BNB', 'BDBL', 'T-Bank', 'DPNB']), accountNumber: z.string().regex(/^\d{6,20}$/, 'enter digits only'), accountHolder: z.string().min(2) }) },
async ({ auth, body, ip }) => {
  const p = await me(auth);
  await query(`update person_profiles set bank_name = $2, bank_account_enc = $3, bank_account_last4 = $4, bank_account_holder = $5 where id = $1`,
    [p.id, body.bankName, encrypt(body.accountNumber), body.accountNumber.slice(-4), body.accountHolder]);
  await audit({ actorId: auth.userId, action: 'person.bank_updated', entityType: 'person', entityId: p.id, ip });
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Jobs: recommendations, applications, saved, alerts (FR-EE-10..16)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/recommendations', summary: 'Recommended vacancies', access: SEEKER }, async ({ auth }) => recommendVacancies((await me(auth)).id, 20));

m.route({ method: 'post', path: '/applications', summary: 'Apply with one tap', access: SEEKER, body: z.object({ vacancyId: z.string().uuid() }) },
  async ({ auth, body }) => {
    const p = await me(auth);
    return tx(async (db) => {
      const v = await one(`select v.id, v.title, v.status from vacancies v where v.id = $1`, [body.vacancyId], db);
      if (!v || v.status !== 'open') throw ruleViolation('This job is not open for applications.');
      const exists = await one(`select stage from applications where vacancy_id = $1 and person_id = $2`, [body.vacancyId, p.id], db);
      if (exists && exists.stage !== 'withdrawn') throw ruleViolation('You already applied for this job.');
      const a = await one(
        `insert into applications (vacancy_id, person_id, stage, source) values ($1, $2, 'applied', 'applied')
         on conflict (vacancy_id, person_id) do update set stage = 'applied', applied_at = now(), outcome_reason = null returning id`,
        [body.vacancyId, p.id], db);
      // Workflow 2 step 2: the candidate moves to Contacted and their field officer follows up within 3 working days.
      const person = await one(`select stage, assigned_officer_id, full_name from person_profiles where id = $1`, [p.id], db);
      if (person.stage === 'registered') {
        await db.query(`update person_profiles set stage = 'contacted' where id = $1`, [p.id]);
        await db.query(`insert into candidate_stage_history (person_id, from_stage, to_stage, reason, changed_by) values ($1, 'registered', 'contacted', $2, $3)`, [p.id, `Applied for ${v.title}`, auth.userId]);
      }
      if (['registered', 'contacted', 'withdrawn'].includes(person.stage)) {
        await createTask({ kind: 'contact_applicant', title: `Contact applicant ${person.full_name} and book screening`, description: `Applied for ${v.title}`,
          entityType: 'person', entityId: p.id, assigneeId: person.assigned_officer_id, assigneeRole: 'field_officer', dueAt: addDays(todayBT(), 4),
          dedupeKey: `contact_applicant:${p.id}:${body.vacancyId}` }, db);
      }
      await notify({ userId: auth.userId, code: 'application_received', vars: { title: v.title }, channels: ['in_app'] }, db);
      return { id: a!.id };
    });
  });

m.route({ method: 'get', path: '/applications', summary: 'Track my applications', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  return query(
    `select a.id, a.stage, a.applied_at as "appliedAt", a.updated_at as "updatedAt", a.outcome_reason as "outcomeReason", v.id as "vacancyId", v.title, v.share_slug as slug,
            v.wage, o.name as host,
            (select json_build_object('scheduledAt', i.scheduled_at, 'location', i.location, 'status', i.status) from interviews i where i.application_id = a.id order by i.created_at desc limit 1) as interview
       from applications a join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id where a.person_id = $1 order by a.applied_at desc`, [p.id]);
});

m.route({ method: 'post', path: '/applications/:id/withdraw', summary: 'Withdraw an application', access: SEEKER, body: z.object({ reason: z.string().min(2) }) },
  async ({ auth, params, body }) => {
    const p = await me(auth);
    return tx(async (db) => {
      const a = await one('select stage from applications where id = $1 and person_id = $2', [params.id, p.id], db);
      if (!a) throw notFound('Application');
      if (['hired', 'offered'].includes(a.stage)) throw ruleViolation('Talk to BTBG to withdraw after an offer.');
      await applicationOutcome(params.id, 'withdrawn', body.reason, db);
      return { ok: true };
    });
  });

m.route({ method: 'get', path: '/saved', summary: 'Saved vacancies', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  return query(`select v.id, v.title, v.wage, v.share_slug as slug, v.status, o.name as host from saved_vacancies s join vacancies v on v.id = s.vacancy_id
                  join organisations o on o.id = v.org_id where s.person_id = $1 order by s.created_at desc`, [p.id]);
});
m.route({ method: 'post', path: '/saved/:vacancyId', summary: 'Save a vacancy', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  await query('insert into saved_vacancies (person_id, vacancy_id) values ($1, $2) on conflict do nothing', [p.id, params.vacancyId]);
  return { ok: true };
});
m.route({ method: 'delete', path: '/saved/:vacancyId', summary: 'Unsave a vacancy', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  await query('delete from saved_vacancies where person_id = $1 and vacancy_id = $2', [p.id, params.vacancyId]);
  return { ok: true };
});

const alertCriteria = z.object({ q: z.string().max(60).optional(), sector: z.string().optional(), dzongkhagId: z.number().int().optional(), wageMin: z.number().optional(),
  accommodation: z.boolean().optional(), firstTime: z.boolean().optional() });
m.route({ method: 'get', path: '/alerts', summary: 'My job alerts', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  return query('select id, criteria, last_sent_at as "lastSentAt", created_at as "createdAt" from job_alerts where person_id = $1', [p.id]);
});
m.route({ method: 'post', path: '/alerts', summary: 'Create a job alert', access: SEEKER, body: alertCriteria }, async ({ auth, body }) => {
  const p = await me(auth);
  return one('insert into job_alerts (person_id, criteria, last_sent_at) values ($1, $2, now()) returning id', [p.id, JSON.stringify(body)]);
});
m.route({ method: 'delete', path: '/alerts/:id', summary: 'Delete a job alert', access: SEEKER }, async ({ auth, params }) => {
  const p = await me(auth);
  await query('delete from job_alerts where id = $1 and person_id = $2', [params.id, p.id]);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Apprentice functions (FR-EE-20..25, 30..31)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/contract', summary: 'My employment contract and versions', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const c = await one(`select * from employment_contracts where person_id = $1 order by (status <> 'ended') desc, created_at desc limit 1`, [p.id]);
  if (!c) return null;
  const docs = await query(
    `select id, version, status, body_text as body, signed_at as "signedAt", file_path is not null as "hasPdf" from agreement_documents
      where kind = 'employment_contract' and agreement_id = $1 order by version desc`, [c.id]);
  return {
    id: c.id, status: c.status, wage: c.wage, hoursPerWeek: c.hours_per_week, daysPerWeek: c.days_per_week, restDaysPerWeek: c.rest_days_per_week,
    leaveDaysPerYear: c.leave_days_per_year, startDate: c.start_date, endDate: c.end_date, documents: docs,
    pending: docs.find((d) => d.status === 'pending_signature') ?? null,
  };
});

m.route({ method: 'post', path: '/contract/sign/start', summary: 'Send the signing code', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const c = await one(`select id from employment_contracts where person_id = $1 and status <> 'ended' order by created_at desc limit 1`, [p.id]);
  if (!c) throw notFound('Contract');
  return issueOtp({ mobile: auth.mobile, purpose: 'sign_contract', userId: auth.userId, refId: c.id });
});

m.route({ method: 'post', path: '/contract/sign', summary: 'Sign the contract with the SMS code', access: SEEKER, body: z.object({ code: z.string().length(6), agree: z.literal(true) }) },
  async ({ auth, body, ip }) => {
    const p = await me(auth);
    return tx(async (db) => {
      const c = await one(`select id from employment_contracts where person_id = $1 and status <> 'ended' order by created_at desc limit 1`, [p.id], db);
      if (!c) throw notFound('Contract');
      await verifyOtp({ mobile: auth.mobile, purpose: 'sign_contract', code: body.code, refId: c.id }, db);
      return signDocument('employment_contract', c.id, { userId: auth.userId, name: p.full_name, ip }, db);
    });
  });

m.route({ method: 'get', path: '/placement', summary: 'Current host, supervisor, schedule and next check-in', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const pl = await currentPlacement(p.id);
  const bench = await one(`select b.start_date as "startDate", b.deadline, b.pay_rule as "payRule" from bench_periods b join employment_contracts c on c.id = b.contract_id
                             where c.person_id = $1 and b.ended_at is null`, [p.id]);
  if (!pl) return { placement: null, bench };
  const c = await one('select hours_per_week, days_per_week, rest_days_per_week from employment_contracts where id = $1', [pl.contract_id]);
  const checkins = await query(`select id, day, due_date as "dueDate", completed_at as "completedAt" from checkins where placement_id = $1 and party = 'apprentice' order by day`, [pl.id]);
  const requests = await query(`select kind, status, created_at as "createdAt" from placement_requests where placement_id = $1 and requester_party = 'apprentice' order by created_at desc`, [pl.id]);
  return {
    placement: {
      id: pl.id, status: pl.status, host: pl.host, hostAddress: pl.host_address, roleTitle: pl.role_title, supervisor: pl.supervisor, supervisorMobile: pl.supervisor_mobile,
      startDate: pl.start_date, plannedEndDate: pl.planned_end_date, schedule: c && { hoursPerWeek: c.hours_per_week, daysPerWeek: c.days_per_week, restDaysPerWeek: c.rest_days_per_week },
    },
    checkins, nextCheckin: checkins.find((x) => !x.completedAt) ?? null, requests, bench,
  };
});

m.route({ method: 'post', path: '/checkins/:id', summary: 'Complete my check-in on my phone (FR-EE-23) and rate my workplace (FR-EE-31)', access: SEEKER,
  body: z.object({
    attendance: z.number().int().min(1).max(5), performance: z.number().int().min(1).max(5), wellbeing: z.number().int().min(1).max(5),
    concerns: z.string().max(1000).optional(), wantsToLeave: z.boolean().default(false),
    hostRating: z.object({ stars: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }),
  }) },
async ({ auth, params, body }) => {
  const p = await me(auth);
  return tx(async (db) => {
    const c = await one(`select c.*, pl.org_id, pl.person_id from checkins c join placements pl on pl.id = c.placement_id where c.id = $1 and c.party = 'apprentice' for update of c`, [params.id], db);
    if (!c || c.person_id !== p.id) throw notFound('Check-in');
    if (c.completed_at) throw ruleViolation('This check-in is already complete.');
    const risk = autoRisk(body);
    const { hostRating, ...form } = body;
    await db.query(`update checkins set form_data = $2, risk_rating = $3, completed_at = now(), completed_by = $4 where id = $1`, [params.id, JSON.stringify(form), risk, auth.userId]);
    await db.query(`insert into ratings (placement_id, checkin_id, from_party, from_user_id, to_party, org_id, person_id, context, stars, comment)
                    values ($1,$2,'apprentice',$3,'host',$4,$5,'checkin',$6,$7)`,
      [c.placement_id, params.id, auth.userId, c.org_id, p.id, hostRating.stars, hostRating.comment ?? null]);
    await onCheckinCompleted(params.id, auth.userId, db);
    return { ok: true, riskRating: risk };
  });
});

m.route({ method: 'post', path: '/placement/move-request', summary: 'Ask BTBG to move me to another host (FR-EE-24)', access: SEEKER, body: z.object({ reason: z.string().min(5) }) },
  async ({ auth, body }) => {
    const p = await me(auth);
    const pl = await currentPlacement(p.id);
    if (!pl || !['active', 'ending'].includes(pl.status)) throw ruleViolation('You can ask for a move during an active placement.');
    return tx((db) => createPlacementRequest(pl.id, 'apprentice', { kind: 'move', reason: body.reason, reasonCode: 'apprentice_request' }, auth.userId, db));
  });

m.route({ method: 'post', path: '/placement/rating', summary: 'Rate my workplace at placement end', access: SEEKER,
  body: z.object({ placementId: z.string().uuid(), stars: z.number().int().min(1).max(5), comment: z.string().max(1000).optional() }) },
async ({ auth, body }) => {
  const p = await me(auth);
  const pl = await one(`select org_id from placements where id = $1 and person_id = $2`, [body.placementId, p.id]);
  if (!pl) throw notFound('Placement');
  return one(`insert into ratings (placement_id, from_party, from_user_id, to_party, org_id, person_id, context, stars, comment)
              values ($1,'apprentice',$2,'host',$3,$4,'placement_end',$5,$6) returning id`, [body.placementId, auth.userId, pl.org_id, p.id, body.stars, body.comment ?? null]);
});

m.route({ method: 'get', path: '/payslips', summary: 'Payslips and payment history', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  const slips = await query(
    `select ps.id, r.period, r.pay_date as "payDate", ps.gross, ps.total_deductions as deductions, ps.total_adjustments as adjustments, ps.net, ps.bank_status as "bankStatus",
            ps.days_worked as "daysWorked", ps.bench_days as "benchDays", ps.paid_leave_days as "paidLeaveDays", ps.scheduled_days as "scheduledDays"
       from payslips ps join payroll_runs r on r.id = ps.run_id where ps.person_id = $1 and ps.published_at is not null order by r.period desc`, [p.id]);
  for (const s of slips) s.lines = await query(`select kind, label, amount from payslip_lines where payslip_id = $1`, [s.id]);
  return slips;
});

m.route({ method: 'get', path: '/certificates', summary: 'My certificates with verification links', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  return query(`select id, kind, title, programme, outcome, verification_code as code, issued_at as "issuedAt" from certificates where person_id = $1 and revoked_at is null order by issued_at desc`, [p.id]);
});

m.route({ method: 'get', path: '/ratings', summary: 'Ratings and feedback from hosts (FR-EE-30)', access: SEEKER }, async ({ auth }) => {
  const p = await me(auth);
  return query(
    `select r.stars, r.criteria_scores as criteria, r.comment, r.context, r.created_at as "at", o.name as host
       from ratings r join organisations o on o.id = r.org_id where r.person_id = $1 and r.to_party = 'apprentice' order by r.created_at desc`, [p.id]);
});
