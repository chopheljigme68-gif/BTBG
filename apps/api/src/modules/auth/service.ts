import bcrypt from 'bcryptjs';
import type { Response } from 'express';
import { env } from '../../config/env.js';
import { type Db, one, pool, query } from '../../db/pool.js';
import { SESSION_COOKIE, signSessionToken } from '../../middleware/auth.js';

export const STAFF_IDLE_S = 30 * 60;
const DAY_S = 24 * 60 * 60;

export const hashPassword = (pw: string) => bcrypt.hash(pw, 12);
export const checkPassword = (pw: string, hash: string) => bcrypt.compare(pw, hash);

/** MFA is mandatory for internal staff and host owners (FR-AUTH-08). */
export async function mfaRequired(userId: string, db: Db = pool): Promise<boolean> {
  const r = await one<{ required: boolean }>(
    `select u.mfa_enabled or exists (
        select 1 from user_roles ur join roles r on r.code = ur.role_code
         where ur.user_id = u.id and (r.is_internal or ur.role_code = 'host_owner')) as required
       from users u where u.id = $1`,
    [userId],
    db,
  );
  return Boolean(r?.required);
}

export async function defaultRole(userId: string, db: Db = pool) {
  return one<{ role_code: string; org_id: string | null; is_internal: boolean }>(
    `select ur.role_code, ur.org_id, r.is_internal from user_roles ur join roles r on r.code = ur.role_code
      where ur.user_id = $1
      order by r.is_internal desc,
               array_position(array['host_owner','host_supervisor','job_seeker'], ur.role_code) nulls first,
               ur.created_at
      limit 1`,
    [userId],
    db,
  );
}

/** Idle timeout per NFR-SEC-04: staff 30 minutes, others 7 days on a trusted device. */
export function idleTimeoutFor(isInternal: boolean, trustedDevice: boolean, role: string) {
  if (isInternal) return STAFF_IDLE_S;
  if (trustedDevice) return 7 * DAY_S;
  return role === 'job_seeker' ? DAY_S : 12 * 60 * 60;
}

export async function createSession(
  res: Response,
  input: { userId: string; trustedDevice: boolean; mfaPassed: boolean; ip: string | null; userAgent?: string },
  db: Db = pool,
) {
  const role = await defaultRole(input.userId, db);
  if (!role) throw new Error('User has no role');
  const s = await one<{ id: string }>(
    `insert into sessions (user_id, active_role, active_org_id, mfa_passed, idle_timeout_s, ip, user_agent)
     values ($1, $2, $3, $4, $5, $6, $7) returning id`,
    [
      input.userId, role.role_code, role.org_id, input.mfaPassed,
      idleTimeoutFor(role.is_internal, input.trustedDevice, role.role_code),
      input.ip, input.userAgent?.slice(0, 300) ?? null,
    ],
    db,
  );
  const token = signSessionToken(s!.id, input.userId);
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: env.cookieSecure,
    sameSite: 'lax',
    path: '/',
    maxAge: 30 * DAY_S * 1000,
  });
  return { sessionId: s!.id, token, role: role.role_code };
}

export async function recordLogin(userId: string, db: Db = pool) {
  await db.query(
    `update users set failed_login_attempts = 0, locked_until = null, last_login_at = now() where id = $1`,
    [userId],
  );
}

export async function profileSummary(userId: string) {
  const [person, consentRow] = await Promise.all([
    one(
      `select id, stage, lifecycle, contact_unverified, preferred_career_id from person_profiles where user_id = $1`,
      [userId],
    ),
    one(`select version from consents where user_id = $1 order by accepted_at desc limit 1`, [userId]),
  ]);
  return { person, consentVersion: consentRow?.version ?? null };
}

export async function rolesOf(userId: string) {
  return query(
    `select ur.role_code as role, r.name as "roleName", ur.org_id as "orgId", o.name as "orgName",
            o.verification_status as "orgVerification"
       from user_roles ur join roles r on r.code = ur.role_code left join organisations o on o.id = ur.org_id
      where ur.user_id = $1 order by r.is_internal desc, ur.created_at`,
    [userId],
  );
}
