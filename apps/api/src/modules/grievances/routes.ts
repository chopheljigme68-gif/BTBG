import { z } from 'zod';
import { one, pool, query, tx } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { decrypt } from '../../lib/crypto.js';
import { badRequest, forbidden, notFound, ruleViolation } from '../../lib/errors.js';
import { createModule, pageClause, zMobile, zPage } from '../../lib/http.js';
import { notifyRole } from '../../lib/notify.js';
import type { AuthContext } from '../../middleware/auth.js';
import { personForUser } from '../people/service.js';
import { actionsFor, addAction, CATEGORIES, createGrievance, ESCALATION_STEPS, notifyComplainant, pickGrievanceOfficer } from './service.js';

/** Grievance redressal (SRS 3.3.9, 3.5.5, Workflow 6). */
const m = createModule('/grievances', 'Grievances and feedback');
export default m;

const STAFF = { any: ['grievances.handle', 'grievances.view_all', 'grievances.escalation'] };

// ---------------------------------------------------------------------------
// Lodging a concern: two taps from any screen (FR-EE-40), hosts too (FR-EMP-43)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/meta', summary: 'Categories, escalation steps and my placements to link', access: 'user' }, async ({ auth }) => {
  let placements: any[] = [];
  if (auth.role === 'job_seeker') {
    const p = await personForUser(auth.userId);
    if (p) placements = await query(`select pl.id, o.name as host, pl.role_title as "roleTitle", pl.status from placements pl join organisations o on o.id = pl.org_id where pl.person_id = $1 order by pl.created_at desc`, [p.id]);
  } else if (auth.orgId) {
    placements = await query(`select pl.id, p.full_name as apprentice, pl.role_title as "roleTitle", pl.status from placements pl join person_profiles p on p.id = pl.person_id where pl.org_id = $1 order by pl.created_at desc`, [auth.orgId]);
  }
  return { categories: CATEGORIES, escalationSteps: ESCALATION_STEPS, placements };
});

m.route({ method: 'post', path: '/', summary: 'Lodge a grievance', access: 'user',
  body: z.object({
    category: z.enum(CATEGORIES), subject: z.string().trim().min(3).max(140), description: z.string().trim().min(10).max(5000),
    placementId: z.string().uuid().optional(), againstOrgId: z.string().uuid().optional(), shareIdentity: z.boolean().default(false),
  }) },
async ({ auth, body }) =>
  tx(async (db) => {
    let party: 'apprentice' | 'job_seeker' | 'host' | 'other' = 'other';
    let personId: string | null = null;
    if (auth.role === 'job_seeker') {
      const p = await personForUser(auth.userId, db);
      personId = p?.id ?? null;
      party = p?.lifecycle === 'apprentice' ? 'apprentice' : 'job_seeker';
      if (body.placementId && !(await one('select 1 from placements where id = $1 and person_id = $2', [body.placementId, personId], db))) throw forbidden();
    } else if (auth.orgId) {
      party = 'host';
      if (body.placementId && !(await one('select 1 from placements where id = $1 and org_id = $2', [body.placementId, auth.orgId], db))) throw forbidden();
    }
    return createGrievance({
      complainantUserId: auth.userId, complainantPersonId: personId, complainantParty: party, channel: 'app',
      category: body.category, subject: body.subject, description: body.description, placementId: body.placementId,
      againstOrgId: party === 'host' ? null : body.againstOrgId, shareIdentity: body.shareIdentity,
    }, db);
  }),
);

m.route({ method: 'post', path: '/phone', summary: 'Staff log a grievance received by phone (FR-EE-42)', access: { any: ['grievances.handle', 'helpdesk.handle', 'candidates.manage'] },
  body: z.object({ complainantName: z.string().min(2), complainantMobile: zMobile, category: z.enum(CATEGORIES), subject: z.string().min(3), description: z.string().min(10),
    placementId: z.string().uuid().optional(), againstOrgId: z.string().uuid().optional(), shareIdentity: z.boolean().default(false) }) },
async ({ auth, body }) =>
  tx(async (db) => {
    const person = await one<{ id: string; user_id: string | null; lifecycle: string }>('select id, user_id, lifecycle from person_profiles where mobile = $1', [body.complainantMobile], db);
    return createGrievance({
      complainantUserId: person?.user_id ?? null, complainantPersonId: person?.id ?? null,
      complainantParty: person ? (person.lifecycle === 'apprentice' ? 'apprentice' : 'job_seeker') : 'other',
      complainantName: body.complainantName, complainantMobile: body.complainantMobile, channel: 'phone', category: body.category,
      subject: body.subject, description: body.description, placementId: body.placementId, againstOrgId: body.againstOrgId,
      shareIdentity: body.shareIdentity, createdBy: auth.userId,
    }, db);
  }),
);

// ---------------------------------------------------------------------------
// Complainant view (FR-EE-43)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/mine', summary: 'Cases I raised', access: 'user' }, async ({ auth }) =>
  query(`select id, ref, category, severity, subject, status, target_date as "targetDate", first_contact_due as "firstContactDue", created_at as "createdAt",
                resolution_type as "resolutionType", resolution_text as "resolutionText", complainant_response as "complainantResponse", satisfaction
           from grievances where complainant_user_id = $1 order by created_at desc`, [auth.userId]),
);

async function ownCase(id: string, auth: AuthContext) {
  const g = await one('select * from grievances where id = $1', [id]);
  if (!g || g.complainant_user_id !== auth.userId) throw notFound('Case');
  return g;
}

m.route({ method: 'get', path: '/mine/:id', summary: 'My case with its timeline', access: 'user' }, async ({ auth, params }) => {
  const g = await ownCase(params.id, auth);
  return {
    id: g.id, ref: g.ref, category: g.category, severity: g.severity, subject: g.subject, description: decrypt(g.description_enc), status: g.status,
    targetDate: g.target_date, firstContactDue: g.first_contact_due, firstContactAt: g.first_contact_at, shareIdentity: g.share_identity,
    resolutionType: g.resolution_type, resolutionText: g.resolution_text, complainantResponse: g.complainant_response, satisfaction: g.satisfaction,
    escalationSteps: ESCALATION_STEPS, timeline: await actionsFor(g.id, true, pool),
  };
});

m.route({ method: 'post', path: '/mine/:id/respond', summary: 'Accept or reject the proposed resolution', access: 'user',
  body: z.object({ response: z.enum(['accepted', 'rejected']), comment: z.string().max(1000).optional() }) },
async ({ auth, params, body }) =>
  tx(async (db) => {
    const g = await ownCase(params.id, auth);
    if (g.status !== 'resolution_proposed') throw ruleViolation('There is no proposed resolution to respond to yet.');
    await db.query(`update grievances set complainant_response = $2 where id = $1`, [g.id, body.response]);
    await addAction(g.id, auth.userId, `complainant_${body.response}`, body.comment ?? null, true, db);
    if (body.response === 'accepted') {
      await db.query(`update grievances set status = 'resolved', closed_at = now() where id = $1`, [g.id]);
      await notifyComplainant(g.id, 'resolved. Please rate how we handled it.', db);
    } else {
      // Workflow 6 step 7: escalate to the Operations Manager, then to the Super Admin.
      const level = g.escalation_level + 1;
      await db.query(`update grievances set status = 'escalated', escalation_level = $2 where id = $1`, [g.id, level]);
      await addAction(g.id, null, 'escalated', level === 1 ? 'Escalated to the Operations Manager' : 'Escalated to the Super Admin', true, db);
      await notifyRole(level === 1 ? 'operations_manager' : 'super_admin', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: `Escalated grievance ${g.ref}`, body: `The complainant rejected the proposed resolution. Review case ${g.ref}.` } }, db);
    }
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/mine/:id/satisfaction', summary: 'Rate how the case was handled', access: 'user', body: z.object({ score: z.number().int().min(1).max(5) }) },
  async ({ auth, params, body }) => {
    const g = await ownCase(params.id, auth);
    if (!['resolved', 'closed'].includes(g.status)) throw ruleViolation('You can rate the case after it is resolved.');
    await query(`update grievances set satisfaction = $2 where id = $1`, [g.id, body.score]);
    return { ok: true };
  });

// Hosts see cases about their workplace, without the complainant's identity unless shared (FR-EE-41).
m.route({ method: 'get', path: '/host', summary: 'Concerns relating to my workplace', access: { any: ['host.admin'] } }, async ({ auth }) => {
  if (!auth.orgId) throw forbidden();
  const rows = await query(
    `select g.id, g.ref, g.category, g.severity, g.status, g.created_at as "createdAt", g.target_date as "targetDate", g.share_identity,
            g.complainant_name, p.full_name as person_name
       from grievances g left join person_profiles p on p.id = g.complainant_person_id
      where g.against_org_id = $1 and g.complainant_party <> 'host' order by g.created_at desc`, [auth.orgId]);
  return rows.map(({ share_identity, complainant_name, person_name, ...r }) => ({
    ...r, complainant: share_identity ? person_name ?? complainant_name : 'Confidential', escalationSteps: ESCALATION_STEPS,
  }));
});

// ---------------------------------------------------------------------------
// Staff case handling
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/', summary: 'Grievance cases', access: STAFF,
  query: zPage.extend({ status: z.string().optional(), mine: z.enum(['true']).optional(), severity: z.coerce.number().int().optional() }) },
async ({ query: q, auth }) => {
  const seeAll = auth.permissions.has('grievances.view_all');
  const rows = await query(
    `select g.id, g.ref, g.category, g.severity, g.subject, g.status, g.channel, g.created_at as "createdAt", g.target_date as "targetDate",
            g.first_contact_due as "firstContactDue", g.first_contact_at as "firstContactAt", g.escalation_level as "escalationLevel",
            g.target_date < now() and g.status not in ('resolved','closed','referred') as overdue,
            g.first_contact_at is null and g.first_contact_due < now() as "firstContactOverdue",
            o.name as host, u.full_name as officer, count(*) over() as total
       from grievances g left join organisations o on o.id = g.against_org_id left join users u on u.id = g.officer_id
      where ($1::text is null or g.status = $1) and ($2::uuid is null or g.officer_id = $2) and ($3::int is null or g.severity = $3)
        and ($4 or g.officer_id = $5 or g.escalation_level > 0)
        and ($6::text is null or g.ref ilike '%' || $6 || '%' or g.subject ilike '%' || $6 || '%')
      order by g.status in ('resolved','closed','referred'), g.severity, g.created_at ${pageClause(q)}`,
    [q.status ?? null, q.mine ? auth.userId : null, q.severity ?? null, seeAll, auth.userId, q.q ?? null]);
  return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
});

async function staffCase(id: string, auth: AuthContext) {
  const g = await one('select * from grievances where id = $1', [id]);
  if (!g) throw notFound('Case');
  if (!auth.permissions.has('grievances.view_all') && g.officer_id !== auth.userId && !(auth.permissions.has('grievances.escalation') && g.escalation_level > 0)) throw forbidden();
  return g;
}

m.route({ method: 'get', path: '/:id', summary: 'Full case with action log', access: STAFF }, async ({ params, auth, ip }) => {
  const g = await staffCase(params.id, auth);
  const [host, placement, person, officer] = await Promise.all([
    g.against_org_id ? one('select id, name from organisations where id = $1', [g.against_org_id]) : null,
    g.placement_id ? one(`select pl.id, pl.status, pl.role_title as "roleTitle", u.full_name as "placementOfficer" from placements pl left join users u on u.id = pl.officer_id where pl.id = $1`, [g.placement_id]) : null,
    g.complainant_person_id ? one('select id, full_name as name, mobile from person_profiles where id = $1', [g.complainant_person_id]) : null,
    g.officer_id ? one('select id, full_name as name from users where id = $1', [g.officer_id]) : null,
  ]);
  await audit({ actorId: auth.userId, action: 'data.grievance_viewed', entityType: 'grievance', entityId: g.id, ip });
  const { description_enc, ...rest } = g;
  return { ...rest, description: decrypt(description_enc), host, placement, person, officer, escalationSteps: ESCALATION_STEPS,
    actions: await actionsFor(g.id, false, pool) };
});

m.route({ method: 'post', path: '/:id/assign', summary: 'Reassign the Grievance Officer', access: { any: ['grievances.view_all'] }, body: z.object({ officerId: z.string().uuid() }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const g = await one('select g.placement_id, pl.officer_id from grievances g left join placements pl on pl.id = g.placement_id where g.id = $1', [params.id], db);
      if (!g) throw notFound('Case');
      if (g.officer_id && g.officer_id === body.officerId) throw ruleViolation('The placement officer for this case cannot handle the grievance.');
      const isGo = await one(`select 1 from user_roles where user_id = $1 and role_code = 'grievance_officer'`, [body.officerId], db);
      if (!isGo) throw badRequest('Choose a Grievance Officer.');
      await db.query(`update grievances set officer_id = $2, status = case when status = 'new' then 'assigned' else status end where id = $1`, [params.id, body.officerId]);
      await addAction(params.id, auth.userId, 'assigned', 'Reassigned', false, db);
      return { ok: true };
    }),
);

m.route({ method: 'post', path: '/:id/actions', summary: 'Record a contact, note or finding (FR-FDB-06)', access: STAFF,
  body: z.object({ action: z.enum(['note', 'first_contact', 'contacted_host', 'evidence', 'finding']), note: z.string().min(2).max(5000), visibleToComplainant: z.boolean().default(false),
    severity: z.number().int().min(1).max(3).optional() }) },
async ({ params, body, auth }) =>
  tx(async (db) => {
    const g = await staffCase(params.id, auth);
    if (['closed', 'referred'].includes(g.status)) throw ruleViolation('This case is closed.');
    await addAction(g.id, auth.userId, body.action, body.note, body.visibleToComplainant, db);
    if (body.action === 'first_contact' && !g.first_contact_at) {
      await db.query(`update grievances set first_contact_at = now(), status = case when status in ('new','assigned') then 'under_review' else status end where id = $1`, [g.id]);
      await notifyComplainant(g.id, 'under review. A Grievance Officer has contacted you.', db);
    } else if (g.status === 'assigned' || g.status === 'new') {
      await db.query(`update grievances set status = 'under_review' where id = $1`, [g.id]);
    }
    if (body.severity && body.severity !== g.severity) {
      await db.query('update grievances set severity = $2 where id = $1', [g.id, body.severity]);
      await addAction(g.id, auth.userId, 'severity_changed', `Severity ${g.severity} → ${body.severity}`, false, db);
    }
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/:id/propose', summary: 'Propose a resolution to the complainant', access: STAFF,
  body: z.object({ resolutionType: z.enum(['no_action', 'mediation', 'corrective_action', 'redeployment', 'other']), text: z.string().min(10) }) },
async ({ params, body, auth }) =>
  tx(async (db) => {
    const g = await staffCase(params.id, auth);
    if (['resolved', 'closed', 'referred'].includes(g.status)) throw ruleViolation('This case is already finished.');
    await db.query(`update grievances set status = 'resolution_proposed', resolution_type = $2, resolution_text = $3, complainant_response = null where id = $1`, [g.id, body.resolutionType, body.text]);
    await addAction(g.id, auth.userId, 'resolution_proposed', `${body.resolutionType}: ${body.text}`, true, db);
    // Phone and SMS complainants answer through staff, so their response is logged by the officer.
    await notifyComplainant(g.id, 'a resolution is proposed. Open the app to accept or reject it.', db);
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/:id/record-response', summary: 'Record a phone or SMS complainant\'s response', access: STAFF,
  body: z.object({ response: z.enum(['accepted', 'rejected']), note: z.string().optional() }) },
async ({ params, body, auth }) =>
  tx(async (db) => {
    const g = await staffCase(params.id, auth);
    if (g.status !== 'resolution_proposed') throw ruleViolation('No resolution is waiting for a response.');
    await db.query(`update grievances set complainant_response = $2, status = $3, escalation_level = escalation_level + $4, closed_at = case when $2 = 'accepted' then now() end where id = $1`,
      [g.id, body.response, body.response === 'accepted' ? 'resolved' : 'escalated', body.response === 'accepted' ? 0 : 1]);
    await addAction(g.id, auth.userId, `complainant_${body.response}`, body.note ?? 'Recorded by staff', true, db);
    if (body.response === 'rejected') {
      await notifyRole(g.escalation_level === 0 ? 'operations_manager' : 'super_admin', { code: 'generic', channels: ['in_app'], vars: { subject: `Escalated grievance ${g.ref}`, body: 'The complainant rejected the proposed resolution.' } }, db);
    }
    return { ok: true };
  }),
);

m.route({ method: 'post', path: '/:id/refer', summary: 'Refer a possible legal breach to an authority', access: STAFF, body: z.object({ authority: z.string().min(3), note: z.string().min(5) }) },
  async ({ params, body, auth, ip }) =>
    tx(async (db) => {
      const g = await staffCase(params.id, auth);
      await db.query(`update grievances set status = 'referred', legal_referral = true, closed_at = now() where id = $1`, [g.id]);
      await addAction(g.id, auth.userId, 'referred', `Referred to ${body.authority}: ${body.note}`, true, db);
      await notifyComplainant(g.id, `referred to ${body.authority}`, db);
      await audit({ actorId: auth.userId, action: 'grievance.referred', entityType: 'grievance', entityId: g.id, ip, details: { authority: body.authority } }, db);
      return { ok: true };
    }),
);

m.route({ method: 'post', path: '/:id/close', summary: 'Close a resolved case', access: STAFF, body: z.object({ note: z.string().min(3) }) },
  async ({ params, body, auth }) =>
    tx(async (db) => {
      const g = await staffCase(params.id, auth);
      if (!['resolved', 'escalated', 'under_review', 'resolution_proposed'].includes(g.status)) throw ruleViolation('Resolve the case before closing it.');
      if (g.status !== 'resolved' && !auth.permissions.has('grievances.escalation') && !auth.permissions.has('grievances.view_all')) throw forbidden();
      await db.query(`update grievances set status = 'closed', closed_at = coalesce(closed_at, now()) where id = $1`, [g.id]);
      await addAction(g.id, auth.userId, 'closed', body.note, true, db);
      await notifyComplainant(g.id, 'closed. Please rate how we handled it in the app.', db);
      return { ok: true };
    }),
);

// ---------------------------------------------------------------------------
// Central feedback queue (FR-FDB-01) and grievance reports (FR-FDB-08)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/queue/all', summary: 'All feedback, ratings and grievances in one queue', access: { any: ['feedback.view', 'grievances.view_all'] } }, async () =>
  query(
    `select * from (
       select 'grievance' as kind, g.id, g.created_at as at, g.ref as title, g.category as detail, g.severity::text as score, g.status, o.name as host,
              case g.complainant_party when 'host' then 'host' else 'apprentice' end as source
         from grievances g left join organisations o on o.id = g.against_org_id
       union all
       select 'rating', r.id, r.created_at, r.from_party || ' rated ' || r.to_party, coalesce(r.comment, ''), r.stars::text, r.context, o.name, r.from_party
         from ratings r left join organisations o on o.id = r.org_id
       union all
       select 'request', pr.id, pr.created_at, pr.requester_party || ' requested ' || pr.kind, pr.reason, null, pr.status, o.name, pr.requester_party
         from placement_requests pr join placements pl on pl.id = pr.placement_id join organisations o on o.id = pl.org_id
     ) q order by at desc limit 300`),
);

m.route({ method: 'get', path: '/reports/summary', summary: 'Grievance volumes, categories and resolution times by host and month', access: { any: ['grievances.view_all', 'reports.view'] } }, async () => {
  const [byMonth, byHost, byCategory] = await Promise.all([
    query(`select to_char(created_at, 'YYYY-MM') as month, count(*)::int as opened,
                  count(*) filter (where status in ('resolved','closed'))::int as resolved,
                  round(avg(extract(epoch from (closed_at - created_at)) / 86400) filter (where closed_at is not null), 1) as "avgDaysToResolve"
             from grievances group by 1 order by 1 desc limit 24`),
    query(`select coalesce(o.name, 'No host') as host, count(*)::int as cases, count(*) filter (where g.severity = 1)::int as "severity1",
                  round(avg(extract(epoch from (g.closed_at - g.created_at)) / 86400) filter (where g.closed_at is not null), 1) as "avgDaysToResolve"
             from grievances g left join organisations o on o.id = g.against_org_id group by 1 order by 2 desc`),
    query(`select category, count(*)::int as cases from grievances group by 1 order by 2 desc`),
  ]);
  return { byMonth, byHost, byCategory };
});
