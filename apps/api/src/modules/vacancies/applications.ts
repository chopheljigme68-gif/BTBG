import { type Db, one } from '../../db/pool.js';
import { notify } from '../../lib/notify.js';

const ADVICE: Record<string, string> = {
  skills: 'Ask your field officer about short training for this kind of role.',
  default: 'Keep your profile up to date and we will match you with the next suitable job.',
};

/**
 * Close an application with an outcome. Every candidate always receives an
 * outcome message, including when not selected (FR-CND-10).
 */
export async function applicationOutcome(applicationId: string, stage: 'not_selected' | 'withdrawn', reason: string, db: Db) {
  const a = await one(
    `select a.id, a.stage, p.user_id, p.mobile, v.title
       from applications a join person_profiles p on p.id = a.person_id join vacancies v on v.id = a.vacancy_id
      where a.id = $1`,
    [applicationId],
    db,
  );
  if (!a || a.stage === stage) return;
  await db.query(
    `update applications set stage = $2, outcome_reason = $3, outcome_notified_at = case when $2 = 'not_selected' then now() end where id = $1`,
    [applicationId, stage, reason],
  );
  if (stage === 'not_selected') {
    const advice = /skill|experience|train/i.test(reason) ? ADVICE.skills : ADVICE.default;
    await notify({ userId: a.user_id, mobile: a.mobile, code: 'outcome_not_selected', vars: { title: a.title, advice } }, db);
  }
}
