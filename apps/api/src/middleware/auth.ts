import type { Request } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env.js';
import { one, query } from '../db/pool.js';
import { AppError } from '../lib/errors.js';

export const SESSION_COOKIE = 'btbg_session';

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: string;
  orgId: string | null;
  roles: Array<{ role: string; orgId: string | null; orgName: string | null }>;
  permissions: Set<string>;
  isInternal: boolean;
  fullName: string;
  mobile: string;
  mfaPassed: boolean;
}

type TokenPayload = { sid: string; uid: string };

export function signSessionToken(sessionId: string, userId: string) {
  return jwt.sign({ sid: sessionId, uid: userId } satisfies TokenPayload, env.JWT_SECRET, { expiresIn: '30d', issuer: 'btbg' });
}

function readToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return (req.cookies?.[SESSION_COOKIE] as string | undefined) ?? null;
}

// Role permission sets change rarely; cache them briefly.
let permCache: { at: number; map: Map<string, Set<string>> } | null = null;
export function clearPermissionCache() {
  permCache = null;
}
export async function permissionsFor(role: string): Promise<Set<string>> {
  if (!permCache || Date.now() - permCache.at > 60_000) {
    const rows = await query<{ role_code: string; permission: string }>('select role_code, permission from role_permissions');
    const map = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!map.has(r.role_code)) map.set(r.role_code, new Set());
      map.get(r.role_code)!.add(r.permission);
    }
    permCache = { at: Date.now(), map };
  }
  return permCache.map.get(role) ?? new Set();
}

/**
 * Resolve the caller from the session cookie or bearer token. Returns null for
 * anonymous callers. Enforces idle timeout (NFR-SEC-04), suspension and MFA.
 */
export async function authenticate(req: Request, opts: { allowPendingMfa?: boolean } = {}): Promise<AuthContext | null> {
  if ((req as any)._auth !== undefined && !opts.allowPendingMfa) return (req as any)._auth;
  const token = readToken(req);
  if (!token) return null;
  let payload: TokenPayload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET, { issuer: 'btbg' }) as TokenPayload;
  } catch {
    return null;
  }
  const s = await one(
    `select s.id, s.user_id, s.active_role, s.active_org_id, s.mfa_passed, s.idle_timeout_s, s.revoked_at,
            extract(epoch from (now() - s.last_seen_at)) as idle_s,
            u.status, u.full_name, u.mobile
       from sessions s join users u on u.id = s.user_id
      where s.id = $1 and s.user_id = $2`,
    [payload.sid, payload.uid],
  );
  if (!s || s.revoked_at) return null;
  if (Number(s.idle_s) > s.idle_timeout_s) {
    await query('update sessions set revoked_at = now() where id = $1', [s.id]);
    throw new AppError(401, 'session_expired', 'Your session timed out after inactivity. Please sign in again.');
  }
  if (s.status === 'suspended') throw new AppError(403, 'suspended', 'This account is suspended. Contact BTBG for help.');
  if (!s.mfa_passed && !opts.allowPendingMfa) {
    throw new AppError(401, 'mfa_required', 'Enter the code we sent to your phone to finish signing in.');
  }
  if (Number(s.idle_s) > 60) await query('update sessions set last_seen_at = now() where id = $1', [s.id]);

  const roles = await query<{ role: string; orgId: string | null; orgName: string | null; is_internal: boolean }>(
    `select ur.role_code as role, ur.org_id as "orgId", o.name as "orgName", r.is_internal
       from user_roles ur join roles r on r.code = ur.role_code
       left join organisations o on o.id = ur.org_id
      where ur.user_id = $1 order by r.is_internal desc, ur.created_at`,
    [s.user_id],
  );
  // Roles can be revoked while a session is live; fall back safely.
  const active = roles.find((r) => r.role === s.active_role && (r.orgId ?? null) === (s.active_org_id ?? null)) ?? roles[0];
  if (!active) return null;

  const ctx: AuthContext = {
    userId: s.user_id,
    sessionId: s.id,
    role: active.role,
    orgId: active.orgId,
    roles: roles.map(({ role, orgId, orgName }) => ({ role, orgId, orgName })),
    permissions: await permissionsFor(active.role),
    isInternal: active.is_internal,
    fullName: s.full_name,
    mobile: s.mobile,
    mfaPassed: s.mfa_passed,
  };
  if (!opts.allowPendingMfa) (req as any)._auth = ctx;
  return ctx;
}

/** Host routes: the caller's organisation, or a 403. */
export function requireOrg(auth: AuthContext): string {
  if (!auth.orgId || !['host_owner', 'host_supervisor'].includes(auth.role)) {
    throw new AppError(403, 'forbidden', 'Switch to your host employer role to do this.');
  }
  return auth.orgId;
}
