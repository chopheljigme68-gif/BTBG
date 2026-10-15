import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zPage } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { issueOtp, verifyOtp } from '../../lib/otp.js';
import { authenticate } from '../../middleware/auth.js';
import { personForUser } from '../people/service.js';
import { rankCandidatesForVacancy } from './matching.js';
import { saveVacancy, transitionVacancy, vacancyInput, VACANCY_STATUSES } from './service.js';
import { applicationOutcome } from './applications.js';

const m = createModule('/vacancies', 'Vacancies and matching');
export default m;

const STAFF = { any: ['vacancies.review', 'matching.manage', 'vacancies.manage_any'] };

// ---------------------------------------------------------------------------
// Public job search (FR-EE-10, 13; FR-EMP-16)
// ---------------------------------------------------------------------------
const publicSelect = `
  v.id, v.share_slug as slug, v.title, v.department, v.openings, v.openings - v.filled as "openPositions", v.wage, v.accommodation, v.meals,
  v.benefits, v.shift_pattern as "shiftPattern", v.hours_per_week as "hoursPerWeek", v.start_date as "startDate",
  v.first_time_friendly as "firstTimeFriendly", v.experience_required as "experienceRequired", v.is_seasonal as "isSeasonal",
  v.season_start as "seasonStart", v.season_end as "seasonEnd", v.location_text as "locationText", v.sector_code as "sectorCode",
  s.name as sector, d.name as dzongkhag, g.name as gewog, o.id as "hostId", o.name as host, o.star_rating as "hostStars",
  o.verification_status = 'verified' as "hostVerified", v.opened_at as "openedAt",
  greatest(0, current_date - v.opened_at::date) as "daysOpen", c.slug as "careerSlug", c.title as "careerTitle"`;

const publicFrom = `
  from vacancies v join organisations o on o.id = v.org_id join sectors s on s.code = v.sector_code
  left join dzongkhags d on d.id = v.dzongkhag_id left join gewogs g on g.id = v.gewog_id left join careers c on c.id = v.career_id`;

m.route(
  {
    method: 'get', path: '/public', summary: 'Search open vacancies', access: 'public',
    query: zPage.extend({
      sector: z.string().optional(), dzongkhagId: z.coerce.number().int().optional(), wageMin: z.coerce.number().optional(),
      wageMax: z.coerce.number().optional(), accommodation: z.enum(['true']).optional(), firstTime: z.enum(['true']).optional(),
      career: z.string().optional(), seasonal: z.enum(['true', 'false']).optional(),
    }),
  },
  async ({ query: q }) => {
    const rows = await query(
      `select ${publicSelect}, count(*) over() as total ${publicFrom}
        where v.status = 'open' and o.status = 'active'
          and ($1::text is null or v.title ilike '%' || $1 || '%' or v.description ilike '%' || $1 || '%' or o.name ilike '%' || $1 || '%' or v.department ilike '%' || $1 || '%')
          and ($2::text is null or v.sector_code = $2) and ($3::int is null or v.dzongkhag_id = $3)
          and ($4::numeric is null or v.wage >= $4) and ($5::numeric is null or v.wage <= $5)
          and ($6::boolean is null or v.accommodation) and ($7::boolean is null or v.first_time_friendly)
          and ($8::text is null or c.slug = $8) and ($9::boolean is null or v.is_seasonal = $9)
        order by v.opened_at desc ${pageClause(q)}`,
      [q.q ?? null, q.sector ?? null, q.dzongkhagId ?? null, q.wageMin ?? null, q.wageMax ?? null,
        q.accommodation ? true : null, q.firstTime ? true : null, q.career ?? null, q.seasonal ? q.seasonal === 'true' : null],
    );
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  },
);

m.route({ method: 'get', path: '/public/:slug', summary: 'Vacancy detail by share slug or id', access: 'optional' }, async ({ params, req }) => {
  const isId = /^[0-9a-f-]{36}$/.test(params.slug);
  const v = await one(
    `select ${publicSelect}, v.description, v.status, o.culture, o.values_text as "hostValues", o.photos as "hostPhotos"
       ${publicFrom} where ${isId ? 'v.id' : 'v.share_slug'} = $1 and v.status in ('open','paused','filled')`,
    [params.slug],
  );
  if (!v) throw notFound('Job');
  const [skills, rating] = await Promise.all([
    query('select s.name from vacancy_skills vs join skills s on s.id = vs.skill_id where vs.vacancy_id = $1', [v.id]),
    // FR-EE-32: average only, and only once at least 3 ratings exist.
    one(`select count(*)::int as n, round(avg(stars), 1) as avg from ratings where org_id = $1 and to_party = 'host' and from_party = 'apprentice'`, [v.hostId]),
  ]);
  const auth = await authenticate(req).catch(() => null);
  let mine = null;
  if (auth?.role === 'job_seeker') {
    const p = await personForUser(auth.userId);
    if (p) {
      const a = await one('select stage from applications where vacancy_id = $1 and person_id = $2', [v.id, p.id]);
      const s = await one('select 1 from saved_vacancies where vacancy_id = $1 and person_id = $2', [v.id, p.id]);
      mine = { applied: Boolean(a), applicationStage: a?.stage ?? null, saved: Boolean(s) };
    }
  }
  return { ...v, skills: skills.map((s) => s.name), hostRating: rating && rating.n >= 3 ? { average: rating.avg, count: rating.n } : null, mine };
});

// ---------------------------------------------------------------------------
// Staff review (FR-EMP-12) and field-visit creation (FR-EMP-15)
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'get', path: '/', summary: 'All vacancies for staff', access: STAFF,
    query: zPage.extend({ status: z.enum(VACANCY_STATUSES).optional(), orgId: z.string().uuid().optional() }),
  },
  async ({ query: q }) => {
    const rows = await query(
      `select v.id, v.title, v.status, v.openings, v.filled, v.wage, v.created_on_behalf as "onBehalf", v.host_confirmed_at as "hostConfirmedAt",
              v.submitted_at as "submittedAt", v.opened_at as "openedAt", v.is_seasonal as "isSeasonal", o.name as host, o.id as "orgId",
              d.name as dzongkhag, greatest(0, current_date - coalesce(v.opened_at, v.created_at)::date) as "daysOpen",
              (select count(*)::int from applications a where a.vacancy_id = v.id and a.stage not in ('not_selected','withdrawn')) as "inProgress",
              count(*) over() as total
         from vacancies v join organisations o on o.id = v.org_id left join dzongkhags d on d.id = v.dzongkhag_id
        where ($1::text is null or v.status = $1) and ($2::uuid is null or v.org_id = $2)
          and ($3::text is null or v.title ilike '%' || $3 || '%' or o.name ilike '%' || $3 || '%')
        order by case v.status when 'submitted' then 0 when 'open' then 1 else 2 end, v.updated_at desc ${pageClause(q)}`,
      [q.status ?? null, q.orgId ?? null, q.q ?? null],
    );
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  },
);

m.route({ method: 'get', path: '/:id', summary: 'Vacancy detail for staff', access: STAFF }, async ({ params }) => {
  const v = await one(
    `select v.*, o.name as host, o.verification_status as host_verification, d.name as dzongkhag
       from vacancies v join organisations o on o.id = v.org_id left join dzongkhags d on d.id = v.dzongkhag_id where v.id = $1`,
    [params.id],
  );
  if (!v) throw notFound('Vacancy');
  const [skills, history, applications, decisions] = await Promise.all([
    query('select s.id, s.name from vacancy_skills vs join skills s on s.id = vs.skill_id where vs.vacancy_id = $1', [params.id]),
    query(`select h.from_status as "from", h.to_status as "to", h.comment, h.created_at as "at", u.full_name as "by"
             from vacancy_status_history h left join users u on u.id = h.changed_by where h.vacancy_id = $1 order by h.id`, [params.id]),
    query(`select a.id, a.stage, a.source, a.match_score as "matchScore", a.host_decision as "hostDecision", a.host_decision_reason as "hostDecisionReason",
                  a.shared_with_host_at as "sharedAt", a.applied_at as "appliedAt", a.offer_wage as "offerWage", a.offer_start_date as "offerStartDate",
                  p.id as "personId", p.full_name as name, p.stage as "candidateStage", p.expected_wage as "expectedWage",
                  (select json_build_object('id', i.id, 'scheduledAt', i.scheduled_at, 'status', i.status, 'result', i.result)
                     from interviews i where i.application_id = a.id order by i.created_at desc limit 1) as interview,
                  (select pl.id from placements pl where pl.application_id = a.id limit 1) as "placementId"
             from applications a join person_profiles p on p.id = a.person_id where a.vacancy_id = $1 order by a.applied_at`, [params.id]),
    query(`select md.person_id as "personId", p.full_name as name, md.decision, md.reason, md.score, md.created_at as "at", u.full_name as "by"
             from match_decisions md join person_profiles p on p.id = md.person_id left join users u on u.id = md.decided_by
            where md.vacancy_id = $1 order by md.created_at desc`, [params.id]),
  ]);
  return { ...v, skills, history, applications, decisions };
});

m.route(
  { method: 'post', path: '/:id/approve', summary: 'Approve a vacancy: it opens and gets a share link', access: { any: ['vacancies.review'] }, body: z.object({ comment: z.string().optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      await transitionVacancy(params.id, 'open', auth.userId, body.comment ?? null, db);
      await audit({ actorId: auth.userId, action: 'vacancy.approved', entityType: 'vacancy', entityId: params.id, ip }, db);
      return one('select share_slug as slug from vacancies where id = $1', [params.id], db);
    }),
);

m.route(
  { method: 'post', path: '/:id/return', summary: 'Return a vacancy to the host with comments', access: { any: ['vacancies.review'] }, body: z.object({ comment: z.string().min(5) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      await transitionVacancy(params.id, 'draft', auth.userId, body.comment, db);
      await audit({ actorId: auth.userId, action: 'vacancy.returned', entityType: 'vacancy', entityId: params.id, ip, details: body }, db);
      return { ok: true };
    }),
);

m.route(
  { method: 'post', path: '/:id/status', summary: 'Pause, reopen, fill or close a vacancy', access: { any: ['vacancies.review'] },
    body: z.object({ status: z.enum(['open', 'paused', 'filled', 'closed']), comment: z.string().optional() }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      await transitionVacancy(params.id, body.status, auth.userId, body.comment ?? null, db);
      return { ok: true };
    }),
);

m.route(
  { method: 'post', path: '/on-behalf', summary: 'Field Officer creates a vacancy during a host visit', access: { any: ['vacancies.manage_any'] },
    body: z.object({ orgId: z.string().uuid(), vacancy: vacancyInput }) },
  async ({ body, auth, ip }) =>
    tx(async (db) => {
      const owner = await one<{ mobile: string; user_id: string }>(
        `select u.mobile, u.id as user_id from user_roles ur join users u on u.id = ur.user_id where ur.org_id = $1 and ur.role_code = 'host_owner' order by ur.created_at limit 1`,
        [body.orgId], db);
      if (!owner) throw badRequest('This host has no owner account to confirm the vacancy.');
      const id = await saveVacancy(body.orgId, body.vacancy, auth.userId, db, undefined, true);
      const otp = await issueOtp({ mobile: owner.mobile, purpose: 'host_confirm_vacancy', userId: owner.user_id, refId: id }, db);
      await audit({ actorId: auth.userId, action: 'vacancy.created_on_behalf', entityType: 'vacancy', entityId: id, ip }, db);
      return { id, ...otp, next: 'Ask the host for the code sent to their phone to confirm and submit.' };
    }),
);

m.route(
  { method: 'post', path: '/:id/host-confirm', summary: 'Confirm an on-behalf vacancy with the host OTP and submit it', access: { any: ['vacancies.manage_any'] },
    body: z.object({ code: z.string().length(6) }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const owner = await one<{ mobile: string }>(
        `select u.mobile from vacancies v join user_roles ur on ur.org_id = v.org_id and ur.role_code = 'host_owner' join users u on u.id = ur.user_id
          where v.id = $1 order by ur.created_at limit 1`, [params.id], db);
      if (!owner) throw notFound('Vacancy');
      await verifyOtp({ mobile: owner.mobile, purpose: 'host_confirm_vacancy', code: body.code, refId: params.id }, db);
      await db.query('update vacancies set host_confirmed_at = now() where id = $1', [params.id]);
      await transitionVacancy(params.id, 'submitted', auth.userId, 'Confirmed by host OTP during field visit', db);
      return { ok: true };
    }),
);

// ---------------------------------------------------------------------------
// Matching and shortlisting (FR-PLC-01..03, Workflow 1 step 5)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/:id/matches', summary: 'Ranked candidate suggestions', access: { any: ['matching.manage'] } }, async ({ params }) =>
  rankCandidatesForVacancy(params.id),
);

m.route(
  {
    method: 'post', path: '/:id/shortlist', summary: 'Share screened candidates with the host', access: { any: ['matching.manage'] },
    body: z.object({ items: z.array(z.object({ personId: z.string().uuid(), reason: z.string().min(3) })).min(1).max(30) }),
  },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const v = await one<{ status: string; title: string; org_id: string; host: string }>(
        `select v.status, v.title, v.org_id, o.name as host from vacancies v join organisations o on o.id = v.org_id where v.id = $1`, [params.id], db);
      if (!v) throw notFound('Vacancy');
      if (v.status !== 'open') throw ruleViolation('Only open vacancies can receive a shortlist.');
      const ranked = new Map((await rankCandidatesForVacancy(params.id, { limit: 500 }, db)).map((r) => [r.personId, r]));
      for (const item of body.items) {
        const r = ranked.get(item.personId);
        // FR-PLC-02: hosts never see unscreened candidates.
        if (!r) throw ruleViolation('Only screened candidates who are Ready for Placement (or on bench) can be shared with a host.');
        await db.query(
          `insert into applications (vacancy_id, person_id, stage, source, match_score, shared_with_host_at, shared_by)
           values ($1, $2, 'shortlisted', 'matched', $3, now(), $4)
           on conflict (vacancy_id, person_id) do update set stage = 'shortlisted', match_score = excluded.match_score,
             shared_with_host_at = now(), shared_by = excluded.shared_by, host_decision = null, host_decision_reason = null`,
          [params.id, item.personId, r.score, auth.userId],
        );
        await db.query(
          `insert into match_decisions (vacancy_id, person_id, score, breakdown, decision, reason, decided_by) values ($1,$2,$3,$4,'shared',$5,$6)`,
          [params.id, item.personId, r.score, JSON.stringify(r.breakdown), item.reason, auth.userId],
        );
        const p = await one<{ user_id: string | null; mobile: string }>('select user_id, mobile from person_profiles where id = $1', [item.personId], db);
        await notify({ userId: p?.user_id, mobile: p?.mobile, code: 'shortlisted', vars: { title: v.title, host: v.host }, channels: ['in_app'] }, db);
      }
      const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code in ('host_owner','host_supervisor')`, [v.org_id], db);
      for (const o of owners) {
        await notify({ userId: o.user_id, code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Candidates shortlisted', body: `BTBG shared ${body.items.length} screened candidate(s) for "${v.title}". Review their Trust Profiles.` } }, db);
      }
      await audit({ actorId: auth.userId, action: 'matching.shortlisted', entityType: 'vacancy', entityId: params.id, ip, details: { count: body.items.length } }, db);
      return { ok: true, shared: body.items.length };
    }),
);

m.route(
  { method: 'post', path: '/:id/reject-match', summary: 'Record why a suggested candidate was not shared', access: { any: ['matching.manage'] },
    body: z.object({ personId: z.string().uuid(), reason: z.string().min(3), score: z.number().optional() }) },
  async ({ params, body, auth }) => {
    await query(`insert into match_decisions (vacancy_id, person_id, score, decision, reason, decided_by) values ($1,$2,$3,'rejected',$4,$5)`,
      [params.id, body.personId, body.score ?? null, body.reason, auth.userId]);
    return { ok: true };
  },
);

m.route(
  { method: 'post', path: '/applications/:appId/stage', summary: 'Move an application (staff)', access: { any: ['matching.manage', 'candidates.manage'] },
    body: z.object({ stage: z.enum(['screening', 'not_selected', 'withdrawn']), reason: z.string().min(3) }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const a = await one('select id, stage from applications where id = $1 for update', [params.appId], db);
      if (!a) throw notFound('Application');
      if (['hired'].includes(a.stage)) throw ruleViolation('This application already led to a placement.');
      if (body.stage === 'not_selected' || body.stage === 'withdrawn') await applicationOutcome(params.appId, body.stage, body.reason, db);
      else await db.query(`update applications set stage = 'screening' where id = $1`, [params.appId]);
      await audit({ actorId: auth.userId, action: 'application.stage', entityType: 'application', entityId: params.appId, details: body }, db);
      return { ok: true };
    }),
);
