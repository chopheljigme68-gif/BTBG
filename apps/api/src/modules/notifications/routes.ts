import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { hmac, safeEqual } from '../../lib/crypto.js';
import { unauthorized } from '../../lib/errors.js';
import { createModule } from '../../lib/http.js';
import { logger } from '../../lib/logger.js';
import { notify } from '../../lib/notify.js';
import { createGrievance } from '../grievances/service.js';

/** In-app inbox (FR-NOT-01) and SMS gateway webhooks (delivery reports, keyword intake). */
const m = createModule('/notifications', 'Notifications');
export default m;

m.route({ method: 'get', path: '/', summary: 'My in-app messages', access: 'user', query: z.object({ unread: z.coerce.boolean().optional() }) }, async ({ auth, query: q }) => {
  const [items, count] = await Promise.all([
    query(`select id, subject, body, link, template_code as code, read_at as "readAt", created_at as "createdAt" from notifications
            where user_id = $1 and channel = 'in_app' and ($2::boolean is not true or read_at is null) order by created_at desc limit 100`, [auth.userId, q.unread ?? null]),
    one(`select count(*)::int as n from notifications where user_id = $1 and channel = 'in_app' and read_at is null`, [auth.userId]),
  ]);
  return { items, unread: count!.n };
});

m.route({ method: 'post', path: '/read', summary: 'Mark messages read (all when no ids are given)', access: 'user', body: z.object({ ids: z.array(z.string().uuid()).optional() }) },
  async ({ auth, body }) => {
    await query(`update notifications set read_at = now(), status = 'read' where user_id = $1 and channel = 'in_app' and read_at is null and ($2::uuid[] is null or id = any($2))`,
      [auth.userId, body.ids ?? null]);
    return { ok: true };
  });

/** Gateways sign the raw body with HMAC-SHA256 using WEBHOOK_SECRET (SRS 3.1.3). */
function verifySignature(req: { headers: Record<string, unknown>; rawBody?: string }) {
  const sig = String(req.headers['x-btbg-signature'] ?? '').replace(/^sha256=/, '');
  if (!sig || !safeEqual(sig, hmac(req.rawBody ?? ''))) throw unauthorized('Invalid webhook signature.');
}

m.route({ method: 'post', path: '/webhooks/sms-status', summary: 'SMS delivery report from the gateway', access: 'public',
  body: z.object({ id: z.string(), status: z.enum(['delivered', 'failed', 'sent']), error: z.string().optional() }) },
async ({ req, body }) => {
  verifySignature(req as any);
  await query(`update notifications set status = $2, last_error = coalesce($3, last_error) where provider_ref = $1 and channel = 'sms'`, [body.id, body.status, body.error ?? null]);
  return { ok: true };
});

/**
 * Inbound SMS (FR-FDB-02): "HELP <message>" or "COMPLAINT <message>" opens a
 * grievance for people without the app; anything else gets usage instructions.
 */
m.route({ method: 'post', path: '/webhooks/sms-inbound', summary: 'Inbound SMS keyword intake', access: 'public',
  body: z.object({ from: z.string(), text: z.string().max(1000) }) },
async ({ req, body }) => {
  verifySignature(req as any);
  const mobile = body.from.startsWith('+') ? body.from : `+975${body.from.replace(/^975/, '')}`;
  const [keyword, ...rest] = body.text.trim().split(/\s+/);
  const message = rest.join(' ').trim();
  if (!/^(help|complaint|grievance|concern)$/i.test(keyword ?? '') || message.length < 5) {
    await notify({ mobile, code: 'generic', channels: ['sms'], vars: { subject: 'BTBG', body: 'To raise a concern, reply COMPLAINT followed by your message. For other help call the BTBG helpdesk.' } });
    return { ok: true, handled: false };
  }
  return tx(async (db) => {
    const user = await one(`select u.id, u.full_name, p.id as person_id,
                                   (select pl.id from placements pl where pl.person_id = p.id and pl.status in ('active','ending') order by pl.start_date desc limit 1) as placement_id
                              from users u left join person_profiles p on p.user_id = u.id where u.mobile = $1`, [mobile], db);
    const g = await createGrievance({
      complainantUserId: user?.id ?? null, complainantPersonId: user?.person_id ?? null, complainantParty: user?.placement_id ? 'apprentice' : user?.person_id ? 'job_seeker' : 'other',
      complainantName: user?.full_name ?? null, complainantMobile: mobile, placementId: user?.placement_id ?? null, channel: 'sms', category: 'other',
      subject: message.slice(0, 80), description: message, shareIdentity: false,
    }, db);
    logger.info({ ref: g.ref }, 'grievance opened from SMS');
    return { ok: true, handled: true, ref: g.ref };
  });
});
