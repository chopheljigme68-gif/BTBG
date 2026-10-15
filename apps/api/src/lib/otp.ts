import { env } from '../config/env.js';
import { type Db, one, pool } from '../db/pool.js';
import { randomDigits, safeEqual, sha256 } from './crypto.js';
import { AppError, badRequest } from './errors.js';
import { notify } from './notify.js';

export type OtpPurpose =
  | 'register' | 'login_mfa' | 'reset' | 'reconfirm' | 'assisted_register'
  | 'sign_contract' | 'sign_hpa' | 'host_confirm_vacancy' | 'change_mobile';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;
const MAX_PER_HOUR = 6;

// Demo only: when DEMO_ACCEPT_ANY_OTP=true, any code typed in is accepted and the hourly
// limit is skipped, so the system can be shown without an SMS gateway. Turn it off before real use.
const acceptAnyCode = process.env.DEMO_ACCEPT_ANY_OTP === 'true';

const hashCode = (mobile: string, purpose: string, code: string) => sha256(`${purpose}:${mobile}:${code}`);

/**
 * Issue an SMS one-time password. In development, with DEV_EXPOSE_OTP=true,
 * the code is returned to the caller so the flows can be tried without an SMS gateway.
 */
export async function issueOtp(
  input: { mobile: string; purpose: OtpPurpose; userId?: string | null; refId?: string | null; language?: 'en' | 'dz' },
  db: Db = pool,
): Promise<{ sentTo: string; devCode?: string }> {
  const recent = await one<{ n: number }>(
    `select count(*)::int as n from otp_codes where mobile = $1 and created_at > now() - interval '1 hour'`,
    [input.mobile],
    db,
  );
  if (!acceptAnyCode && (recent?.n ?? 0) >= MAX_PER_HOUR) {
    throw new AppError(429, 'otp_rate_limited', 'Too many codes were requested. Please wait an hour and try again.');
  }
  const code = randomDigits(6);
  await db.query(
    `update otp_codes set consumed_at = now() where mobile = $1 and purpose = $2 and consumed_at is null`,
    [input.mobile, input.purpose],
  );
  await db.query(
    `insert into otp_codes (mobile, user_id, purpose, ref_id, code_hash, expires_at)
     values ($1, $2, $3, $4, $5, now() + make_interval(mins => $6))`,
    [input.mobile, input.userId ?? null, input.purpose, input.refId ?? null, hashCode(input.mobile, input.purpose, code), TTL_MIN],
  );
  await notify({ mobile: input.mobile, language: input.language, code: 'otp', vars: { code }, channels: ['sms'] }, db);
  return { sentTo: `${input.mobile.slice(0, -4).replace(/\d/g, '•')}${input.mobile.slice(-4)}`, ...(env.exposeOtp ? { devCode: code } : {}) };
}

export async function verifyOtp(
  input: { mobile: string; purpose: OtpPurpose; code: string; refId?: string | null },
  db: Db = pool,
): Promise<{ userId: string | null; refId: string | null }> {
  const row = await one(
    `select id, code_hash, attempts, expires_at < now() as expired, user_id, ref_id
       from otp_codes
      where mobile = $1 and purpose = $2 and consumed_at is null
        and ($3::uuid is null or ref_id = $3)
      order by created_at desc limit 1`,
    [input.mobile, input.purpose, input.refId ?? null],
    db,
  );
  if (!row) throw badRequest('No active code found. Ask for a new code.');
  if (row.expired) throw badRequest('This code has expired. Ask for a new code.');
  if (!acceptAnyCode && row.attempts >= MAX_ATTEMPTS) throw badRequest('Too many wrong attempts. Ask for a new code.');
  if (!acceptAnyCode && !safeEqual(row.code_hash, hashCode(input.mobile, input.purpose, input.code.trim()))) {
    // Count the failure outside the caller's transaction so a rollback cannot erase it.
    await pool.query('update otp_codes set attempts = attempts + 1 where id = $1', [row.id]);
    throw badRequest('That code is not correct. Check the SMS and try again.');
  }
  await db.query('update otp_codes set consumed_at = now() where id = $1', [row.id]);
  return { userId: row.user_id, refId: row.ref_id };
}
