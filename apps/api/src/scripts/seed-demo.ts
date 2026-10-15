import { one, pool, query, tx } from '../db/pool.js';
import { addDays, todayBT } from '../lib/dates.js';
import { encrypt, randomToken } from '../lib/crypto.js';
import { flushNotifications } from '../lib/notify.js';
import { hashPassword } from '../modules/auth/service.js';
import { createPersonProfile } from '../modules/people/service.js';
import { confirmOffer, signDocument } from '../modules/placements/service.js';

/**
 * Demo data so every portal can be tried straight away: one account per role,
 * two verified hosts in Punakha, open vacancies, job seekers at each stage and
 * one apprentice already on placement. Safe to run twice (it stops if the demo
 * Super Admin exists). Never run this against production.
 */
export const DEMO_PASSWORD = 'Btbg#Demo2026';

const STAFF: Array<[string, string, string, string]> = [
  ['+97517000001', 'admin@btbg.demo', 'Tshering Dorji', 'super_admin'],
  ['+97517000002', 'ops@btbg.demo', 'Pema Choden', 'operations_manager'],
  ['+97517000003', 'field@btbg.demo', 'Sonam Tobgay', 'field_officer'],
  ['+97517000004', 'finance@btbg.demo', 'Dechen Wangmo', 'finance_officer'],
  ['+97517000005', 'finance2@btbg.demo', 'Ugyen Tenzin', 'finance_officer'],
  ['+97517000006', 'grievance@btbg.demo', 'Kinley Yangzom', 'grievance_officer'],
  ['+97517000007', 'help@btbg.demo', 'Namgay Dema', 'helpdesk_agent'],
  ['+97517000008', 'content@btbg.demo', 'Jigme Norbu', 'content_curator'],
];

if (process.env.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}

const existing = await one(`select 1 from users where mobile = $1`, [STAFF[0][0]]);
if (existing) {
  console.log('Demo data already present. Nothing to do.');
  await pool.end();
  process.exit(0);
}

const hash = await hashPassword(DEMO_PASSWORD);
const ids: Record<string, string> = {};

await tx(async (db) => {
  const user = async (mobile: string, email: string | null, name: string) =>
    (await one<{ id: string }>(
      `insert into users (mobile, email, password_hash, full_name, mobile_verified_at, contact_confirmed_at) values ($1,$2,$3,$4,now(),now()) returning id`,
      [mobile, email, hash, name], db))!.id;

  for (const [mobile, email, name, role] of STAFF) {
    ids[email] = await user(mobile, email, name);
    await db.query('insert into user_roles (user_id, role_code) values ($1, $2)', [ids[email], role]);
  }
  const punakha = (await one<{ id: number }>(`select id from dzongkhags where name = 'Punakha'`, [], db))!.id;
  const gewogs = await query<{ id: number; name: string }>(`select id, name from gewogs where dzongkhag_id = $1 order by name`, [punakha], db);
  const skills = new Map((await query<{ id: number; name: string }>(`select id, name from skills`, [], db)).map((s) => [s.name, s.id]));

  // Careers and training (Vocational Video Campaign)
  const careers: Record<string, string> = {};
  for (const c of [
    { slug: 'housekeeping-attendant', title: 'Housekeeping attendant', summary: 'Keep guest rooms and public areas spotless and welcoming.', tasks: 'Clean and prepare rooms, restock amenities, report maintenance issues, handle laundry.', skills: ['Housekeeping', 'Laundry', 'Customer service'], min: 9000, max: 14000, growth: 'Attendant → Senior attendant → Floor supervisor → Executive housekeeper', kw: ['housekeep', 'room attendant'] },
    { slug: 'commis-cook', title: 'Commis cook', summary: 'Learn every station of a professional kitchen.', tasks: 'Prepare ingredients, cook under supervision, keep the kitchen hygienic.', skills: ['Commis cook', 'Kitchen hygiene', 'Food handling'], min: 9500, max: 16000, growth: 'Commis → Demi chef de partie → Chef de partie → Sous chef', kw: ['cook', 'kitchen', 'chef'] },
    { slug: 'front-office-associate', title: 'Front office associate', summary: 'Be the first smile guests see.', tasks: 'Check guests in and out, take bookings, answer questions, handle payments.', skills: ['Front office', 'Customer service'], min: 10000, max: 18000, growth: 'Associate → Shift leader → Front office manager', kw: ['front office', 'reception'] },
  ]) {
    careers[c.slug] = (await one<{ id: string }>(
      `insert into careers (slug, title, sector_code, summary, daily_tasks, skills, training_routes, wage_min, wage_max, growth_path, role_keywords)
       values ($1,$2,'hospitality',$3,$4,$5,'BTBG apprenticeship with on-the-job training; TTI short courses.',$6,$7,$8,$9) returning id`,
      [c.slug, c.title, c.summary, c.tasks, c.skills, c.min, c.max, c.growth, c.kw], db))!.id;
  }
  await db.query(
    `insert into training_programmes (title, provider, career_id, sector_code, dzongkhag_id, description, start_date) values
       ('Hospitality foundations (4 weeks)', 'BTBG with Punakha TTI', $1, 'hospitality', $3, 'Grooming, guest care, hygiene and safety.', $4),
       ('Kitchen basics', 'Royal Institute for Tourism and Hospitality', $2, 'hospitality', $3, 'Knife skills, food safety and station work.', $5)`,
    [careers['housekeeping-attendant'], careers['commis-cook'], punakha, addDays(todayBT(), 21), addDays(todayBT(), 35)]);

  // Hosts
  const org = async (name: string, licence: string, tier: string, gewog: number, peak: number[]) =>
    (await one<{ id: string }>(
      `insert into organisations (name, trade_licence_no, sector_code, star_rating, dzongkhag_id, gewog_id, address, owner_name, size_tier, staff_count, peak_months, off_peak_months,
              culture, verification_status, verified_by, verified_at)
       values ($1,$2,'hospitality',3,$3,$4,'Near Punakha Dzong',$5,$6,25,$7,'{6,7,8}','Friendly team that trains newcomers on the job.','verified',$8,now()) returning id`,
      [name, licence, punakha, gewog, `Owner of ${name}`, tier, peak, ids['ops@btbg.demo']], db))!.id;
  const hotel = await org('Punakha Riverside Hotel', 'TL-PNK-1001', 'medium', gewogs[0].id, [3, 4, 10, 11]);
  const cafe = await org('Lobesa Farmhouse Kitchen', 'TL-PNK-1002', 'small', gewogs[1]?.id ?? gewogs[0].id, [3, 4, 9, 10, 11]);
  for (const kind of ['trade_licence', 'owner_id']) {
    await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, decided_by) values ('organisation', $1, $2, 'verified', $3)`, [hotel, kind, ids['ops@btbg.demo']]);
  }
  ids.owner = await user('+97517000011', 'owner@riverside.demo', 'Karma Tshering');
  ids.supervisor = await user('+97517000012', 'supervisor@riverside.demo', 'Yeshi Lhamo');
  ids.cafeOwner = await user('+97517000013', 'owner@lobesa.demo', 'Dorji Wangchuk');
  await db.query(`insert into user_roles (user_id, role_code, org_id) values ($1,'host_owner',$2), ($3,'host_supervisor',$2), ($4,'host_owner',$5)`,
    [ids.owner, hotel, ids.supervisor, ids.cafeOwner, cafe]);

  // Vacancies
  const vacancy = async (orgId: string, title: string, career: string, wage: number, openings: number, skillNames: string[], extra: { accommodation?: boolean; meals?: boolean } = {}) => {
    const v = (await one<{ id: string }>(
      `insert into vacancies (org_id, title, career_id, sector_code, openings, dzongkhag_id, location_text, wage, accommodation, meals, shift_pattern, hours_per_week,
              start_date, description, status, submitted_at, approved_at, approved_by, opened_at, share_slug, created_by)
       values ($1,$2,$3,'hospitality',$4,$5,'Punakha',$6,$7,$8,'Day and evening shifts, 6 days a week',48,$9,$10,'open',now(),now(),$11,now(),$12,$13) returning id`,
      [orgId, title, careers[career], openings, punakha, wage, extra.accommodation ?? false, extra.meals ?? true, addDays(todayBT(), 14),
        `Join our team as a ${title.toLowerCase()}. No experience needed: BTBG trains you and you are employed by BTBG for the apprenticeship.`,
        ids['ops@btbg.demo'], `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${randomToken(3).toLowerCase()}`, ids.owner], db))!.id;
    for (const s of skillNames) await db.query('insert into vacancy_skills (vacancy_id, skill_id) values ($1, $2)', [v, skills.get(s)]);
    await db.query(`insert into vacancy_status_history (vacancy_id, to_status, comment, changed_by) values ($1, 'open', 'Demo data', $2)`, [v, ids['ops@btbg.demo']]);
    return v;
  };
  const hk = await vacancy(hotel, 'Housekeeping attendant', 'housekeeping-attendant', 10000, 3, ['Housekeeping', 'Laundry'], { accommodation: true });
  await vacancy(hotel, 'Front office associate', 'front-office-associate', 11000, 1, ['Front office', 'Customer service']);
  await vacancy(cafe, 'Commis cook', 'commis-cook', 9500, 2, ['Commis cook', 'Kitchen hygiene', 'Food handling']);

  // Job seekers at different stages
  const scorecard = (await one<{ id: string; criteria: Array<{ key: string }> }>(`select id, criteria from screening_scorecards where sector_code = 'hospitality' and is_active`, [], db))!;
  const seekers: Array<[string, string, string, 'female' | 'male', string, string[]]> = [
    ['+97517000020', 'seeker@btbg.demo', 'Karma Wangmo', 'female', 'ready', ['Housekeeping', 'Customer service']],
    ['+97517000021', 'apprentice@btbg.demo', 'Tashi Penjor', 'male', 'ready', ['Housekeeping', 'Laundry']],
    ['+97517000022', 'chimi@btbg.demo', 'Chimi Lhamo', 'female', 'screening', ['Front office']],
    ['+97517000023', 'phurba@btbg.demo', 'Phurba Dorji', 'male', 'registered', ['Commis cook']],
    ['+97517000024', 'sangay@btbg.demo', 'Sangay Choki', 'female', 'training', ['Food handling', 'Kitchen hygiene']],
    ['+97517000025', 'nima@btbg.demo', 'Nima Gyeltshen', 'male', 'ready', ['Commis cook', 'Food handling']],
  ];
  for (const [i, [mobile, email, name, gender, stage, skillNames]] of seekers.entries()) {
    const uid = await user(mobile, email, name);
    await db.query(`insert into user_roles (user_id, role_code) values ($1, 'job_seeker')`, [uid]);
    await db.query(`insert into consents (user_id, version, scope) values ($1, '1.0', '{profile,matching,sms}')`, [uid]);
    const cid = `11506000${String(i).padStart(3, '0')}`;
    const pid = await createPersonProfile({ userId: uid, fullName: name, mobile, email, cid, gender, dateOfBirth: `${2000 + i}-0${(i % 9) + 1}-15`,
      dzongkhagId: punakha, gewogId: gewogs[i % gewogs.length].id, source: i % 2 ? 'tti' : 'self', expectedWage: 9000 + i * 300, createdBy: uid }, db);
    ids[email] = pid;
    await db.query(`update person_profiles set stage = $2, available_from = current_date, identity_status = $3, last_contact_at = now(), languages = '{Dzongkha,English}',
                      bank_name = 'Bank of Bhutan', bank_account_enc = $4, bank_account_last4 = $5, bank_account_holder = $6 where id = $1`,
      [pid, stage, stage === 'ready' ? 'verified' : 'pending', encrypt(`2001${i}4567890${i}`), `890${i}`, name]);
    for (const s of skillNames) await db.query('insert into person_skills (person_id, skill_id, level) values ($1, $2, 3)', [pid, skills.get(s)]);
    if (['ready', 'training'].includes(stage)) {
      const scores = Object.fromEntries(scorecard.criteria.map((c) => [c.key, 4]));
      await db.query(`insert into screening_results (person_id, scorecard_id, scores, total, passed, officer_id) values ($1,$2,$3,80,true,$4)`, [pid, scorecard.id, scores, ids['field@btbg.demo']]);
    }
  }
  ids.chimiPerson = ids['chimi@btbg.demo'];
  // Karma applies to the housekeeping job (shows in her portal and the staff pipeline).
  await db.query(`insert into applications (vacancy_id, person_id, stage, source, match_score) values ($1, $2, 'shortlisted', 'applied', 82)`, [hk, ids['seeker@btbg.demo']]);

  // Tashi is already an apprentice: offered, both agreements signed, started 35 days ago.
  const app = (await one<{ id: string }>(
    `insert into applications (vacancy_id, person_id, stage, source, match_score, shared_with_host_at, shared_by, host_decision, offer_wage, offer_start_date)
     values ($1, $2, 'offered', 'matched', 88, now() - interval '50 days', $3, 'accepted', 10000, $4) returning id`,
    [hk, ids['apprentice@btbg.demo'], ids['ops@btbg.demo'], addDays(todayBT(), -35)], db))!.id;
  const { placementId, contractId, hpaId } = await confirmOffer(app, { wage: 10000, hoursPerWeek: 48, daysPerWeek: 6, restDaysPerWeek: 1, leaveDaysPerYear: 12, startDate: addDays(todayBT(), -35) }, ids['ops@btbg.demo'], db);
  const tashi = await one<{ user_id: string }>('select user_id from person_profiles where id = $1', [ids['apprentice@btbg.demo']], db);
  await signDocument('employment_contract', contractId, { userId: tashi!.user_id, name: 'Tashi Penjor', ip: '127.0.0.1' }, db);
  await signDocument('hpa', hpaId, { userId: ids.owner, name: 'Karma Tshering', ip: '127.0.0.1' }, db);
  await db.query(`update placements set supervisor_user_id = $2 where id = $1`, [placementId, ids.supervisor]);
  await db.query(`insert into performance_notes (placement_id, author_id, note, punctuality, skills, attitude, teamwork, customer_care) values ($1,$2,'Learning fast and always on time.',5,3,5,4,4)`,
    [placementId, ids.supervisor]);

  // Help desk and grievance examples
  await db.query(`insert into helpdesk_tickets (ref, user_id, category, priority, subject, response_due, resolution_due) values
    ('T' || lpad(nextval('ticket_ref_seq')::text, 6, '0'), $1, 'account', 'normal', 'I cannot upload my school certificate', now() + interval '8 hours', now() + interval '72 hours')`,
    [(await one('select user_id from person_profiles where id = $1', [ids.chimiPerson], db))!.user_id]);
});

console.log(`
Demo data created. Every account uses the password: ${DEMO_PASSWORD}
With DEV_EXPOSE_OTP=true the sign-in code is shown on screen.

  Super Admin          17000001     Field Officer     17000003
  Operations Manager   17000002     Finance (maker)   17000004
  Finance (checker)    17000005     Grievance Officer 17000006
  Helpdesk             17000007     Content Curator   17000008
  Host owner (hotel)   17000011     Host supervisor   17000012
  Host owner (cafe)    17000013
  Job seeker           17000020     Apprentice        17000021
`);
await flushNotifications();
await pool.end();
