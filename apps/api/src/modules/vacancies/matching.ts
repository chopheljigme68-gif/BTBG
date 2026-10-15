import { type Db, pool, query } from '../../db/pool.js';
import { daysBetween } from '../../lib/dates.js';
import { getSetting } from '../../lib/settings.js';

/**
 * Candidate ranking for a vacancy (FR-PLC-01): skills match, scorecard result,
 * location and travel, wage fit and availability, with configurable weights.
 * Each component is 0..1; the total is 0..100.
 */
export type MatchBreakdown = { skills: number; scorecard: number; location: number; wage: number; availability: number };

export function locationScore(
  v: { dzongkhag_id: number | null; gewog_id: number | null; accommodation: boolean },
  p: { dzongkhag_id: number | null; gewog_id: number | null; preferred_dzongkhags: number[]; willing_to_relocate: boolean | null },
) {
  if (v.gewog_id && p.gewog_id === v.gewog_id) return 1;
  if (v.dzongkhag_id && p.dzongkhag_id === v.dzongkhag_id) return 0.8;
  if (v.dzongkhag_id && p.preferred_dzongkhags?.includes(v.dzongkhag_id)) return 0.7;
  if (p.willing_to_relocate) return v.accommodation ? 0.6 : 0.4;
  return v.accommodation ? 0.3 : 0.1;
}

export function wageScore(offered: number, expected: number | null) {
  if (!expected || expected <= offered) return 1;
  return Math.max(0, 1 - (expected - offered) / offered);
}

export function availabilityScore(start: string | null, availableFrom: string | null) {
  if (!start || !availableFrom || availableFrom <= start) return 1;
  return Math.max(0, 1 - daysBetween(start, availableFrom) / 30);
}

export function skillsScore(required: Array<{ skill_id: number }>, has: Array<{ skill_id: number; level: number }>) {
  if (!required.length) return 0.5;
  const map = new Map(has.map((s) => [s.skill_id, s.level]));
  const sum = required.reduce((a, r) => a + (map.has(r.skill_id) ? 0.6 + 0.1 * Math.min(4, map.get(r.skill_id)! - 1) : 0), 0);
  return Math.min(1, sum / required.length);
}

export function combine(b: MatchBreakdown, w: Record<keyof MatchBreakdown, number>) {
  const total = (Object.keys(b) as Array<keyof MatchBreakdown>).reduce((a, k) => a + b[k] * w[k], 0);
  return Math.round(total * 10) / 10;
}

export async function rankCandidatesForVacancy(vacancyId: string, opts: { limit?: number } = {}, db: Db = pool) {
  const [v] = await query(
    `select id, wage, start_date, dzongkhag_id, gewog_id, accommodation, sector_code from vacancies where id = $1`,
    [vacancyId], db);
  if (!v) return [];
  const required = await query<{ skill_id: number }>('select skill_id from vacancy_skills where vacancy_id = $1', [vacancyId], db);
  const weights = await getSetting('matching.weights', db);
  // Ready candidates, plus apprentices on bench awaiting redeployment.
  const people = await query(
    `select p.id, p.full_name, p.dzongkhag_id, p.gewog_id, p.preferred_dzongkhags, p.willing_to_relocate, p.expected_wage,
            p.available_from, p.stage, p.lifecycle, d.name as dzongkhag,
            (select total from screening_results r where r.person_id = p.id order by created_at desc limit 1) as score,
            exists (select 1 from employment_contracts c where c.person_id = p.id and c.status = 'bench') as on_bench,
            coalesce((select json_agg(json_build_object('skill_id', skill_id, 'level', level)) from person_skills where person_id = p.id), '[]') as skills,
            a.id as application_id, a.stage as application_stage, a.shared_with_host_at
       from person_profiles p left join dzongkhags d on d.id = p.dzongkhag_id
       left join applications a on a.person_id = p.id and a.vacancy_id = $1
      where (p.stage = 'ready' or exists (select 1 from employment_contracts c where c.person_id = p.id and c.status = 'bench'))
        and not exists (select 1 from match_decisions md where md.vacancy_id = $1 and md.person_id = p.id and md.decision = 'rejected')`,
    [vacancyId], db);
  const ranked = people.map((p) => {
    const breakdown: MatchBreakdown = {
      skills: skillsScore(required, p.skills),
      scorecard: p.score === null ? 0 : Number(p.score) / 100,
      location: locationScore(v, p),
      wage: wageScore(Number(v.wage), p.expected_wage === null ? null : Number(p.expected_wage)),
      availability: availabilityScore(v.start_date, p.available_from),
    };
    return {
      personId: p.id, name: p.full_name, dzongkhag: p.dzongkhag, stage: p.stage, onBench: p.on_bench,
      expectedWage: p.expected_wage, offeredWage: v.wage, wageGap: p.expected_wage === null ? null : Number(p.expected_wage) - Number(v.wage),
      screeningScore: p.score, score: combine(breakdown, weights), breakdown,
      applied: Boolean(p.application_id), applicationStage: p.application_stage, shared: Boolean(p.shared_with_host_at),
    };
  });
  // Benched apprentices first: BTBG is already paying them (Workflow 4, step 5).
  ranked.sort((a, b) => Number(b.onBench) - Number(a.onBench) || b.score - a.score);
  return ranked.slice(0, opts.limit ?? 50);
}

/** Vacancy recommendations for a job seeker (FR-EE-11). */
export async function recommendVacancies(personId: string, limit = 10, db: Db = pool) {
  const [p] = await query(
    `select id, dzongkhag_id, gewog_id, preferred_dzongkhags, willing_to_relocate, expected_wage, available_from, preferred_roles,
            coalesce((select json_agg(json_build_object('skill_id', skill_id, 'level', level)) from person_skills where person_id = p.id), '[]') as skills
       from person_profiles p where id = $1`, [personId], db);
  if (!p) return [];
  const vacancies = await query(
    `select v.id, v.title, v.wage, v.start_date, v.dzongkhag_id, v.gewog_id, v.accommodation, v.meals, v.first_time_friendly, v.share_slug,
            o.name as host, o.verification_status = 'verified' as verified, d.name as dzongkhag,
            coalesce((select json_agg(json_build_object('skill_id', skill_id)) from vacancy_skills where vacancy_id = v.id), '[]') as required
       from vacancies v join organisations o on o.id = v.org_id left join dzongkhags d on d.id = v.dzongkhag_id
      where v.status = 'open' and o.status = 'active'
        and not exists (select 1 from applications a where a.vacancy_id = v.id and a.person_id = $1)`,
    [personId], db);
  const roles = (p.preferred_roles as string[]).map((r) => r.toLowerCase());
  return vacancies
    .map((v) => {
      const roleHit = roles.some((r) => v.title.toLowerCase().includes(r) || r.includes(v.title.toLowerCase())) ? 1 : 0;
      const score =
        skillsScore(v.required, p.skills) * 30 + locationScore(v, p) * 25 + wageScore(Number(v.wage), p.expected_wage) * 20 +
        availabilityScore(v.start_date, p.available_from) * 10 + roleHit * 15;
      const { required: _required, ...rest } = v;
      return { ...rest, score: Math.round(score) };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
