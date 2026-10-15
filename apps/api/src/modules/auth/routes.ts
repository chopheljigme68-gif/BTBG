import { z } from 'zod';
import { env } from '../../config/env.js';
import { one, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { randomToken, sha256 } from '../../lib/crypto.js';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { createModule, zMobile } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { issueOtp, verifyOtp } from '../../lib/otp.js';
import { getSetting } from '../../lib/settings.js';
import { SESSION_COOKIE, clearPermissionCache, permissionsFor } from '../../middleware/auth.js';
import { createPersonProfile } from '../people/service.js';
import {
  checkPassword, createSession, hashPassword, idleTimeoutFor, mfaRequired, profileSummary, recordLogin, rolesOf,
} from './service.js';

const m = createModule('/auth', 'Authentication');
export default m;

const zPassword = z.string().min(8, 'use at least 8 characters').max(128);
const LOCK_AFTER = 5;
const LOCK_MINUTES = 15;

m.route({ method: 'get', path: '/consent', summary: 'Current consent statement (FR-AUTH-10)', access: 'public' }, async () => ({
  version: await getSetting('auth.consent_version'),
  text: await getSetting('auth.consent_text'),
  scopes: [
    { code: 'matching', label: 'Use my profile to match me with jobs and training', required: true },
    { code: 'employment', label: 'Use my details for contracts, payroll and certificates', required: true },
    { code: 'sharing', label: 'Share my screened Trust Profile with host employers', required: true },
    { code: 'research', label: 'Include my anonymised data in impact reports', required: false },
  ],
}));

// ---------------------------------------------------------------------------
// Self registration (FR-AUTH-02, 03, 10, 14)
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'post', path: '/register/start', summary: 'Send a registration OTP to a mobile number', access: 'public',
    body: z.object({ mobile: zMobile }),
  },
  async ({ body }) => {
    const exists = await one('select 1 from users where mobile = $1', [body.mobile]);
    if (exists) throw conflict('This mobile number already has an account. Sign in, or reset your password.');
    return issueOtp({ mobile: body.mobile, purpose: 'register' });
  },
);

const registerBody = z.object({
  mobile: zMobile,
  code: z.string().length(6),
  fullName: z.string().trim().min(2).max(120),
  email: z.string().email().optional().or(z.literal('')).transform((v) => v || null),
  password: zPassword,
  language: z.enum(['en', 'dz']).default('en'),
  consentVersion: z.string(),
  consentScopes: z.array(z.string()).min(1),
  trustedDevice: z.boolean().default(false),
  account: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('job_seeker'),
      employmentType: z.enum(['full_time', 'freelance']).default('full_time'),
      dzongkhagId: z.number().int().optional(),
      gewogId: z.number().int().optional(),
      careerSlug: z.string().optional(),
      viewerRef: z.string().max(64).optional(),
    }),
    z.object({
      type: z.literal('host_owner'),
      orgName: z.string().trim().min(2).max(160),
      tradeLicenceNo: z.string().trim().min(3).max(40),
      sectorCode: z.string(),
      sizeTier: z.enum(['micro', 'small', 'medium', 'large']).default('small'),
      dzongkhagId: z.number().int(),
      gewogId: z.number().int().optional(),
    }),
  ]),
});

m.route(
  { method: 'post', path: '/register/complete', summary: 'Verify OTP and create a job seeker or host account', access: 'public', body: registerBody },
  async ({ body, res, req, ip }) => {
    const currentConsent = await getSetting('auth.consent_version');
    if (body.consentVersion !== currentConsent) throw badRequest('The consent statement was updated. Please read it again and accept.');
    for (const required of ['matching', 'employment', 'sharing']) {
      if (!body.consentScopes.includes(required)) throw badRequest('Please accept the required consent items to create an account.');
    }
    const result = await tx(async (db) => {
      await verifyOtp({ mobile: body.mobile, purpose: 'register', code: body.code }, db);
      if (await one('select 1 from users where mobile = $1', [body.mobile], db)) throw conflict('This mobile number already has an account.');
      if (body.email && (await one('select 1 from users where lower(email) = lower($1)', [body.email], db))) {
        throw conflict('This email is already used by another account.');
      }
      const user = await one<{ id: string }>(
        `insert into users (mobile, email, password_hash, full_name, language, mobile_verified_at, contact_confirmed_at, signup_viewer_ref)
         values ($1, $2, $3, $4, $5, now(), now(), $6) returning id`,
        [body.mobile, body.email, await hashPassword(body.password), body.fullName, body.language,
          body.account.type === 'job_seeker' ? body.account.viewerRef ?? null : null],
        db,
      );
      const userId = user!.id;
      await db.query('insert into consents (user_id, version, scope, ip) values ($1, $2, $3, $4)', [userId, body.consentVersion, body.consentScopes, ip]);

      if (body.account.type === 'job_seeker') {
        const a = body.account;
        const career = a.careerSlug ? await one<{ id: string; title: string }>('select id, title from careers where slug = $1', [a.careerSlug], db) : null;
        await db.query(`insert into user_roles (user_id, role_code) values ($1, 'job_seeker')`, [userId]);
        await createPersonProfile({
          userId, fullName: body.fullName, mobile: body.mobile, email: body.email,
          dzongkhagId: a.dzongkhagId, gewogId: a.gewogId, employmentType: a.employmentType,
          preferredCareerId: career?.id ?? null, preferredRoles: career ? [career.title] : [],
          source: a.viewerRef ? 'social_media' : 'self', sourceDetail: a.viewerRef ? 'Vocational video campaign' : null,
        }, db);
        if (a.viewerRef) {
          await db.query(
            `insert into video_events (career_id, viewer_ref, user_id, type) values ($1, $2, $3, 'register_click')`,
            [career?.id ?? null, a.viewerRef, userId],
          );
        }
      } else {
        const a = body.account;
        if (await one('select 1 from organisations where trade_licence_no = $1', [a.tradeLicenceNo], db)) {
          throw conflict('An organisation with this trade licence number is already registered. Ask its owner to add you as a user.');
        }
        const org = await one<{ id: string }>(
          `insert into organisations (name, trade_licence_no, sector_code, size_tier, dzongkhag_id, gewog_id, owner_name, created_by)
           values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
          [a.orgName, a.tradeLicenceNo, a.sectorCode, a.sizeTier, a.dzongkhagId, a.gewogId ?? null, body.fullName, userId],
          db,
        );
        await db.query(`insert into user_roles (user_id, role_code, org_id) values ($1, 'host_owner', $2)`, [userId, org!.id]);
        await db.query(
          `insert into tasks (kind, title, entity_type, entity_id, assignee_role, dedupe_key)
           values ('verify_host', $1, 'organisation', $2, 'operations_manager', $3)`,
          [`Verify new host: ${a.orgName}`, org!.id, `verify_host:${org!.id}`],
        );
      }
      await notify({ userId, code: 'welcome', vars: { name: body.fullName }, channels: ['in_app'] }, db);
      await audit({ actorId: userId, action: 'auth.register', entityType: 'user', entityId: userId, ip, details: { type: body.account.type } }, db);
      // The OTP just proved possession of the phone, so this counts as the second factor.
      const session = await createSession(res, { userId, trustedDevice: body.trustedDevice, mfaPassed: true, ip, userAgent: req.headers['user-agent'] }, db);
      return { userId, role: session.role, token: session.token };
    });
    return result;
  },
);

// ---------------------------------------------------------------------------
// Sign in, MFA, lockout (FR-AUTH-06, 08, 11)
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'post', path: '/login', summary: 'Sign in with mobile and password', access: 'public',
    body: z.object({ mobile: zMobile, password: z.string().min(1), trustedDevice: z.boolean().default(false) }),
  },
  async ({ body, res, req, ip }) => {
    const user = await one(
      `select id, password_hash, status, full_name, locked_until > now() as locked, failed_login_attempts, language
         from users where mobile = $1`,
      [body.mobile],
    );
    const invalid = () => new AppError(401, 'invalid_credentials', 'Mobile number or password is not correct.');
    if (!user || !user.password_hash) {
      if (user && !user.password_hash) {
        throw new AppError(401, 'password_not_set', 'This account has no password yet. Use "Forgot password" to set one by SMS code.');
      }
      throw invalid();
    }
    if (user.locked) {
      throw new AppError(423, 'locked', `This account is locked for ${LOCK_MINUTES} minutes after ${LOCK_AFTER} failed attempts. Try again later or reset your password.`);
    }
    if (user.status === 'suspended') throw new AppError(403, 'suspended', 'This account is suspended. Contact BTBG for help.');

    if (!(await checkPassword(body.password, user.password_hash))) {
      const attempts = user.failed_login_attempts + 1;
      if (attempts >= LOCK_AFTER) {
        await query(
          `update users set failed_login_attempts = 0, locked_until = now() + make_interval(mins => $2) where id = $1`,
          [user.id, LOCK_MINUTES],
        );
        await notify({ userId: user.id, code: 'account_locked', channels: ['sms'] });
        await audit({ actorId: user.id, action: 'auth.locked', entityType: 'user', entityId: user.id, ip });
        throw new AppError(423, 'locked', `Too many failed attempts. This account is locked for ${LOCK_MINUTES} minutes. We sent you an SMS.`);
      }
      await query('update users set failed_login_attempts = $2 where id = $1', [user.id, attempts]);
      await audit({ actorId: user.id, action: 'auth.login_failed', entityType: 'user', entityId: user.id, ip });
      throw invalid();
    }

    const needsMfa = await mfaRequired(user.id);
    const session = await createSession(res, { userId: user.id, trustedDevice: body.trustedDevice, mfaPassed: !needsMfa, ip, userAgent: req.headers['user-agent'] });
    if (needsMfa) {
      const otp = await issueOtp({ mobile: body.mobile, purpose: 'login_mfa', userId: user.id, refId: session.sessionId, language: user.language });
      return { mfaRequired: true, ...otp, token: session.token };
    }
    await recordLogin(user.id);
    await audit({ actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, ip });
    return { mfaRequired: false, role: session.role, token: session.token };
  },
);

m.route(
  {
    method: 'post', path: '/mfa/verify', summary: 'Complete sign-in with the SMS code', access: 'user', allowPendingMfa: true,
    body: z.object({ code: z.string().length(6) }),
  },
  async ({ body, auth, ip }) => {
    if (auth.mfaPassed) return { ok: true };
    await verifyOtp({ mobile: auth.mobile, purpose: 'login_mfa', code: body.code, refId: auth.sessionId });
    await query('update sessions set mfa_passed = true, last_seen_at = now() where id = $1', [auth.sessionId]);
    await recordLogin(auth.userId);
    await audit({ actorId: auth.userId, action: 'auth.login', entityType: 'user', entityId: auth.userId, ip, details: { mfa: true } });
    return { ok: true, role: auth.role };
  },
);

m.route(
  { method: 'post', path: '/mfa/resend', summary: 'Send a new sign-in code', access: 'user', allowPendingMfa: true },
  async ({ auth }) => {
    if (auth.mfaPassed) return { ok: true };
    return issueOtp({ mobile: auth.mobile, purpose: 'login_mfa', userId: auth.userId, refId: auth.sessionId });
  },
);

m.route({ method: 'post', path: '/logout', summary: 'Sign out', access: 'optional', allowPendingMfa: true }, async ({ auth, res, ip }) => {
  if (auth) {
    await query('update sessions set revoked_at = now() where id = $1', [auth.sessionId]);
    await audit({ actorId: auth.userId, action: 'auth.logout', entityType: 'user', entityId: auth.userId, ip });
  }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return { ok: true };
});

m.route({ method: 'get', path: '/me', summary: 'Current user, roles and permissions', access: 'user' }, async ({ auth }) => {
  const [user, roles, summary] = await Promise.all([
    one(
      `select id, mobile, email, full_name as "fullName", language, mfa_enabled as "mfaEnabled",
              contact_confirmed_at as "contactConfirmedAt", last_login_at as "lastLoginAt"
         from users where id = $1`,
      [auth.userId],
    ),
    rolesOf(auth.userId),
    profileSummary(auth.userId),
  ]);
  const reconfirmDays = await getSetting('auth.contact_reconfirm_days');
  const confirmedAt = user?.contactConfirmedAt ? new Date(user.contactConfirmedAt).getTime() : 0;
  const unread = await one<{ n: number }>(
    `select count(*)::int as n from notifications where user_id = $1 and channel = 'in_app' and read_at is null`,
    [auth.userId],
  );
  return {
    user,
    activeRole: auth.role,
    activeOrgId: auth.orgId,
    isInternal: auth.isInternal,
    roles,
    permissions: [...auth.permissions].sort(),
    person: summary.person,
    consentVersion: summary.consentVersion,
    needsContactReconfirm: Date.now() - confirmedAt > reconfirmDays * 86_400_000,
    unreadNotifications: unread?.n ?? 0,
  };
});

m.route(
  {
    method: 'post', path: '/switch-role', summary: 'Switch active role without signing out (FR-AUTH-07)', access: 'user',
    body: z.object({ role: z.string(), orgId: z.string().uuid().nullable().default(null) }),
  },
  async ({ body, auth, ip }) => {
    const held = auth.roles.find((r) => r.role === body.role && (r.orgId ?? null) === body.orgId);
    if (!held) throw badRequest('You do not hold that role.');
    const role = await one<{ is_internal: boolean }>('select is_internal from roles where code = $1', [body.role]);
    // A staff role always gets the 30-minute idle timeout; other roles keep the session's own.
    await query(
      `update sessions set active_role = $2, active_org_id = $3,
              idle_timeout_s = case when $4 then $5 else idle_timeout_s end
        where id = $1`,
      [auth.sessionId, body.role, body.orgId, Boolean(role?.is_internal), idleTimeoutFor(true, false, body.role)],
    );
    await audit({ actorId: auth.userId, action: 'auth.switch_role', entityType: 'user', entityId: auth.userId, ip, details: body });
    return { role: body.role, orgId: body.orgId, permissions: [...(await permissionsFor(body.role))] };
  },
);

// ---------------------------------------------------------------------------
// Password recovery (FR-AUTH-09) and change
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'post', path: '/password/forgot', summary: 'Start password recovery by SMS code or email link', access: 'public',
    body: z.object({ channel: z.enum(['sms', 'email']), mobile: zMobile.optional(), email: z.string().email().optional() }),
  },
  async ({ body }) => {
    const generic = { ok: true, message: 'If an account exists, we have sent instructions.' };
    if (body.channel === 'sms') {
      if (!body.mobile) throw badRequest('Enter your mobile number.');
      const u = await one<{ id: string; language: 'en' | 'dz' }>('select id, language from users where mobile = $1', [body.mobile]);
      if (!u) return generic;
      const otp = await issueOtp({ mobile: body.mobile, purpose: 'reset', userId: u.id, language: u.language });
      return { ...generic, ...(otp.devCode ? { devCode: otp.devCode } : {}) };
    }
    if (!body.email) throw badRequest('Enter your email address.');
    const u = await one<{ id: string }>('select id from users where lower(email) = lower($1)', [body.email]);
    if (!u) return generic;
    const token = randomToken();
    await query(
      `insert into password_reset_tokens (token_hash, user_id, expires_at) values ($1, $2, now() + interval '15 minutes')`,
      [sha256(token), u.id],
    );
    const link = `${env.WEB_URL}/reset-password?token=${token}`;
    await notify({ userId: u.id, code: 'password_reset', vars: { link }, channels: ['email'] });
    return { ...generic, ...(env.exposeOtp ? { devLink: link } : {}) };
  },
);

m.route(
  {
    method: 'post', path: '/password/reset', summary: 'Set a new password using an SMS code or email token', access: 'public',
    body: z.object({ mobile: zMobile.optional(), code: z.string().optional(), token: z.string().optional(), newPassword: zPassword }),
  },
  async ({ body, ip }) => {
    return tx(async (db) => {
      let userId: string;
      if (body.token) {
        const t = await one(
          `select user_id from password_reset_tokens where token_hash = $1 and used_at is null and expires_at > now() for update`,
          [sha256(body.token)],
          db,
        );
        if (!t) throw badRequest('This reset link has expired or was already used. Ask for a new one.');
        await db.query('update password_reset_tokens set used_at = now() where token_hash = $1', [sha256(body.token)]);
        userId = t.user_id;
      } else {
        if (!body.mobile || !body.code) throw badRequest('Enter your mobile number and the SMS code.');
        const r = await verifyOtp({ mobile: body.mobile, purpose: 'reset', code: body.code }, db);
        const u = await one<{ id: string }>('select id from users where mobile = $1', [body.mobile], db);
        if (!u) throw unauthorized();
        userId = r.userId ?? u.id;
        // A reset by SMS also proves the number still works (FR-AUTH-13).
        await db.query(`update users set contact_confirmed_at = now(), mobile_verified_at = coalesce(mobile_verified_at, now()) where id = $1`, [userId]);
        await db.query(`update person_profiles set contact_unverified = false, failed_contact_attempts = 0 where user_id = $1`, [userId]);
      }
      await db.query(
        `update users set password_hash = $2, failed_login_attempts = 0, locked_until = null where id = $1`,
        [userId, await hashPassword(body.newPassword)],
      );
      await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [userId]);
      await audit({ actorId: userId, action: 'auth.password_reset', entityType: 'user', entityId: userId, ip }, db);
      return { ok: true };
    });
  },
);

m.route(
  {
    method: 'post', path: '/password/change', summary: 'Change password', access: 'user',
    body: z.object({ currentPassword: z.string(), newPassword: zPassword }),
  },
  async ({ body, auth, ip }) => {
    const u = await one('select password_hash from users where id = $1', [auth.userId]);
    if (!u?.password_hash || !(await checkPassword(body.currentPassword, u.password_hash))) throw badRequest('Your current password is not correct.');
    await query('update users set password_hash = $2 where id = $1', [auth.userId, await hashPassword(body.newPassword)]);
    await query('update sessions set revoked_at = now() where user_id = $1 and id <> $2 and revoked_at is null', [auth.userId, auth.sessionId]);
    await audit({ actorId: auth.userId, action: 'auth.password_change', entityType: 'user', entityId: auth.userId, ip });
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// Mobile re-confirmation every 90 days (FR-AUTH-13)
// ---------------------------------------------------------------------------
m.route({ method: 'post', path: '/contact/reconfirm/start', summary: 'Send a code to re-confirm the mobile number', access: 'user' }, async ({ auth }) =>
  issueOtp({ mobile: auth.mobile, purpose: 'reconfirm', userId: auth.userId }),
);

m.route(
  { method: 'post', path: '/contact/reconfirm/complete', summary: 'Confirm the mobile number', access: 'user', body: z.object({ code: z.string().length(6) }) },
  async ({ auth, body }) => {
    await tx(async (db) => {
      await verifyOtp({ mobile: auth.mobile, purpose: 'reconfirm', code: body.code }, db);
      await db.query('update users set contact_confirmed_at = now() where id = $1', [auth.userId]);
      await db.query(
        `update person_profiles set contact_unverified = false, failed_contact_attempts = 0, last_contact_at = now() where user_id = $1`,
        [auth.userId],
      );
    });
    return { ok: true };
  },
);

// ---------------------------------------------------------------------------
// Preferences and own data (FR-NOT-01, FR-AUTH-15)
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'put', path: '/preferences', summary: 'Notification channels and language', access: 'user',
    body: z.object({ sms: z.boolean(), email: z.boolean(), inApp: z.boolean(), language: z.enum(['en', 'dz']), mfaEnabled: z.boolean().optional() }),
  },
  async ({ auth, body }) => {
    await query(
      `insert into notification_preferences (user_id, sms, email, in_app) values ($1, $2, $3, $4)
       on conflict (user_id) do update set sms = excluded.sms, email = excluded.email, in_app = excluded.in_app`,
      [auth.userId, body.sms, body.email, body.inApp],
    );
    await query('update users set language = $2, mfa_enabled = coalesce($3, mfa_enabled) where id = $1', [auth.userId, body.language, body.mfaEnabled ?? null]);
    return { ok: true };
  },
);

m.route({ method: 'get', path: '/preferences', summary: 'Read notification preferences', access: 'user' }, async ({ auth }) => {
  const p = await one(
    `select coalesce(p.sms, true) as sms, coalesce(p.email, true) as email, coalesce(p.in_app, true) as "inApp",
            u.language, u.mfa_enabled as "mfaEnabled"
       from users u left join notification_preferences p on p.user_id = u.id where u.id = $1`,
    [auth.userId],
  );
  return p;
});

m.route({ method: 'get', path: '/my-data', summary: 'Download my personal data (FR-AUTH-15)', access: 'user' }, async ({ auth, res, ip }) => {
  const user = await one('select id, mobile, email, full_name, language, created_at, last_login_at from users where id = $1', [auth.userId]);
  const person = await one(
    `select id, full_name, mobile, email, cid_last4, date_of_birth, gender, dzongkhag_id, gewog_id, village, expected_wage,
            available_from, preferred_roles, languages, stage, lifecycle, created_at
       from person_profiles where user_id = $1`,
    [auth.userId],
  );
  const consents = await query('select version, scope, accepted_at from consents where user_id = $1', [auth.userId]);
  const applications = person ? await query('select vacancy_id, stage, applied_at from applications where person_id = $1', [person.id]) : [];
  await audit({ actorId: auth.userId, action: 'data.export_self', entityType: 'user', entityId: auth.userId, ip });
  res.setHeader('content-disposition', 'attachment; filename="btbg-my-data.json"');
  return { exportedAt: new Date().toISOString(), user, person, consents, applications };
});

m.route(
  {
    method: 'post', path: '/my-data/deletion-request', summary: 'Request deletion of personal data', access: 'user',
    body: z.object({ reason: z.string().max(500).optional() }),
  },
  async ({ auth, body }) => {
    const sla = (await getSetting('helpdesk.sla')).normal;
    const ref = await one<{ ref: string }>(`select 'T' || lpad(nextval('ticket_ref_seq')::text, 6, '0') as ref`);
    await query(
      `insert into helpdesk_tickets (ref, user_id, category, priority, subject, response_due, resolution_due)
       values ($1, $2, 'account', 'normal', 'Personal data deletion request',
               now() + make_interval(hours => $3), now() + make_interval(hours => $4))`,
      [ref!.ref, auth.userId, sla.response_h, sla.resolution_h],
    );
    await query(
      `insert into ticket_messages (ticket_id, author_id, author_kind, body)
       select id, $2, 'user', $3 from helpdesk_tickets where ref = $1`,
      [ref!.ref, auth.userId, `Please delete my personal data. ${body.reason ?? ''}\nNote: employment and payroll records are kept for the legal retention period.`],
    );
    return { ok: true, ticketRef: ref!.ref };
  },
);

export function _resetCaches() {
  clearPermissionCache();
}
