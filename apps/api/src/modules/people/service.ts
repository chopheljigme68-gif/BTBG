import { type Db, one, pool } from '../../db/pool.js';
import { blindIndex, encrypt } from '../../lib/crypto.js';
import { conflict } from '../../lib/errors.js';
import { notify } from '../../lib/notify.js';

export const CANDIDATE_STAGES = [
  'registered', 'contacted', 'screening', 'screened', 'training', 'ready', 'placed', 'not_suitable', 'withdrawn',
] as const;
export type CandidateStage = (typeof CANDIDATE_STAGES)[number];

export const CANDIDATE_SOURCES = [
  'self', 'tti', 'college', 'desuung', 'gyalsung', 'dzongkhag', 'walk_in', 'social_media', 'referral', 'field_officer',
] as const;

export interface NewPerson {
  userId?: string | null;
  fullName: string;
  mobile: string;
  email?: string | null;
  cid?: string | null;
  dateOfBirth?: string | null;
  gender?: string | null;
  dzongkhagId?: number | null;
  gewogId?: number | null;
  source?: (typeof CANDIDATE_SOURCES)[number];
  sourceDetail?: string | null;
  employmentType?: 'full_time' | 'freelance';
  preferredCareerId?: string | null;
  preferredRoles?: string[];
  expectedWage?: number | null;
  createdBy?: string | null;
}

/** Find a person by mobile or CID, for duplicate detection (FR-CND-02). */
export async function findDuplicate(mobile: string, cid: string | null | undefined, db: Db = pool) {
  return one<{ id: string; full_name: string; mobile: string; matched_on: string }>(
    `select id, full_name, mobile, case when mobile = $1 then 'mobile' else 'cid' end as matched_on
       from person_profiles where mobile = $1 or ($2::text is not null and cid_hash = $2) limit 1`,
    [mobile, cid ? blindIndex(cid) : null],
    db,
  );
}

export async function createPersonProfile(p: NewPerson, db: Db = pool) {
  const dup = await findDuplicate(p.mobile, p.cid, db);
  if (dup) throw conflict(`A person with this ${dup.matched_on === 'mobile' ? 'mobile number' : 'CID'} is already registered.`, { personId: dup.id });
  const row = await one<{ id: string }>(
    `insert into person_profiles
       (user_id, full_name, mobile, email, cid_enc, cid_hash, cid_last4, date_of_birth, gender, dzongkhag_id, gewog_id,
        source, source_detail, employment_type, preferred_career_id, preferred_roles, expected_wage, created_by,
        assigned_officer_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18, $19)
     returning id`,
    [
      p.userId ?? null, p.fullName, p.mobile, p.email ?? null,
      encrypt(p.cid), p.cid ? blindIndex(p.cid) : null, p.cid ? p.cid.slice(-4) : null,
      p.dateOfBirth ?? null, p.gender ?? null, p.dzongkhagId ?? null, p.gewogId ?? null,
      p.source ?? 'self', p.sourceDetail ?? null, p.employmentType ?? 'full_time', p.preferredCareerId ?? null,
      p.preferredRoles ?? [], p.expectedWage ?? null, p.createdBy ?? null,
      await pickOfficer(p.dzongkhagId ?? null, db),
    ],
    db,
  );
  await db.query(
    `insert into candidate_stage_history (person_id, from_stage, to_stage, reason, changed_by) values ($1, null, 'registered', $2, $3)`,
    [row!.id, `Source: ${p.source ?? 'self'}`, p.createdBy ?? null],
  );
  return row!.id;
}

/**
 * Assign the field officer with the lightest open caseload, preferring
 * officers already handling candidates in the same Dzongkhag (Workflow 2, step 2).
 */
export async function pickOfficer(dzongkhagId: number | null, db: Db = pool): Promise<string | null> {
  const r = await one<{ id: string }>(
    `select u.id from users u join user_roles ur on ur.user_id = u.id and ur.role_code = 'field_officer'
      where u.status = 'active'
      order by (select count(*) from person_profiles p where p.assigned_officer_id = u.id and p.dzongkhag_id = $1) desc,
               (select count(*) from person_profiles p where p.assigned_officer_id = u.id
                  and p.stage not in ('placed','not_suitable','withdrawn')) asc,
               u.created_at
      limit 1`,
    [dzongkhagId],
    db,
  );
  return r?.id ?? null;
}

const OUTCOME_ADVICE: Partial<Record<CandidateStage, string>> = {
  not_suitable: 'Ask your field officer about free training that can help next time.',
  withdrawn: 'You can apply again at any time.',
};

/**
 * Move a candidate between pipeline stages, recording history. Every final
 * outcome sends the candidate a message (FR-CND-10).
 */
export async function setStage(personId: string, to: CandidateStage, reason: string | null, actorId: string | null, db: Db = pool) {
  const p = await one<{ stage: CandidateStage; user_id: string | null; mobile: string; full_name: string }>(
    'select stage, user_id, mobile, full_name from person_profiles where id = $1 for update',
    [personId],
    db,
  );
  if (!p || p.stage === to) return;
  await db.query('update person_profiles set stage = $2 where id = $1', [personId, to]);
  await db.query(
    `insert into candidate_stage_history (person_id, from_stage, to_stage, reason, changed_by) values ($1, $2, $3, $4, $5)`,
    [personId, p.stage, to, reason, actorId],
  );
  if (to === 'not_suitable') {
    await notify({ userId: p.user_id, mobile: p.mobile, code: 'outcome_not_suitable', vars: { advice: OUTCOME_ADVICE[to] } }, db);
  }
}

export async function personForUser(userId: string, db: Db = pool) {
  return one<{ id: string; full_name: string; stage: string; lifecycle: string; mobile: string }>(
    'select id, full_name, stage, lifecycle, mobile from person_profiles where user_id = $1',
    [userId],
    db,
  );
}
