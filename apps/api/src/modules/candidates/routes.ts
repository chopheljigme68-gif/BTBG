import { parse as parseCsv } from 'csv-parse/sync';
import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit, recordChanges } from '../../lib/audit.js';
import { blindIndex, decrypt, encrypt } from '../../lib/crypto.js';
import { badRequest, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zDate, zMobile, zPage } from '../../lib/http.js';
import { issueOtp, verifyOtp } from '../../lib/otp.js';
import { getSetting } from '../../lib/settings.js';
import { createTask } from '../../lib/tasks.js';
import { issueCertificate } from '../certificates/service.js';
import { CANDIDATE_SOURCES, CANDIDATE_STAGES, createPersonProfile, findDuplicate, setStage } from '../people/service.js';
import { buildTrustProfile, completeness, scoreScorecard, type Criterion } from './service.js';

const m = createModule('/candidates', 'Candidate pipeline');
export default m;

const VIEW = { any: ['candidates.view'] };
const MANAGE = { any: ['candidates.manage'] };

m.route(
  {
    method: 'get', path: '/', summary: 'Candidate pipeline with filters', access: VIEW,
    query: zPage.extend({
      stage: z.enum(CANDIDATE_STAGES).optional(), source: z.enum(CANDIDATE_SOURCES).optional(),
      dzongkhagId: z.coerce.number().int().optional(), officerId: z.string().uuid().optional(),
      lifecycle: z.enum(['job_seeker', 'apprentice', 'alumni']).optional(),
      contactUnverified: z.enum(['true', 'false']).optional(), mine: z.enum(['true', 'false']).optional(),
    }),
  },
  async ({ query: q, auth }) => {
    const rows = await query(
      `select p.id, p.full_name as "fullName", p.mobile, p.stage, p.lifecycle, p.source, p.employment_type as "employmentType",
              d.name as dzongkhag, p.expected_wage as "expectedWage", p.contact_unverified as "contactUnverified",
              p.last_contact_at as "lastContactAt", p.identity_status as "identityStatus", u.full_name as officer,
              (select total from screening_results r where r.person_id = p.id order by created_at desc limit 1) as "screeningScore",
              p.created_at as "createdAt", count(*) over() as total
         from person_profiles p left join dzongkhags d on d.id = p.dzongkhag_id left join users u on u.id = p.assigned_officer_id
        where ($1::text is null or p.stage = $1) and ($2::text is null or p.source = $2) and ($3::int is null or p.dzongkhag_id = $3)
          and ($4::uuid is null or p.assigned_officer_id = $4) and ($5::text is null or p.lifecycle = $5)
          and ($6::boolean is null or p.contact_unverified = $6)
          and ($7::text is null or p.full_name ilike '%' || $7 || '%' or p.mobile like '%' || $7 || '%')
        order by p.updated_at desc ${pageClause(q)}`,
      [q.stage ?? null, q.source ?? null, q.dzongkhagId ?? null, q.mine === 'true' ? auth.userId : q.officerId ?? null,
        q.lifecycle ?? null, q.contactUnverified ? q.contactUnverified === 'true' : null, q.q ?? null],
    );
    const counts = await query(`select stage, count(*)::int as n from person_profiles group by stage`);
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0, stageCounts: Object.fromEntries(counts.map((c) => [c.stage, c.n])) };
  },
);

m.route({ method: 'get', path: '/import/template', summary: 'CSV template for partner imports', access: { any: ['candidates.import'] } }, async ({ res }) => {
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', 'attachment; filename="btbg-candidate-import.csv"');
  res.send('full_name,mobile,cid,gender,date_of_birth,dzongkhag,source,source_detail,expected_wage,skills\n' +
    'Pema Wangmo,17123456,11505001234,female,2004-03-15,Punakha,tti,TTI Khuruthang 2026 batch,12000,Housekeeping;Laundry\n');
});

const importRow = z.object({
  full_name: z.string().trim().min(2),
  mobile: zMobile,
  cid: z.string().regex(/^\d{11}$/, 'CID must be 11 digits').optional().or(z.literal('')).transform((v) => v || null),
  gender: z.enum(['female', 'male', 'other', 'prefer_not']).optional().or(z.literal('')).transform((v) => v || null),
  date_of_birth: zDate.optional().or(z.literal('')).transform((v) => v || null),
  dzongkhag: z.string().optional(),
  source: z.enum(CANDIDATE_SOURCES),
  source_detail: z.string().optional(),
  expected_wage: z.coerce.number().optional().or(z.literal('')).transform((v) => (v === '' || v === undefined ? null : Number(v))),
  skills: z.string().optional(),
});

/** Bulk import with duplicate detection by mobile and CID (FR-CND-02). */
m.route(
  { method: 'post', path: '/import', summary: 'Import candidates from a partner CSV', access: { any: ['candidates.import'] }, upload: true,
    body: z.object({ dryRun: z.boolean().default(true) }) },
  async ({ file, body, auth, ip }) => {
    if (!file) throw badRequest('Attach the CSV file.');
    let records: Record<string, string>[];
    try {
      records = parseCsv(file.buffer, { columns: true, skip_empty_lines: true, trim: true, bom: true });
    } catch {
      throw badRequest('The CSV could not be read. Use the template and save as CSV (UTF-8).');
    }
    if (records.length > 2000) throw badRequest('Import at most 2,000 rows at a time.');
    const dzongkhags = new Map((await query('select id, lower(name) as name from dzongkhags')).map((d) => [d.name, d.id]));
    const skills = new Map((await query('select id, lower(name) as name from skills')).map((s) => [s.name, s.id]));
    const seen = new Set<string>();
    const results: Array<{ row: number; name?: string; status: 'ok' | 'duplicate' | 'error'; message?: string; personId?: string }> = [];

    await tx(async (db) => {
      for (const [i, rec] of records.entries()) {
        const rowNo = i + 2;
        const parsed = importRow.safeParse(rec);
        if (!parsed.success) {
          const iss = parsed.error.issues[0];
          results.push({ row: rowNo, name: rec.full_name, status: 'error', message: `${iss.path.join('.')}: ${iss.message}` });
          continue;
        }
        const r = parsed.data;
        const dup = (seen.has(r.mobile) || (r.cid && seen.has(blindIndex(r.cid)))) ? { matched_on: 'file' } : await findDuplicate(r.mobile, r.cid, db);
        if (dup) {
          results.push({ row: rowNo, name: r.full_name, status: 'duplicate', message: `Already registered (matched on ${dup.matched_on === 'file' ? 'an earlier row' : dup.matched_on})` });
          continue;
        }
        seen.add(r.mobile);
        if (r.cid) seen.add(blindIndex(r.cid));
        const dzId = r.dzongkhag ? dzongkhags.get(r.dzongkhag.toLowerCase()) : undefined;
        if (r.dzongkhag && !dzId) {
          results.push({ row: rowNo, name: r.full_name, status: 'error', message: `Unknown Dzongkhag "${r.dzongkhag}"` });
          continue;
        }
        if (body.dryRun) {
          results.push({ row: rowNo, name: r.full_name, status: 'ok' });
          continue;
        }
        const personId = await createPersonProfile({
          fullName: r.full_name, mobile: r.mobile, cid: r.cid, gender: r.gender, dateOfBirth: r.date_of_birth,
          dzongkhagId: dzId ?? null, source: r.source, sourceDetail: r.source_detail ?? null, expectedWage: r.expected_wage,
          createdBy: auth.userId,
        }, db);
        for (const s of (r.skills ?? '').split(/[;|]/).map((x) => x.trim().toLowerCase()).filter(Boolean)) {
          const sid = skills.get(s);
          if (sid) await db.query('insert into person_skills (person_id, skill_id) values ($1, $2) on conflict do nothing', [personId, sid]);
        }
        results.push({ row: rowNo, name: r.full_name, status: 'ok', personId });
      }
      if (!body.dryRun) {
        await audit({ actorId: auth.userId, action: 'candidates.imported', ip, details: { rows: records.length, created: results.filter((r) => r.status === 'ok').length } }, db);
      }
    });
    return {
      dryRun: body.dryRun,
      summary: { total: records.length, ok: results.filter((r) => r.status === 'ok').length, duplicates: results.filter((r) => r.status === 'duplicate').length, errors: results.filter((r) => r.status === 'error').length },
      results,
    };
  },
);

// ---------------------------------------------------------------------------
// Assisted registration by a Field Officer, confirmed by OTP (FR-AUTH-04)
// ---------------------------------------------------------------------------
m.route(
  { method: 'post', path: '/assisted/start', summary: 'Send an OTP to the job seeker being registered', access: MANAGE, body: z.object({ mobile: zMobile }) },
  async ({ body }) => {
    if (await one('select 1 from users where mobile = $1', [body.mobile])) throw badRequest('This mobile number already has an account.');
    return issueOtp({ mobile: body.mobile, purpose: 'assisted_register' });
  },
);

m.route(
  {
    method: 'post', path: '/assisted/complete', summary: 'Create the job seeker account after the seeker reads the OTP aloud', access: MANAGE,
    body: z.object({
      mobile: zMobile, code: z.string().length(6), fullName: z.string().trim().min(2), cid: z.string().regex(/^\d{11}$/).optional(),
      gender: z.enum(['female', 'male', 'other', 'prefer_not']).optional(), dateOfBirth: zDate.optional(),
      dzongkhagId: z.number().int().optional(), gewogId: z.number().int().optional(),
      source: z.enum(CANDIDATE_SOURCES).default('field_officer'), sourceDetail: z.string().optional(),
      consentRead: z.literal(true, { message: 'read the consent statement to the job seeker first' }),
    }),
  },
  async ({ body, auth, ip }) =>
    tx(async (db) => {
      await verifyOtp({ mobile: body.mobile, purpose: 'assisted_register', code: body.code }, db);
      const user = await one<{ id: string }>(
        `insert into users (mobile, full_name, mobile_verified_at, contact_confirmed_at, created_by) values ($1, $2, now(), now(), $3) returning id`,
        [body.mobile, body.fullName, auth.userId], db);
      await db.query(`insert into user_roles (user_id, role_code, granted_by) values ($1, 'job_seeker', $2)`, [user!.id, auth.userId]);
      await db.query(`insert into consents (user_id, version, scope, ip) values ($1, $2, $3, $4)`,
        [user!.id, await getSetting('auth.consent_version', db), ['matching', 'employment', 'sharing', 'assisted'], ip]);
      const personId = await createPersonProfile({
        userId: user!.id, fullName: body.fullName, mobile: body.mobile, cid: body.cid, gender: body.gender, dateOfBirth: body.dateOfBirth,
        dzongkhagId: body.dzongkhagId, gewogId: body.gewogId, source: body.source, sourceDetail: body.sourceDetail, createdBy: auth.userId,
      }, db);
      await db.query('update person_profiles set assigned_officer_id = $2, last_contact_at = now() where id = $1', [personId, auth.userId]);
      await audit({ actorId: auth.userId, action: 'auth.assisted_register', entityType: 'person', entityId: personId, ip }, db);
      return { userId: user!.id, personId, next: 'The job seeker can set a password with "Forgot password" using this mobile number.' };
    }),
);

// ---------------------------------------------------------------------------
// Candidate detail and edits
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/:id', summary: 'Full candidate record', access: VIEW }, async ({ params, auth }) => {
  const p = await one(
    `select p.*, d.name as dzongkhag, g.name as gewog, u.full_name as officer_name, c.title as preferred_career
       from person_profiles p left join dzongkhags d on d.id = p.dzongkhag_id left join gewogs g on g.id = p.gewog_id
       left join users u on u.id = p.assigned_officer_id left join careers c on c.id = p.preferred_career_id
      where p.id = $1`,
    [params.id],
  );
  if (!p) throw notFound('Candidate');
  const id = params.id;
  const [skills, credentials, work, training, screening, certificates, stageHistory, contacts, applications, placements, verifications, changes, completion] =
    await Promise.all([
      query(`select s.id, s.name, ps.level from person_skills ps join skills s on s.id = ps.skill_id where ps.person_id = $1`, [id]),
      query(`select id, type, institution, qualification, year, file_path as "filePath", verification_status as "verificationStatus" from person_credentials where person_id = $1`, [id]),
      query(`select id, employer, role, start_date as "startDate", end_date as "endDate", description from work_history where person_id = $1 order by start_date desc nulls last`, [id]),
      query(`select id, programme, provider, start_date as "startDate", end_date as "endDate", attendance_pct as "attendancePct", assessment, result from training_records where person_id = $1 order by created_at desc`, [id]),
      query(`select r.id, r.total, r.passed, r.scores, r.wage_expectation as "wageExpectation", r.commitment_months as "commitmentMonths",
                    r.willing_to_relocate as "willingToRelocate", r.notes, r.created_at as "createdAt", s.name as scorecard, s.version, s.criteria, u.full_name as officer
               from screening_results r join screening_scorecards s on s.id = r.scorecard_id left join users u on u.id = r.officer_id
              where r.person_id = $1 order by r.created_at desc`, [id]),
      query(`select id, kind, title, programme, outcome, verification_code as "code", issued_at as "issuedAt", revoked_at as "revokedAt" from certificates where person_id = $1 order by issued_at desc`, [id]),
      query(`select h.from_stage as "from", h.to_stage as "to", h.reason, h.created_at as "at", u.full_name as "by" from candidate_stage_history h left join users u on u.id = h.changed_by where h.person_id = $1 order by h.id desc`, [id]),
      query(`select c.channel, c.outcome, c.notes, c.created_at as "at", u.full_name as officer from contact_log c left join users u on u.id = c.officer_id where c.person_id = $1 order by c.created_at desc`, [id]),
      query(`select a.id, a.stage, a.applied_at as "appliedAt", a.match_score as "matchScore", a.host_decision as "hostDecision", v.id as "vacancyId", v.title, o.name as host, v.wage as "offeredWage"
               from applications a join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id where a.person_id = $1 order by a.applied_at desc`, [id]),
      query(`select pl.id, pl.status, pl.role_title as "roleTitle", pl.start_date as "startDate", pl.planned_end_date as "plannedEndDate", o.name as host, pl.outcome
               from placements pl join organisations o on o.id = pl.org_id where pl.person_id = $1 order by pl.created_at desc`, [id]),
      query(`select v.item, v.decision, v.reason, v.created_at as "at", u.full_name as "by" from verification_decisions v left join users u on u.id = v.decided_by where v.entity_type = 'person' and v.entity_id = $1 order by v.created_at desc`, [id]),
      query(`select h.changes, h.created_at as "at", u.full_name as "by" from change_history h left join users u on u.id = h.changed_by where h.entity_type = 'person' and h.entity_id = $1 order by h.id desc limit 50`, [id]),
      completeness(id),
    ]);
  const canSeeSensitive = auth.permissions.has('sensitive.view');
  return {
    id: p.id, userId: p.user_id, fullName: p.full_name, mobile: p.mobile, email: p.email,
    cidMasked: p.cid_last4 ? `•••••••${p.cid_last4}` : null, canViewSensitive: canSeeSensitive,
    dateOfBirth: p.date_of_birth, gender: p.gender, dzongkhagId: p.dzongkhag_id, gewogId: p.gewog_id, dzongkhag: p.dzongkhag, gewog: p.gewog, village: p.village,
    altContact: { name: p.alt_contact_name, mobile: p.alt_contact_mobile, relation: p.alt_contact_relation },
    expectedWage: p.expected_wage, availableFrom: p.available_from, employmentType: p.employment_type, preferredRoles: p.preferred_roles,
    preferredCareer: p.preferred_career, languages: p.languages, willingToRelocate: p.willing_to_relocate, bio: p.bio,
    stage: p.stage, lifecycle: p.lifecycle, source: p.source, sourceDetail: p.source_detail,
    officerId: p.assigned_officer_id, officer: p.officer_name, lastContactAt: p.last_contact_at, failedContactAttempts: p.failed_contact_attempts,
    contactUnverified: p.contact_unverified, identityStatus: p.identity_status,
    bank: { name: p.bank_name, accountLast4: p.bank_account_last4, holder: p.bank_account_holder },
    createdAt: p.created_at, completeness: completion,
    skills, credentials, workHistory: work, training, screening, certificates, stageHistory, contacts, applications, placements, verifications, changes,
  };
});

m.route({ method: 'get', path: '/:id/sensitive', summary: 'Unmasked CID and bank details (audited)', access: { any: ['sensitive.view'] } }, async ({ params, auth, ip }) => {
  const p = await one('select cid_enc, bank_account_enc, bank_name from person_profiles where id = $1', [params.id]);
  if (!p) throw notFound('Candidate');
  await audit({ actorId: auth.userId, action: 'data.sensitive_viewed', entityType: 'person', entityId: params.id, ip });
  return { cid: decrypt(p.cid_enc), bankName: p.bank_name, bankAccount: decrypt(p.bank_account_enc) };
});

const profilePatch = z.object({
  fullName: z.string().trim().min(2).optional(), email: z.string().email().nullable().optional(),
  cid: z.string().regex(/^\d{11}$/, 'CID must be 11 digits').optional(),
  dateOfBirth: zDate.nullable().optional(), gender: z.enum(['female', 'male', 'other', 'prefer_not']).nullable().optional(),
  dzongkhagId: z.number().int().nullable().optional(), gewogId: z.number().int().nullable().optional(), village: z.string().nullable().optional(),
  expectedWage: z.number().min(0).nullable().optional(), availableFrom: zDate.nullable().optional(),
  officerId: z.string().uuid().nullable().optional(), source: z.enum(CANDIDATE_SOURCES).optional(), sourceDetail: z.string().nullable().optional(),
  altContactName: z.string().nullable().optional(), altContactMobile: zMobile.nullable().optional(), altContactRelation: z.string().nullable().optional(),
});

const COLUMN: Record<string, string> = {
  fullName: 'full_name', email: 'email', dateOfBirth: 'date_of_birth', gender: 'gender', dzongkhagId: 'dzongkhag_id', gewogId: 'gewog_id',
  village: 'village', expectedWage: 'expected_wage', availableFrom: 'available_from', officerId: 'assigned_officer_id', source: 'source',
  sourceDetail: 'source_detail', altContactName: 'alt_contact_name', altContactMobile: 'alt_contact_mobile', altContactRelation: 'alt_contact_relation',
};

m.route({ method: 'patch', path: '/:id', summary: 'Edit candidate details (change history kept)', access: MANAGE, body: profilePatch }, async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const before = await one('select * from person_profiles where id = $1 for update', [params.id], db);
    if (!before) throw notFound('Candidate');
    const sets: string[] = [];
    const vals: unknown[] = [params.id];
    const beforeView: Record<string, unknown> = {};
    const afterView: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      if (v === undefined || k === 'cid') continue;
      vals.push(v);
      sets.push(`${COLUMN[k]} = $${vals.length}`);
      beforeView[k] = before[COLUMN[k]];
      afterView[k] = v;
    }
    if (body.cid) {
      const dup = await one('select id from person_profiles where cid_hash = $1 and id <> $2', [blindIndex(body.cid), params.id], db);
      if (dup) throw badRequest('Another person is registered with this CID. Check for a duplicate account.');
      vals.push(encrypt(body.cid), blindIndex(body.cid), body.cid.slice(-4));
      sets.push(`cid_enc = $${vals.length - 2}`, `cid_hash = $${vals.length - 1}`, `cid_last4 = $${vals.length}`);
      beforeView.cid = before.cid_last4 ? `…${before.cid_last4}` : null;
      afterView.cid = `…${body.cid.slice(-4)}`;
    }
    if (sets.length) await db.query(`update person_profiles set ${sets.join(', ')} where id = $1`, vals);
    await recordChanges('person', params.id, auth.userId, beforeView, afterView, db);
    await audit({ actorId: auth.userId, action: 'candidate.updated', entityType: 'person', entityId: params.id, ip, details: { fields: Object.keys(afterView) } }, db);
    return { ok: true };
  }),
);

m.route(
  { method: 'post', path: '/:id/stage', summary: 'Move a candidate to another pipeline stage', access: MANAGE,
    body: z.object({ stage: z.enum(CANDIDATE_STAGES), reason: z.string().trim().min(3) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      if (body.stage === 'ready') {
        const passed = await one('select 1 from screening_results where person_id = $1 and passed', [params.id], db);
        if (!passed) throw ruleViolation('A candidate needs a passed screening before they are Ready for Placement.');
      }
      if (body.stage === 'placed') throw ruleViolation('Candidates become Placed automatically when a placement starts.');
      await setStage(params.id, body.stage, body.reason, auth.userId, db);
      await audit({ actorId: auth.userId, action: 'candidate.stage', entityType: 'person', entityId: params.id, ip, details: body }, db);
      return { ok: true };
    }),
);

/** Contact log. Repeated failures mark contact unverified and try the alternate contact (Workflow 2). */
m.route(
  { method: 'post', path: '/:id/contact', summary: 'Log a contact attempt', access: MANAGE,
    body: z.object({ channel: z.enum(['phone', 'sms', 'visit', 'email', 'alt_contact']), outcome: z.enum(['reached', 'no_answer', 'wrong_number', 'alt_contact_reached']), notes: z.string().optional() }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const p = await one('select stage, failed_contact_attempts, alt_contact_mobile, full_name from person_profiles where id = $1 for update', [params.id], db);
      if (!p) throw notFound('Candidate');
      await db.query('insert into contact_log (person_id, officer_id, channel, outcome, notes) values ($1, $2, $3, $4, $5)', [params.id, auth.userId, body.channel, body.outcome, body.notes ?? null]);
      const reached = body.outcome === 'reached' || body.outcome === 'alt_contact_reached';
      if (reached) {
        await db.query(
          `update person_profiles set last_contact_at = now(), failed_contact_attempts = 0,
                  contact_unverified = case when $2 then false else contact_unverified end where id = $1`,
          [params.id, body.outcome === 'reached'],
        );
        if (p.stage === 'registered') await setStage(params.id, 'contacted', 'Contacted by field officer', auth.userId, db);
        await db.query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where entity_id = $1 and kind in ('no_contact_followup','try_alt_contact') and status = 'open'`, [params.id, auth.userId]);
        return { ok: true, contactUnverified: false };
      }
      const attempts = p.failed_contact_attempts + 1;
      const max = await getSetting('candidates.max_contact_attempts', db);
      const unverified = attempts >= max || body.outcome === 'wrong_number';
      await db.query('update person_profiles set failed_contact_attempts = $2, contact_unverified = contact_unverified or $3 where id = $1', [params.id, attempts, unverified]);
      if (unverified) {
        await createTask({
          kind: 'try_alt_contact', title: `Try alternate contact for ${p.full_name}`,
          description: p.alt_contact_mobile ? `Alternate contact: ${p.alt_contact_mobile}` : 'No alternate contact on file. Ask the training partner.',
          entityType: 'person', entityId: params.id, assigneeId: auth.userId, priority: 'high', dedupeKey: `try_alt_contact:${params.id}:${attempts}`,
        }, db);
      }
      return { ok: true, attempts, contactUnverified: unverified };
    }),
);

// ---------------------------------------------------------------------------
// Screening, training, readiness (Workflow 2)
// ---------------------------------------------------------------------------
m.route(
  { method: 'post', path: '/:id/screening', summary: 'Record a screening scorecard result', access: { any: ['candidates.screen'] },
    body: z.object({
      scorecardId: z.string().uuid(), scores: z.record(z.string(), z.number().min(0)), wageExpectation: z.number().min(0).nullable().default(null),
      willingToRelocate: z.boolean().nullable().default(null), commitmentMonths: z.number().int().min(0).nullable().default(null), notes: z.string().optional(),
    }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const card = await one<{ criteria: Criterion[]; pass_threshold: number; is_active: boolean }>('select criteria, pass_threshold, is_active from screening_scorecards where id = $1', [body.scorecardId], db);
      if (!card) throw notFound('Scorecard');
      const missing = card.criteria.filter((c) => body.scores[c.key] === undefined).map((c) => c.label);
      if (missing.length) throw badRequest(`Score every item. Missing: ${missing.join(', ')}`);
      const total = scoreScorecard(card.criteria, body.scores);
      const passed = total >= card.pass_threshold;
      const r = await one(
        `insert into screening_results (person_id, scorecard_id, scores, total, passed, wage_expectation, willing_to_relocate, commitment_months, notes, officer_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [params.id, body.scorecardId, JSON.stringify(body.scores), total, passed, body.wageExpectation, body.willingToRelocate, body.commitmentMonths, body.notes ?? null, auth.userId],
        db,
      );
      // FR-CND-06: wage expectation is stored on the profile so it shows beside offered wages.
      await db.query(
        `update person_profiles set expected_wage = coalesce($2, expected_wage), willing_to_relocate = coalesce($3, willing_to_relocate), last_contact_at = now() where id = $1`,
        [params.id, body.wageExpectation, body.willingToRelocate],
      );
      await setStage(params.id, passed ? 'screened' : 'not_suitable', `Screening score ${total} (pass mark ${card.pass_threshold})`, auth.userId, db);
      await audit({ actorId: auth.userId, action: 'candidate.screened', entityType: 'person', entityId: params.id, ip, details: { total, passed } }, db);
      return { id: r!.id, total, passed, passThreshold: card.pass_threshold };
    }),
);

m.route(
  { method: 'post', path: '/:id/training', summary: 'Record training attendance and result (FR-CND-07)', access: { any: ['candidates.screen'] },
    body: z.object({
      programme: z.string().min(2), provider: z.string().min(2), startDate: zDate.optional(), endDate: zDate.optional(),
      attendancePct: z.number().min(0).max(100).optional(), assessment: z.string().optional(), result: z.enum(['in_progress', 'passed', 'failed']),
      issueCertificate: z.boolean().default(false),
    }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const p = await one<{ stage: string }>('select stage from person_profiles where id = $1', [params.id], db);
      if (!p) throw notFound('Candidate');
      const r = await one(
        `insert into training_records (person_id, programme, provider, start_date, end_date, attendance_pct, assessment, result, recorded_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning id`,
        [params.id, body.programme, body.provider, body.startDate ?? null, body.endDate ?? null, body.attendancePct ?? null, body.assessment ?? null, body.result, auth.userId],
        db,
      );
      if (p.stage === 'screened' && body.result === 'in_progress') await setStage(params.id, 'training', `Started ${body.programme}`, auth.userId, db);
      let certificate = null;
      if (body.issueCertificate && body.result === 'passed') {
        certificate = await issueCertificate({ personId: params.id, kind: 'training', title: body.programme, programme: `${body.programme} (${body.provider})`, outcome: 'Passed', issuedBy: auth.userId }, db);
      }
      return { id: r!.id, certificate };
    }),
);

m.route({ method: 'post', path: '/:id/ready', summary: 'Mark Ready for Placement and publish the Trust Profile', access: { any: ['candidates.screen'] } }, async ({ params, auth }) =>
  tx(async (db) => {
    const passed = await one('select 1 from screening_results where person_id = $1 and passed', [params.id], db);
    if (!passed) throw ruleViolation('Complete a passing screening first.');
    const failedTraining = await one(`select programme from training_records where person_id = $1 and result = 'in_progress'`, [params.id], db);
    if (failedTraining) throw ruleViolation(`Record the result of "${failedTraining.programme}" first.`);
    await setStage(params.id, 'ready', 'Trust Profile published', auth.userId, db);
    return buildTrustProfile(params.id, { revealContact: false }, db);
  }),
);

m.route({ method: 'get', path: '/:id/trust-profile', summary: 'Trust Profile preview', access: VIEW }, async ({ params }) => {
  const t = await buildTrustProfile(params.id, { revealContact: false });
  if (!t) throw notFound('Candidate');
  return t;
});

// ---------------------------------------------------------------------------
// Verification (FR-ENT-02, 05)
// ---------------------------------------------------------------------------
m.route(
  { method: 'post', path: '/:id/verify-identity', summary: 'Verify identity', access: { any: ['candidates.verify'] },
    body: z.object({ decision: z.enum(['verified', 'pending', 'rejected']), reason: z.string().optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      await db.query('update person_profiles set identity_status = $2 where id = $1', [params.id, body.decision]);
      await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('person', $1, 'identity', $2, $3, $4)`,
        [params.id, body.decision, body.reason ?? null, auth.userId]);
      await audit({ actorId: auth.userId, action: 'verification.identity', entityType: 'person', entityId: params.id, ip, details: body }, db);
      return { ok: true };
    }),
);

m.route(
  { method: 'post', path: '/:id/credentials/:credId/verify', summary: 'Verify an academic or TVET credential', access: { any: ['candidates.verify'] },
    body: z.object({ decision: z.enum(['verified', 'pending', 'rejected']), reason: z.string().optional() }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const res = await db.query(`update person_credentials set verification_status = $3, verified_by = $4, verified_at = now() where id = $2 and person_id = $1 returning institution`,
        [params.id, params.credId, body.decision, auth.userId]);
      if (!res.rowCount) throw notFound('Credential');
      await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('person', $1, $2, $3, $4, $5)`,
        [params.id, `credential:${res.rows[0].institution}`, body.decision, body.reason ?? null, auth.userId]);
      await audit({ actorId: auth.userId, action: 'verification.credential', entityType: 'person', entityId: params.id, ip, details: { credId: params.credId, ...body } }, db);
      return { ok: true };
    }),
);

m.route(
  { method: 'post', path: '/:id/payroll-adjustment', summary: 'Add a correction for the next payroll run (FR-PAY-10)', access: { any: ['payroll.prepare'] },
    body: z.object({ amount: z.number().refine((n) => n !== 0, 'amount cannot be zero'), reason: z.string().min(3), sourcePayslipId: z.string().uuid().optional() }) },
  async ({ params, body, auth, ip }) => {
    const r = await one(`insert into payroll_adjustments (person_id, amount, reason, source_payslip_id, created_by) values ($1,$2,$3,$4,$5) returning id`,
      [params.id, body.amount, body.reason, body.sourcePayslipId ?? null, auth.userId]);
    await audit({ actorId: auth.userId, action: 'payroll.adjustment_added', entityType: 'person', entityId: params.id, ip, details: body });
    return r;
  },
);
