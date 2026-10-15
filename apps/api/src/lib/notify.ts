import nodemailer from 'nodemailer';
import { env } from '../config/env.js';
import { type Db, one, pool, query } from '../db/pool.js';
import { logger } from './logger.js';

/**
 * Notification service (FR-NOT-01..04).
 * - Messages are rendered from staff-managed templates in English or Dzongkha.
 * - Rows are written inside the caller's transaction, then dispatched by a
 *   background sender, so a rolled-back action never sends a message.
 * - Critical messages always go by SMS, whatever the user's preference.
 */
export type Channel = 'in_app' | 'sms' | 'email';

export const CRITICAL_CODES = new Set([
  'otp', 'payslip', 'interview_booked', 'interview_reminder', 'grievance_created', 'grievance_update',
  'contract_to_sign', 'hpa_to_sign',
]);

type Recipient = { userId?: string | null; mobile?: string | null; email?: string | null; language?: 'en' | 'dz' };

export interface NotifyInput extends Recipient {
  code: string;
  vars?: Record<string, string | number | null | undefined>;
  channels?: Channel[];
  link?: string;
}

function render(text: string, vars: Record<string, unknown>) {
  return text.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] === undefined || vars[k] === null ? '' : String(vars[k])));
}

async function template(code: string, channel: Channel, language: string, db: Db) {
  return (
    (await one<{ subject: string | null; body: string }>(
      `select subject, body from notification_templates
        where code = $1 and channel = $2 and language = any($3)
        order by (language = $4) desc limit 1`,
      [code, channel, [language, 'en'], language],
      db,
    )) ??
    // Same message on another channel, so every code works on every channel.
    (await one<{ subject: string | null; body: string }>(
      `select subject, body from notification_templates where code = $1 and language in ($2, 'en')
        order by (language = $2) desc, (channel = 'in_app') desc limit 1`,
      [code, language],
      db,
    ))
  );
}

export async function notify(input: NotifyInput, db: Db = pool): Promise<void> {
  let { mobile, email, language } = input;
  let prefs = { sms: true, email: true, in_app: true };
  if (input.userId) {
    const u = await one(
      `select u.mobile, u.email, u.language, p.sms, p.email as email_pref, p.in_app
         from users u left join notification_preferences p on p.user_id = u.id where u.id = $1`,
      [input.userId],
      db,
    );
    if (u) {
      mobile ??= u.mobile;
      email ??= u.email;
      language ??= u.language;
      prefs = { sms: u.sms ?? true, email: u.email_pref ?? true, in_app: u.in_app ?? true };
    }
  }
  const lang = language ?? 'en';
  const critical = CRITICAL_CODES.has(input.code);

  let channels: Channel[] = input.channels ?? [
    ...(input.userId && prefs.in_app ? (['in_app'] as Channel[]) : []),
    ...(prefs.sms ? (['sms'] as Channel[]) : []),
    ...(prefs.email && email ? (['email'] as Channel[]) : []),
  ];
  if (critical && !channels.includes('sms')) channels.push('sms');
  channels = [...new Set(channels)].filter((c) => {
    if (c === 'in_app') return Boolean(input.userId);
    if (c === 'sms') return Boolean(mobile);
    return Boolean(email);
  });

  const vars = { ...input.vars };
  for (const channel of channels) {
    const t = await template(input.code, channel, lang, db);
    if (!t) {
      logger.warn({ code: input.code, channel }, 'no notification template');
      continue;
    }
    await db.query(
      `insert into notifications (user_id, channel, to_address, template_code, subject, body, link, status, sent_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, case when $2 = 'in_app' then now() end)`,
      [
        input.userId ?? null,
        channel,
        channel === 'sms' ? mobile : channel === 'email' ? email : null,
        input.code,
        t.subject ? render(t.subject, vars) : null,
        render(t.body, vars),
        input.link ?? null,
        channel === 'in_app' ? 'sent' : 'queued',
      ],
    );
  }
  scheduleDispatch();
}

/** Notify every active user holding a role (staff alerts). */
export async function notifyRole(role: string, input: Omit<NotifyInput, 'userId'>, db: Db = pool) {
  const users = await query<{ user_id: string }>(
    `select distinct ur.user_id from user_roles ur join users u on u.id = ur.user_id
      where ur.role_code = $1 and u.status = 'active'`,
    [role],
    db,
  );
  for (const u of users) await notify({ ...input, userId: u.user_id }, db);
}

// ---------------------------------------------------------------------------
// Providers (adapters, so gateways can change without touching business logic)
// ---------------------------------------------------------------------------
async function sendSms(to: string, body: string): Promise<string | null> {
  if (env.SMS_PROVIDER === 'console') {
    logger.info({ to, body }, 'SMS (console provider)');
    return null;
  }
  const res = await fetch(env.SMS_HTTP_URL!, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${env.SMS_HTTP_TOKEN ?? ''}` },
    body: JSON.stringify({ to, message: body, sender: env.SMS_SENDER_ID }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`SMS gateway responded ${res.status}`);
  const data = (await res.json().catch(() => ({}))) as { id?: string };
  return data.id ?? null;
}

let mailer: nodemailer.Transporter | null = null;
async function sendEmail(to: string, subject: string, body: string) {
  if (env.EMAIL_PROVIDER === 'console') {
    logger.info({ to, subject }, 'Email (console provider)');
    return;
  }
  mailer ??= nodemailer.createTransport(env.SMTP_URL);
  await mailer.sendMail({ from: env.EMAIL_FROM, to, subject, text: body });
}

let timer: NodeJS.Timeout | null = null;
function scheduleDispatch() {
  if (env.isTest || timer) return;
  timer = setTimeout(() => {
    timer = null;
    dispatchPending().catch((err) => logger.error({ err }, 'notification dispatch failed'));
  }, 100);
}

/** Send anything queued now (used by scripts before they exit). */
export async function flushNotifications() {
  if (timer) clearTimeout(timer);
  timer = null;
  return dispatchPending(1000);
}

/**
 * Send queued messages and retry failed SMS once (FR-NOT-04).
 * Uses SKIP LOCKED so several API instances can dispatch safely.
 */
export async function dispatchPending(limit = 100): Promise<number> {
  const client = await pool.connect();
  let sent = 0;
  try {
    await client.query('begin');
    const rows = await query(
      `select id, channel, to_address, subject, body from notifications
        where status = 'queued' or (status = 'failed' and channel = 'sms' and attempts < 2)
        order by created_at limit $1 for update skip locked`,
      [limit],
      client,
    );
    for (const n of rows) {
      try {
        let ref: string | null = null;
        if (n.channel === 'sms') ref = await sendSms(n.to_address, n.body);
        else if (n.channel === 'email') await sendEmail(n.to_address, n.subject ?? 'BTBG', n.body);
        await client.query(
          `update notifications set status = 'sent', attempts = attempts + 1, sent_at = now(), provider_ref = $2 where id = $1`,
          [n.id, ref],
        );
        sent++;
      } catch (err) {
        await client.query(
          `update notifications set status = 'failed', attempts = attempts + 1, last_error = $2 where id = $1`,
          [n.id, (err as Error).message],
        );
      }
    }
    await client.query('commit');
  } catch (err) {
    await client.query('rollback');
    throw err;
  } finally {
    client.release();
  }
  return sent;
}
