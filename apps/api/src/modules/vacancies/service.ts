import { z } from 'zod';
import { env } from '../../config/env.js';
import { type Db, one, pool, query } from '../../db/pool.js';
import { randomCode } from '../../lib/crypto.js';
import { addWorkingDays, todayBT } from '../../lib/dates.js';
import { ruleViolation } from '../../lib/errors.js';
import { zDate } from '../../lib/http.js';
import { notify, notifyRole } from '../../lib/notify.js';
import { getCalendar, getSetting } from '../../lib/settings.js';
import { createTask } from '../../lib/tasks.js';
import { rankCandidatesForVacancy } from './matching.js';

export const VACANCY_STATUSES = ['draft', 'submitted', 'approved', 'open', 'paused', 'filled', 'closed'] as const;
export type VacancyStatus = (typeof VACANCY_STATUSES)[number];

export const vacancyInput = z
  .object({
    title: z.string().trim().min(2).max(120),
    department: z.string().max(80).nullable().default(null),
    careerId: z.string().uuid().nullable().default(null),
    sectorCode: z.string(),
    openings: z.number().int().min(1).max(100),
    skillIds: z.array(z.number().int()).default([]),
    experienceRequired: z.string().max(200).nullable().default(null),
    firstTimeFriendly: z.boolean().default(true),
    dzongkhagId: z.number().int(),
    gewogId: z.number().int().nullable().default(null),
    locationText: z.string().max(200).nullable().default(null),
    wage: z.number().min(0),
    accommodation: z.boolean().default(false),
    meals: z.boolean().default(false),
    benefits: z.string().max(500).nullable().default(null),
    shiftPattern: z.string().max(120).nullable().default(null),
    hoursPerWeek: z.number().min(1).max(72).nullable().default(null),
    startDate: zDate.nullable().default(null),
    isSeasonal: z.boolean().default(false),
    seasonStart: zDate.nullable().default(null),
    seasonEnd: zDate.nullable().default(null),
    description: z.string().max(3000).nullable().default(null),
  })
  .refine((v) => !v.isSeasonal || (v.seasonStart && v.seasonEnd && v.seasonEnd >= v.seasonStart), {
    message: 'seasonal roles need a season start and end date',
    path: ['seasonEnd'],
  });
export type VacancyInput = z.infer<typeof vacancyInput>;

/** Wage floor and legal hours are checked before a vacancy can be submitted (Workflow 1). */
export async function checkVacancyRules(v: { wage: number; hoursPerWeek?: number | null; hours_per_week?: number | null }, db?: Db) {
  const floor = await getSetting('payroll.wage_floor', db);
  if (Number(v.wage) < floor) {
    throw ruleViolation(`The wage Nu ${v.wage} is below the training wage floor of Nu ${floor} per month. Raise the wage to submit this vacancy.`);
  }
  const hours = v.hoursPerWeek ?? v.hours_per_week;
  const maxHours = await getSetting('labour.max_hours_per_week', db);
  if (hours && hours > maxHours) throw ruleViolation(`Contracted hours cannot exceed ${maxHours} per week under the Labour and Employment Act.`);
}

export async function saveVacancy(orgId: string, v: VacancyInput, actorId: string, db: Db, id?: string, onBehalf = false) {
  await checkVacancyRules(v, db);
  const vals = [
    v.title, v.department, v.careerId, v.sectorCode, v.openings, v.experienceRequired, v.firstTimeFriendly, v.dzongkhagId, v.gewogId,
    v.locationText, v.wage, v.accommodation, v.meals, v.benefits, v.shiftPattern, v.hoursPerWeek, v.startDate, v.isSeasonal,
    v.seasonStart, v.seasonEnd, v.description,
  ];
  let vacancyId = id;
  if (id) {
    const res = await db.query(
      `update vacancies set title=$1, department=$2, career_id=$3, sector_code=$4, openings=$5, experience_required=$6, first_time_friendly=$7,
              dzongkhag_id=$8, gewog_id=$9, location_text=$10, wage=$11, accommodation=$12, meals=$13, benefits=$14, shift_pattern=$15,
              hours_per_week=$16, start_date=$17, is_seasonal=$18, season_start=$19, season_end=$20, description=$21
        where id = $22 and org_id = $23 and status in ('draft','submitted','paused','open')`,
      [...vals, id, orgId],
    );
    if (!res.rowCount) throw ruleViolation('This vacancy can no longer be edited.');
    await db.query('delete from vacancy_skills where vacancy_id = $1', [id]);
  } else {
    const row = await one<{ id: string }>(
      `insert into vacancies (title, department, career_id, sector_code, openings, experience_required, first_time_friendly, dzongkhag_id, gewog_id,
              location_text, wage, accommodation, meals, benefits, shift_pattern, hours_per_week, start_date, is_seasonal, season_start, season_end,
              description, org_id, created_by, created_on_behalf)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) returning id`,
      [...vals, orgId, actorId, onBehalf],
      db,
    );
    vacancyId = row!.id;
    await db.query(`insert into vacancy_status_history (vacancy_id, to_status, changed_by) values ($1, 'draft', $2)`, [vacancyId, actorId]);
  }
  for (const s of v.skillIds) await db.query('insert into vacancy_skills (vacancy_id, skill_id) values ($1, $2) on conflict do nothing', [vacancyId, s]);
  return vacancyId!;
}

const ALLOWED: Record<VacancyStatus, VacancyStatus[]> = {
  draft: ['submitted', 'closed'],
  submitted: ['open', 'draft', 'closed'],
  approved: ['open'],
  open: ['paused', 'filled', 'closed'],
  paused: ['open', 'closed'],
  filled: ['open', 'closed'],
  closed: [],
};

export async function transitionVacancy(id: string, to: VacancyStatus, actorId: string | null, comment: string | null, db: Db) {
  const v = await one<{ status: VacancyStatus; org_id: string; wage: number; hours_per_week: number | null; share_slug: string | null; filled: number; openings: number }>(
    'select status, org_id, wage, hours_per_week, share_slug, filled, openings from vacancies where id = $1 for update',
    [id],
    db,
  );
  if (!v) throw ruleViolation('Vacancy not found.');
  if (!ALLOWED[v.status].includes(to)) throw ruleViolation(`A ${v.status} vacancy cannot move to ${to}.`);
  if (to === 'submitted') {
    await checkVacancyRules(v, db);
    const org = await one<{ verification_status: string; status: string }>('select verification_status, status from organisations where id = $1', [v.org_id], db);
    if (org?.status === 'suspended') throw ruleViolation('This host account is suspended.');
  }
  if (to === 'open' && v.status === 'filled' && v.filled >= v.openings) throw ruleViolation('Increase the number of openings before reopening.');
  if (to === 'open' && v.status === 'submitted') {
    // FR-AUTH-14: only verified hosts can have public vacancies.
    const org = await one<{ verification_status: string }>('select verification_status from organisations where id = $1', [v.org_id], db);
    if (org?.verification_status !== 'verified') throw ruleViolation('Verify the host employer before approving its vacancies.');
    await checkVacancyRules(v, db);
  }

  const params: unknown[] = [id, to];
  const sets = ['status = $2'];
  const param = (v: unknown) => `$${params.push(v)}`;
  if (to === 'submitted') sets.push('submitted_at = now()');
  if (to === 'open' && v.status === 'submitted') sets.push('approved_at = now()', `approved_by = ${param(actorId)}`, 'opened_at = now()');
  if (to === 'open' && !v.share_slug) sets.push(`share_slug = ${param(randomCode(8).toLowerCase())}`);
  if (to === 'draft' && comment) sets.push(`review_comment = ${param(comment)}`);
  await db.query(`update vacancies set ${sets.join(', ')} where id = $1`, params);
  if (to === 'open' && v.status === 'submitted') {
    await db.query(`insert into vacancy_status_history (vacancy_id, from_status, to_status, comment, changed_by) values ($1, 'submitted', 'approved', $2, $3)`, [id, comment, actorId]);
    await db.query(`insert into vacancy_status_history (vacancy_id, from_status, to_status, changed_by) values ($1, 'approved', 'open', $2)`, [id, actorId]);
    await onVacancyOpened(id, db);
  } else {
    await db.query(`insert into vacancy_status_history (vacancy_id, from_status, to_status, comment, changed_by) values ($1, $2, $3, $4, $5)`, [id, v.status, to, comment, actorId]);
  }
  if (to === 'submitted') {
    await createTask({ kind: 'review_vacancy', title: 'Review submitted vacancy', entityType: 'vacancy', entityId: id, assigneeRole: 'operations_manager', dedupeKey: `review_vacancy:${id}:${Date.now()}` }, db);
  }
  if (to === 'draft' && v.status === 'submitted') {
    const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code = 'host_owner'`, [v.org_id], db);
    for (const o of owners) await notify({ userId: o.user_id, code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Vacancy returned', body: `BTBG returned your vacancy with comments: ${comment ?? ''}` } }, db);
  }
  if (['open', 'draft', 'closed'].includes(to)) {
    await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where entity_id = $1 and kind = 'review_vacancy' and status = 'open'`, [id, actorId]);
  }
}

/**
 * Workflow 1, steps 3 and 4: run matching, notify matching job seekers, and
 * create a sourcing task with an expected time to fill when nobody is ready.
 */
export async function onVacancyOpened(id: string, db: Db = pool) {
  const v = await one(
    `select v.id, v.title, v.wage, v.dzongkhag_id, v.share_slug, v.career_id, o.name as host
       from vacancies v join organisations o on o.id = v.org_id where v.id = $1`, [id], db);
  if (!v) return;
  const ranked = await rankCandidatesForVacancy(id, { limit: 20 }, db);
  const link = `${env.WEB_URL}/jobs/${v.share_slug}`;
  // Job seekers in the same Dzongkhag or who prefer it, who are not yet placed.
  const seekers = await query<{ user_id: string }>(
    `select p.user_id from person_profiles p
      where p.user_id is not null and p.stage not in ('placed','not_suitable','withdrawn') and p.lifecycle = 'job_seeker'
        and (p.dzongkhag_id = $1 or $1 = any(p.preferred_dzongkhags) or p.preferred_career_id = $2)
      limit 200`,
    [v.dzongkhag_id, v.career_id], db);
  for (const s of seekers) {
    await notify({ userId: s.user_id, code: 'vacancy_match', vars: { title: v.title, host: v.host, wage: v.wage, link }, link: `/jobs/${v.share_slug}` }, db);
  }
  if (ranked.filter((r) => r.score >= 50).length === 0) {
    const cal = await getCalendar(db);
    await createTask({
      kind: 'sourcing', title: `Source candidates for "${v.title}" at ${v.host}`,
      description: 'No Ready for Placement candidates match this vacancy. Screen and train new candidates.',
      entityType: 'vacancy', entityId: id, assigneeRole: 'field_officer', priority: 'high',
      dueAt: addWorkingDays(todayBT(), 5, cal), dedupeKey: `sourcing:${id}`,
    }, db);
  } else {
    await notifyRole('operations_manager', { code: 'generic', channels: ['in_app'], vars: { subject: 'Matches ready', body: `${ranked.length} candidates matched "${v.title}". Review and shortlist.` } }, db);
  }
}

/** Expected time to fill shown to hosts when nobody is ready (Workflow 1 exception). */
export async function expectedDaysToFill(db: Db = pool) {
  const r = await one<{ days: number | null }>(
    `select round(avg(extract(epoch from (p.created_at - v.opened_at)) / 86400))::int as days
       from placements p join vacancies v on v.id = p.vacancy_id where v.opened_at is not null and p.created_at > now() - interval '180 days'`,
    [], db);
  return r?.days ?? 21;
}
