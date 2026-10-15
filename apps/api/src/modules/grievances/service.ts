import { type Db, one, query } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { addWorkingDays, displayDate, displayDateTime, todayBT } from '../../lib/dates.js';
import { notify, notifyRole } from '../../lib/notify.js';
import { getCalendar, getSetting } from '../../lib/settings.js';
import { createTask } from '../../lib/tasks.js';

export const CATEGORIES = ['pay', 'safety', 'harassment', 'working_hours', 'conduct', 'contract', 'other'] as const;
export type Category = (typeof CATEGORIES)[number];

export const ESCALATION_STEPS = [
  'Step 1: Grievance Officer contacts you and reviews the facts.',
  'Step 2: If you do not accept the proposed resolution, the Operations Manager reviews the case.',
  'Step 3: If still unresolved, the BTBG Super Admin decides.',
  'Possible legal breaches are referred to the relevant authority (for example the Department of Labour).',
];

/** Safety and harassment are always Severity 1 (FR-FDB-04). */
export function defaultSeverity(category: Category): 1 | 2 | 3 {
  if (category === 'safety' || category === 'harassment') return 1;
  if (category === 'pay' || category === 'working_hours' || category === 'contract') return 2;
  return 3;
}

/**
 * Assign the least-loaded Grievance Officer who is not the placement officer
 * for this case (FR-FDB-02, BTBG operating rule on a separate concern contact).
 */
export async function pickGrievanceOfficer(placementOfficerId: string | null, db: Db) {
  const r = await one<{ id: string }>(
    `select u.id from users u join user_roles ur on ur.user_id = u.id and ur.role_code = 'grievance_officer'
      where u.status = 'active' and ($1::uuid is null or u.id <> $1)
      order by (select count(*) from grievances g where g.officer_id = u.id and g.status not in ('resolved','closed','referred')), u.created_at
      limit 1`, [placementOfficerId], db);
  return r?.id ?? null;
}

export interface NewGrievance {
  complainantUserId?: string | null;
  complainantPersonId?: string | null;
  complainantParty: 'apprentice' | 'job_seeker' | 'host' | 'other';
  complainantName?: string | null;
  complainantMobile?: string | null;
  againstOrgId?: string | null;
  placementId?: string | null;
  ticketId?: string | null;
  channel: 'app' | 'sms' | 'phone' | 'helpdesk';
  category: Category;
  severity?: 1 | 2 | 3;
  subject: string;
  description: string;
  shareIdentity: boolean;
  createdBy?: string | null;
}

export async function createGrievance(g: NewGrievance, db: Db) {
  const severity = g.severity ?? defaultSeverity(g.category);
  const [targets, firstContact, cal] = await Promise.all([getSetting('grievance.target_days', db), getSetting('grievance.first_contact', db), getCalendar(db)]);
  const now = new Date();
  const targetDate = new Date(`${addWorkingDays(todayBT(), targets[String(severity)] ?? 10, cal)}T17:00:00+06:00`);
  const fc = firstContact[String(severity)] ?? { working_days: 3 };
  const firstContactDue = fc.hours ? new Date(now.getTime() + fc.hours * 3_600_000) : new Date(`${addWorkingDays(todayBT(), fc.working_days ?? 3, cal)}T17:00:00+06:00`);

  let placementOfficer: string | null = null;
  let againstOrg = g.againstOrgId ?? null;
  if (g.placementId) {
    const pl = await one('select officer_id, org_id from placements where id = $1', [g.placementId], db);
    placementOfficer = pl?.officer_id ?? null;
    againstOrg ??= pl?.org_id ?? null;
  }
  const officerId = await pickGrievanceOfficer(placementOfficer, db);
  const ref = await one<{ ref: string }>(`select 'G' || to_char(now(), 'YY') || '-' || lpad(nextval('grievance_ref_seq')::text, 5, '0') as ref`, [], db);
  const row = await one<{ id: string }>(
    `insert into grievances (ref, complainant_user_id, complainant_person_id, complainant_party, complainant_name, complainant_mobile, against_org_id, placement_id,
            ticket_id, channel, category, severity, subject, description_enc, share_identity, status, officer_id, target_date, first_contact_due, created_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) returning id`,
    [ref!.ref, g.complainantUserId ?? null, g.complainantPersonId ?? null, g.complainantParty, g.complainantName ?? null, g.complainantMobile ?? null,
      againstOrg, g.placementId ?? null, g.ticketId ?? null, g.channel, g.category, severity, g.subject, encrypt(g.description), g.shareIdentity,
      officerId ? 'assigned' : 'new', officerId, targetDate, firstContactDue, g.createdBy ?? g.complainantUserId ?? null], db);
  const id = row!.id;
  await db.query(`insert into grievance_actions (grievance_id, actor_id, action, note_enc, visible_to_complainant) values ($1, $2, 'opened', $3, true)`,
    [id, g.createdBy ?? g.complainantUserId ?? null, encrypt(`Case opened via ${g.channel}. Severity ${severity}.`)]);
  // FR-EE-44: the anti-retaliation flag is recorded on every case.
  await db.query(`insert into grievance_actions (grievance_id, action, note_enc, visible_to_complainant) values ($1, 'anti_retaliation', $2, true)`,
    [id, encrypt('No adverse action may be taken against the complainant while this case is reviewed.')]);
  if (officerId) {
    await db.query(`insert into grievance_actions (grievance_id, action, note_enc) values ($1, 'assigned', $2)`, [id, encrypt('Assigned to Grievance Officer')]);
    await notify({ userId: officerId, code: 'generic', channels: ['in_app', 'sms'], vars: { subject: `New grievance ${ref!.ref}`, body: `Severity ${severity} ${g.category} case. First contact due ${displayDateTime(firstContactDue)}.` } }, db);
  }

  // Complainant gets the reference, timeline and escalation steps (Workflow 6 step 3, FR-FDB-07).
  await notify({
    userId: g.complainantUserId ?? null, mobile: g.complainantMobile ?? undefined, code: 'grievance_created',
    vars: { ref: ref!.ref, first_contact: displayDateTime(firstContactDue), target: displayDate(targetDate.toISOString()) },
  }, db);
  if (againstOrg && g.complainantParty !== 'host') {
    const owners = await query<{ user_id: string }>(`select user_id from user_roles where org_id = $1 and role_code = 'host_owner'`, [againstOrg], db);
    for (const o of owners) {
      await notify({ userId: o.user_id, code: 'generic', channels: ['in_app'], vars: { subject: `Concern ${ref!.ref} opened`, body: `BTBG opened a ${g.category.replace('_', ' ')} concern relating to your workplace. ${ESCALATION_STEPS.join(' ')} No action may be taken against the person who raised it.` } }, db);
    }
  }
  if (severity === 1) {
    // FR-FDB-04: Super Admin is alerted at once; first contact within 24 hours.
    await notifyRole('super_admin', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Severity 1 grievance', body: `URGENT ${ref!.ref}: ${g.category} case opened. First contact due within 24 hours.` } }, db);
    if (g.placementId) {
      await createTask({ kind: 'offer_redeployment', title: `Offer immediate redeployment (${ref!.ref})`, description: 'Safety or harassment case: offer the apprentice an immediate move.',
        entityType: 'grievance', entityId: id, assigneeRole: 'operations_manager', priority: 'urgent', dueAt: firstContactDue, dedupeKey: `offer_redeployment:${id}` }, db);
    }
  }
  await audit({ actorId: g.createdBy ?? g.complainantUserId ?? null, action: 'grievance.opened', entityType: 'grievance', entityId: id, details: { severity, category: g.category, channel: g.channel } }, db);
  return { id, ref: ref!.ref, severity, targetDate, firstContactDue, escalationSteps: ESCALATION_STEPS };
}

export async function addAction(grievanceId: string, actorId: string | null, action: string, note: string | null, visible: boolean, db: Db) {
  await db.query(`insert into grievance_actions (grievance_id, actor_id, action, note_enc, visible_to_complainant) values ($1,$2,$3,$4,$5)`,
    [grievanceId, actorId, action, encrypt(note), visible]);
}

export async function notifyComplainant(grievanceId: string, status: string, db: Db) {
  const g = await one('select ref, complainant_user_id, complainant_mobile from grievances where id = $1', [grievanceId], db);
  if (!g) return;
  await notify({ userId: g.complainant_user_id, mobile: g.complainant_mobile ?? undefined, code: 'grievance_update', vars: { ref: g.ref, status } }, db);
}

export async function actionsFor(grievanceId: string, complainantView: boolean, db: Db) {
  const rows = await query(
    `select a.action, a.note_enc, a.created_at as "at", a.visible_to_complainant as visible, u.full_name as actor
       from grievance_actions a left join users u on u.id = a.actor_id where a.grievance_id = $1 ${complainantView ? 'and a.visible_to_complainant' : ''} order by a.created_at`,
    [grievanceId], db);
  return rows.map(({ note_enc, ...r }) => ({ ...r, note: decrypt(note_enc), actor: complainantView ? (r.actor ? 'BTBG' : null) : r.actor }));
}
