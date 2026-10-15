import { z } from 'zod';
import { type Db, one, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { displayDateTime } from '../../lib/dates.js';
import { badRequest, forbidden, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zMobile, zPage } from '../../lib/http.js';
import { notify } from '../../lib/notify.js';
import { getSetting } from '../../lib/settings.js';
import { CATEGORIES as GRIEVANCE_CATEGORIES, addAction, createGrievance } from '../grievances/service.js';
import { personForUser } from '../people/service.js';

/** Helpdesk ticketing (SRS 3.3.10, Workflow 8). */
const m = createModule('/helpdesk', 'Helpdesk');
export default m;

const AGENT = { any: ['helpdesk.handle'] };
const CATEGORY = ['account', 'technical', 'payment', 'placement', 'other'] as const;
const PRIORITY_BY_CATEGORY: Record<string, 'low' | 'normal' | 'high' | 'urgent'> = { payment: 'high', placement: 'high', account: 'normal', technical: 'normal', other: 'low' };

/** Least-loaded helpdesk agent (FR-HLP-02). */
async function pickAgent(db: Db) {
  const r = await one<{ id: string }>(
    `select u.id from users u join user_roles ur on ur.user_id = u.id and ur.role_code = 'helpdesk_agent' where u.status = 'active'
      order by (select count(*) from helpdesk_tickets t where t.assignee_id = u.id and t.status in ('open','in_progress','awaiting_user')), u.created_at limit 1`, [], db);
  return r?.id ?? null;
}

m.route({ method: 'post', path: '/tickets', summary: 'Open a support ticket from any page (visitors too)', access: 'optional',
  body: z.object({
    category: z.enum(CATEGORY), subject: z.string().trim().min(3).max(140), message: z.string().trim().min(5).max(5000), pageUrl: z.string().max(300).optional(),
    contactName: z.string().max(120).optional(), contactMobile: zMobile.optional(), contactEmail: z.string().email().optional(),
  }) },
async ({ body, auth }) => {
  if (!auth && !body.contactMobile && !body.contactEmail) throw badRequest('Give a mobile number or email so we can reply.');
  return tx(async (db) => {
    const priority = PRIORITY_BY_CATEGORY[body.category];
    const sla = (await getSetting('helpdesk.sla', db))[priority];
    const agent = await pickAgent(db);
    const t = await one(
      `insert into helpdesk_tickets (ref, user_id, contact_name, contact_mobile, contact_email, category, priority, subject, assignee_id, page_url, response_due, resolution_due)
       values ('T' || lpad(nextval('ticket_ref_seq')::text, 6, '0'), $1, $2, $3, $4, $5, $6, $7, $8, $9, now() + make_interval(hours => $10), now() + make_interval(hours => $11))
       returning id, ref, response_due`,
      [auth?.userId ?? null, body.contactName ?? auth?.fullName ?? null, body.contactMobile ?? auth?.mobile ?? null, body.contactEmail ?? null, body.category, priority,
        body.subject, agent, body.pageUrl ?? null, sla.response_h, sla.resolution_h], db);
    await db.query(`insert into ticket_messages (ticket_id, author_id, author_kind, body) values ($1, $2, 'user', $3)`, [t!.id, auth?.userId ?? null, body.message]);
    await notify({ userId: auth?.userId ?? null, mobile: auth ? undefined : body.contactMobile, email: body.contactEmail, code: 'ticket_created',
      vars: { ref: t!.ref, subject: body.subject, due: displayDateTime(t!.response_due) }, channels: auth ? ['in_app'] : body.contactMobile ? ['sms'] : ['email'] }, db);
    if (agent) await notify({ userId: agent, code: 'generic', channels: ['in_app'], vars: { subject: `Ticket ${t!.ref}`, body: body.subject } }, db);
    return { id: t!.id, ref: t!.ref, responseDue: t!.response_due };
  });
});

m.route({ method: 'get', path: '/tickets/track', summary: 'Track a ticket by reference and contact (visitors)', access: 'public',
  query: z.object({ ref: z.string().min(3), contact: z.string().min(3) }) },
async ({ query: q }) => {
  const t = await one(
    `select ref, subject, status, created_at as "createdAt", response_due as "responseDue" from helpdesk_tickets
      where ref = upper($1) and (contact_mobile like '%' || right($2, 8) or lower(contact_email) = lower($2))`, [q.ref, q.contact]);
  if (!t) throw notFound('Ticket');
  return t;
});

// Signed-in users ------------------------------------------------------------
m.route({ method: 'get', path: '/tickets/mine', summary: 'My tickets', access: 'user' }, async ({ auth }) =>
  query(`select id, ref, category, subject, status, created_at as "createdAt", updated_at as "updatedAt" from helpdesk_tickets where user_id = $1 order by created_at desc`, [auth.userId]),
);

async function myTicket(id: string, userId: string) {
  const t = await one('select * from helpdesk_tickets where id = $1 and user_id = $2', [id, userId]);
  if (!t) throw notFound('Ticket');
  return t;
}

m.route({ method: 'get', path: '/tickets/mine/:id', summary: 'My ticket and messages', access: 'user' }, async ({ auth, params }) => {
  const t = await myTicket(params.id, auth.userId);
  const messages = await query(`select author_kind as "authorKind", body, created_at as "at" from ticket_messages where ticket_id = $1 order by created_at`, [t.id]);
  return { id: t.id, ref: t.ref, subject: t.subject, category: t.category, status: t.status, createdAt: t.created_at, satisfaction: t.satisfaction, messages };
});

m.route({ method: 'post', path: '/tickets/mine/:id/messages', summary: 'Reply on my ticket', access: 'user', body: z.object({ body: z.string().min(1).max(5000) }) },
  async ({ auth, params, body }) => {
    const t = await myTicket(params.id, auth.userId);
    if (['closed', 'converted'].includes(t.status)) throw ruleViolation('This ticket is closed. Open a new one if you still need help.');
    await query(`insert into ticket_messages (ticket_id, author_id, author_kind, body) values ($1, $2, 'user', $3)`, [t.id, auth.userId, body.body]);
    await query(`update helpdesk_tickets set status = case when status in ('awaiting_user','resolved') then 'open' else status end where id = $1`, [t.id]);
    return { ok: true };
  });

m.route({ method: 'post', path: '/tickets/mine/:id/confirm', summary: 'Confirm resolved and rate the help', access: 'user', body: z.object({ satisfaction: z.number().int().min(1).max(5) }) },
  async ({ auth, params, body }) => {
    const t = await myTicket(params.id, auth.userId);
    if (t.status !== 'resolved') throw ruleViolation('You can confirm once the helpdesk marks the ticket resolved.');
    await query(`update helpdesk_tickets set status = 'closed', closed_at = now(), satisfaction = $2 where id = $1`, [t.id, body.satisfaction]);
    return { ok: true };
  });

// Agents ---------------------------------------------------------------------
m.route({ method: 'get', path: '/tickets', summary: 'Ticket queue', access: AGENT,
  query: zPage.extend({ status: z.string().optional(), mine: z.enum(['true']).optional() }) },
async ({ query: q, auth }) => {
  const rows = await query(
    `select t.id, t.ref, t.category, t.priority, t.subject, t.status, t.created_at as "createdAt", t.response_due as "responseDue", t.resolution_due as "resolutionDue",
            t.first_response_at is null and t.response_due < now() as "responseBreached",
            t.status not in ('resolved','closed','converted') and t.resolution_due < now() as "resolutionBreached",
            coalesce(u.full_name, t.contact_name) as requester, a.full_name as assignee, count(*) over() as total
       from helpdesk_tickets t left join users u on u.id = t.user_id left join users a on a.id = t.assignee_id
      where ($1::text is null or t.status = $1) and ($2::uuid is null or t.assignee_id = $2)
        and ($3::text is null or t.ref ilike '%' || $3 || '%' or t.subject ilike '%' || $3 || '%')
      order by t.status in ('resolved','closed','converted'), case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.created_at
      ${pageClause(q)}`,
    [q.status ?? null, q.mine ? auth.userId : null, q.q ?? null]);
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
});

m.route({ method: 'get', path: '/tickets/:id', summary: 'Ticket detail for agents', access: AGENT }, async ({ params }) => {
  const t = await one(`select t.*, u.full_name as user_name, a.full_name as assignee_name from helpdesk_tickets t left join users u on u.id = t.user_id left join users a on a.id = t.assignee_id where t.id = $1`, [params.id]);
  if (!t) throw notFound('Ticket');
  const messages = await query(`select m.author_kind as "authorKind", m.body, m.created_at as "at", u.full_name as author from ticket_messages m left join users u on u.id = m.author_id where m.ticket_id = $1 order by m.created_at`, [params.id]);
  return { ...t, messages };
});

m.route({ method: 'post', path: '/tickets/:id/reply', summary: 'Reply to the requester', access: AGENT,
  body: z.object({ body: z.string().min(1).max(5000), status: z.enum(['in_progress', 'awaiting_user', 'resolved']).default('awaiting_user') }) },
async ({ params, body, auth }) =>
  tx(async (db) => {
    const t = await one('select * from helpdesk_tickets where id = $1 for update', [params.id], db);
    if (!t) throw notFound('Ticket');
    if (['closed', 'converted'].includes(t.status)) throw ruleViolation('This ticket is closed.');
    await db.query(`insert into ticket_messages (ticket_id, author_id, author_kind, body) values ($1, $2, 'agent', $3)`, [t.id, auth.userId, body.body]);
    await db.query(
      `update helpdesk_tickets set status = $2, first_response_at = coalesce(first_response_at, now()), assignee_id = coalesce(assignee_id, $3),
              resolved_at = case when $2 = 'resolved' then now() else resolved_at end where id = $1`, [t.id, body.status, auth.userId]);
    await notify({ userId: t.user_id, mobile: t.user_id ? undefined : t.contact_mobile, email: t.user_id ? undefined : t.contact_email, code: 'ticket_reply', vars: { ref: t.ref } }, db);
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/tickets/:id/assign', summary: 'Assign a ticket', access: AGENT, body: z.object({ assigneeId: z.string().uuid() }) }, async ({ params, body }) => {
  await query('update helpdesk_tickets set assignee_id = $2 where id = $1', [params.id, body.assigneeId]);
  return { ok: true };
});

/** One action converts a ticket that reveals a labour dispute into a grievance, keeping the history (FR-HLP-04). */
m.route({ method: 'post', path: '/tickets/:id/convert', summary: 'Convert to a grievance case', access: AGENT,
  body: z.object({ category: z.enum(GRIEVANCE_CATEGORIES), placementId: z.string().uuid().optional(), againstOrgId: z.string().uuid().optional(), shareIdentity: z.boolean().default(false) }) },
async ({ params, body, auth, ip }) =>
  tx(async (db) => {
    const t = await one('select * from helpdesk_tickets where id = $1 for update', [params.id], db);
    if (!t) throw notFound('Ticket');
    if (t.status === 'converted') throw ruleViolation('Already converted.');
    const messages = await query(`select author_kind, body, created_at from ticket_messages where ticket_id = $1 order by created_at`, [t.id], db);
    const person = t.user_id ? await personForUser(t.user_id, db) : null;
    const isHost = t.user_id ? Boolean(await one(`select 1 from user_roles where user_id = $1 and role_code in ('host_owner','host_supervisor')`, [t.user_id], db)) : false;
    const g = await createGrievance({
      complainantUserId: t.user_id, complainantPersonId: person?.id ?? null,
      complainantParty: isHost ? 'host' : person ? (person.lifecycle === 'apprentice' ? 'apprentice' : 'job_seeker') : 'other',
      complainantName: t.contact_name, complainantMobile: t.contact_mobile, ticketId: t.id, channel: 'helpdesk', category: body.category,
      subject: t.subject, description: messages.filter((m) => m.author_kind === 'user').map((m) => m.body).join('\n\n') || t.subject,
      placementId: body.placementId, againstOrgId: body.againstOrgId, shareIdentity: body.shareIdentity, createdBy: auth.userId,
    }, db);
    for (const msg of messages) await addAction(g.id, null, `ticket_${msg.author_kind}_message`, `[${new Date(msg.created_at).toISOString().slice(0, 16)}] ${msg.body}`, false, db);
    await db.query(`update helpdesk_tickets set status = 'converted', grievance_id = $2, closed_at = now() where id = $1`, [t.id, g.id]);
    await db.query(`insert into ticket_messages (ticket_id, author_id, author_kind, body) values ($1, $2, 'system', $3)`, [t.id, auth.userId, `Converted to grievance ${g.ref}. A Grievance Officer will contact you.`]);
    await audit({ actorId: auth.userId, action: 'helpdesk.converted_to_grievance', entityType: 'ticket', entityId: t.id, ip, details: { grievance: g.ref } }, db);
    return g;
  }),
);

m.route({ method: 'get', path: '/agents', summary: 'Helpdesk agents', access: AGENT }, async ({ auth }) => {
  if (!auth.isInternal) throw forbidden();
  return query(`select u.id, u.full_name as "fullName" from users u join user_roles ur on ur.user_id = u.id where ur.role_code in ('helpdesk_agent','operations_manager') and u.status = 'active' order by 2`);
});
