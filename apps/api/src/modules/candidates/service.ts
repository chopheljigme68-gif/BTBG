import { type Db, one, pool, query } from '../../db/pool.js';
import { decrypt } from '../../lib/crypto.js';

export type Criterion = { key: string; label: string; weight: number; max: number };

/** Weighted score out of 100 (FR-CND-04). Missing criteria score zero. */
export function scoreScorecard(criteria: Criterion[], scores: Record<string, number>) {
  let total = 0;
  for (const c of criteria) {
    const raw = Math.max(0, Math.min(c.max, Number(scores[c.key] ?? 0)));
    total += (raw / c.max) * c.weight;
  }
  return Math.round(total * 100) / 100;
}

/** Profile completeness with tips (FR-EE-03). */
export async function completeness(personId: string, db: Db = pool) {
  const p = await one(
    `select p.*, (select count(*) from person_skills where person_id = p.id)::int as skills,
            (select count(*) from person_credentials where person_id = p.id)::int as credentials,
            (select count(*) from work_history where person_id = p.id)::int as jobs,
            (select count(*) from portfolio_media where person_id = p.id)::int as media
       from person_profiles p where p.id = $1`,
    [personId],
    db,
  );
  if (!p) return { score: 0, tips: [] as string[] };
  const checks: Array<[boolean, number, string]> = [
    [Boolean(p.date_of_birth && p.gender), 10, 'Add your date of birth and gender.'],
    [Boolean(p.dzongkhag_id && p.gewog_id), 10, 'Add your Dzongkhag and gewog so we can find jobs near you.'],
    [Boolean(p.cid_enc), 10, 'Add your CID number so BTBG can verify you.'],
    [p.skills > 0, 15, 'Add at least one skill.'],
    [p.credentials > 0, 15, 'Add your school, TVET or university education.'],
    [p.expected_wage !== null && p.available_from !== null, 10, 'Tell us your expected wage and when you can start.'],
    [p.preferred_roles.length > 0, 10, 'Choose the kinds of jobs you want.'],
    [Boolean(p.alt_contact_mobile), 10, 'Add a second contact, like a family member, so we never lose touch.'],
    [p.jobs > 0 || p.media > 0, 10, 'Add work experience or a photo or short video of your work.'],
  ];
  const score = checks.reduce((a, [ok, w]) => a + (ok ? w : 0), 0);
  return { score, tips: checks.filter(([ok]) => !ok).map(([, , tip]) => tip) };
}

/**
 * One-page Trust Profile (FR-CND-08). CID, address and contact details stay
 * hidden until an interview is booked with the host viewing it.
 */
export async function buildTrustProfile(personId: string, opts: { revealContact: boolean }, db: Db = pool) {
  const p = await one(
    `select p.id, p.full_name, p.gender, p.date_of_birth, p.mobile, p.email, p.village, p.cid_enc, p.stage,
            p.expected_wage, p.available_from, p.languages, p.preferred_roles, p.identity_status, p.bio,
            d.name as dzongkhag, g.name as gewog
       from person_profiles p left join dzongkhags d on d.id = p.dzongkhag_id left join gewogs g on g.id = p.gewog_id
      where p.id = $1`,
    [personId],
    db,
  );
  if (!p) return null;
  const [screening, training, certificates, skills, credentials, references] = await Promise.all([
    one(
      `select r.total, r.passed, r.scores, r.commitment_months, r.willing_to_relocate, r.created_at, s.name as scorecard, s.criteria
         from screening_results r join screening_scorecards s on s.id = r.scorecard_id
        where r.person_id = $1 order by r.created_at desc limit 1`,
      [personId], db),
    query(`select programme, provider, end_date, attendance_pct, result from training_records where person_id = $1 order by end_date desc nulls first`, [personId], db),
    query(`select title, issued_at, verification_code from certificates where person_id = $1 and revoked_at is null order by issued_at desc`, [personId], db),
    query(`select s.name, ps.level from person_skills ps join skills s on s.id = ps.skill_id where ps.person_id = $1 order by ps.level desc`, [personId], db),
    query(`select type, institution, qualification, year, verification_status from person_credentials where person_id = $1`, [personId], db),
    query(
      `select o.name as host, r.stars, r.comment, r.created_at from ratings r join organisations o on o.id = r.org_id
        where r.person_id = $1 and r.to_party = 'apprentice' order by r.created_at desc limit 3`,
      [personId], db),
  ]);
  const age = p.date_of_birth ? Math.floor((Date.now() - new Date(p.date_of_birth).getTime()) / (365.25 * 86_400_000)) : null;
  return {
    personId: p.id,
    name: p.full_name,
    gender: p.gender,
    age,
    location: [p.gewog, p.dzongkhag].filter(Boolean).join(', '),
    identityVerified: p.identity_status === 'verified',
    expectedWage: p.expected_wage,
    availableFrom: p.available_from,
    languages: p.languages,
    preferredRoles: p.preferred_roles,
    bio: p.bio,
    screening: screening && {
      score: screening.total, passed: screening.passed, scorecard: screening.scorecard, date: screening.created_at,
      commitmentMonths: screening.commitment_months, willingToRelocate: screening.willing_to_relocate,
      breakdown: (screening.criteria as Criterion[]).map((c) => ({ label: c.label, score: screening.scores[c.key] ?? 0, max: c.max })),
    },
    training,
    trainingAttendanceAvg: training.length ? Math.round(training.reduce((a, t) => a + Number(t.attendance_pct ?? 0), 0) / training.length) : null,
    certificates,
    skills,
    credentials,
    references,
    contact: opts.revealContact
      ? { mobile: p.mobile, email: p.email, village: p.village, cid: decrypt(p.cid_enc) }
      : { hidden: true, reason: 'Contact details, CID and address are shown once an interview is booked.' },
  };
}
