import { z } from 'zod';
import { one, query, tx } from '../../db/pool.js';
import { audit, verifyAuditChain } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js';
import { createModule, pageClause, zMobile, zPage } from '../../lib/http.js';
import { clearSettingsCache, type SettingKey } from '../../lib/settings.js';
import { clearPermissionCache } from '../../middleware/auth.js';
import { JOBS } from '../../jobs/registry.js';
import { runJob } from '../../jobs/scheduler.js';
import { hashPassword } from '../auth/service.js';

const m = createModule('/admin', 'Administration');
export default m;

/** Every permission the system checks, for the role editor (FR-ADM-13). */
export const PERMISSIONS: Record<string, string> = {
  'dashboard.view': 'See the operations dashboard',
  'candidates.view': 'View candidates',
  'candidates.manage': 'Edit candidates and pipeline stages',
  'candidates.import': 'Bulk import candidates',
  'candidates.screen': 'Complete screening scorecards and training records',
  'candidates.verify': 'Verify identity and credentials',
  'sensitive.view': 'See unmasked CID and bank details',
  'hosts.view': 'View host employers',
  'hosts.verify': 'Verify host employers',
  'accounts.suspend': 'Suspend or reactivate accounts',
  'vacancies.review': 'Approve or return vacancies',
  'vacancies.manage_any': 'Create vacancies for a host (field visit)',
  'matching.manage': 'Run matching and share candidates with hosts',
  'placements.view': 'View placements and case files',
  'placements.manage': 'Create contracts, HPAs and placements',
  'placements.approve_end': 'Approve placement endings, outcomes and redeployment',
  'checkins.manage': 'Complete 30/60/90 day check-ins',
  'payroll.view': 'View payroll',
  'payroll.prepare': 'Prepare payroll runs (maker)',
  'payroll.approve': 'Approve payroll runs (checker)',
  'billing.view': 'View invoices and receivables',
  'billing.manage': 'Issue invoices, record payments, manage fee rules',
  'grievances.handle': 'Handle grievance cases',
  'grievances.view_all': 'See all grievance cases',
  'grievances.escalation': 'Receive escalated grievances',
  'feedback.view': 'See the feedback and ratings queue',
  'helpdesk.handle': 'Answer helpdesk tickets',
  'videos.manage': 'Create and edit campaign videos and careers',
  'videos.review': 'Review and publish videos',
  'qa.moderate': 'Moderate and answer video questions',
  'reports.view': 'View reports',
  'reports.export': 'Export reports to Excel and PDF',
  'tasks.view': 'See follow-up tasks',
  'config.manage': 'Change system configuration',
  'users.manage': 'Create staff accounts and assign roles',
  'roles.manage': 'Edit role permissions',
  'audit.view': 'View the audit log',
  'notifications.templates': 'Edit message templates',
  'host.portal': 'Use the host employer portal',
  'host.admin': 'Manage host users, sign agreements, see invoices',
  'seeker.portal': 'Use the job seeker portal',
};

// ---------------------------------------------------------------------------
// Staff accounts (FR-AUTH-05) and roles (FR-ADM-13)
// ---------------------------------------------------------------------------
m.route(
  { method: 'get', path: '/users', summary: 'List users with roles', access: { any: ['users.manage', 'accounts.suspend'] },
    query: zPage.extend({ kind: z.enum(['staff', 'host', 'seeker', 'all']).default('staff'), role: z.string().optional() }) },
  async ({ query: q }) => {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.kind === 'staff') where.push(`exists (select 1 from user_roles ur join roles r on r.code = ur.role_code where ur.user_id = u.id and r.is_internal)`);
    if (q.kind === 'host') where.push(`exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role_code in ('host_owner','host_supervisor'))`);
    if (q.kind === 'seeker') where.push(`exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role_code = 'job_seeker')`);
    if (q.role) { params.push(q.role); where.push(`exists (select 1 from user_roles ur where ur.user_id = u.id and ur.role_code = $${params.length})`); }
    if (q.q) { params.push(`%${q.q}%`); where.push(`(u.full_name ilike $${params.length} or u.mobile ilike $${params.length} or u.email ilike $${params.length})`); }
    const sql = `
      select u.id, u.full_name as "fullName", u.mobile, u.email, u.status, u.last_login_at as "lastLoginAt",
             u.locked_until > now() as locked, u.suspended_reason as "suspendedReason",
             coalesce(json_agg(json_build_object('role', ur.role_code, 'orgId', ur.org_id, 'orgName', o.name)) filter (where ur.id is not null), '[]') as roles,
             count(*) over() as total
        from users u left join user_roles ur on ur.user_id = u.id left join organisations o on o.id = ur.org_id
       ${where.length ? `where ${where.join(' and ')}` : ''}
       group by u.id order by u.created_at desc ${pageClause(q)}`;
    const rows = await query(sql, params);
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  },
);

m.route(
  {
    method: 'post', path: '/users', summary: 'Create a staff account (Super Admin only)', access: { any: ['users.manage'] },
    body: z.object({
      fullName: z.string().trim().min(2), mobile: zMobile, email: z.string().email().optional(),
      initialPassword: z.string().min(8), roles: z.array(z.string()).min(1),
    }),
  },
  async ({ body, auth, ip }) => {
    const internal = await query<{ code: string }>('select code from roles where is_internal and code = any($1)', [body.roles]);
    if (internal.length !== body.roles.length) throw badRequest('Staff accounts can only hold internal roles.');
    return tx(async (db) => {
      const u = await one<{ id: string }>(
        `insert into users (mobile, email, password_hash, full_name, created_by, mobile_verified_at, contact_confirmed_at)
         values ($1, $2, $3, $4, $5, now(), now()) returning id`,
        [body.mobile, body.email ?? null, await hashPassword(body.initialPassword), body.fullName, auth.userId],
        db,
      );
      for (const r of body.roles) await db.query('insert into user_roles (user_id, role_code, granted_by) values ($1, $2, $3)', [u!.id, r, auth.userId]);
      await audit({ actorId: auth.userId, action: 'permissions.staff_created', entityType: 'user', entityId: u!.id, ip, details: { roles: body.roles } }, db);
      return { id: u!.id };
    });
  },
);

m.route(
  {
    method: 'put', path: '/users/:id/roles', summary: 'Replace the internal roles of a staff member', access: { any: ['users.manage'] },
    body: z.object({ roles: z.array(z.string()) }),
  },
  async ({ params, body, auth, ip }) => {
    if (params.id === auth.userId && !body.roles.includes('super_admin')) throw badRequest('You cannot remove your own Super Admin role.');
    const internal = await query<{ code: string }>('select code from roles where is_internal and code = any($1)', [body.roles]);
    if (internal.length !== body.roles.length) throw badRequest('Only internal roles can be assigned here.');
    await tx(async (db) => {
      const before = await query<{ role_code: string }>(
        `select ur.role_code from user_roles ur join roles r on r.code = ur.role_code where ur.user_id = $1 and r.is_internal`, [params.id], db);
      await db.query(`delete from user_roles ur using roles r where r.code = ur.role_code and ur.user_id = $1 and r.is_internal`, [params.id]);
      for (const r of body.roles) await db.query('insert into user_roles (user_id, role_code, granted_by) values ($1, $2, $3)', [params.id, r, auth.userId]);
      await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [params.id]);
      await audit({ actorId: auth.userId, action: 'permissions.roles_changed', entityType: 'user', entityId: params.id, ip,
        details: { from: before.map((b) => b.role_code), to: body.roles } }, db);
    });
    return { ok: true };
  },
);

m.route(
  {
    method: 'post', path: '/users/:id/status', summary: 'Suspend or reactivate an account with a reason (FR-ENT-04)', access: { any: ['accounts.suspend'] },
    body: z.object({ status: z.enum(['active', 'suspended']), reason: z.string().trim().min(5, 'give a reason') }),
  },
  async ({ params, body, auth, ip }) => {
    if (params.id === auth.userId) throw badRequest('You cannot change your own account status.');
    await tx(async (db) => {
      const u = await one('select id from users where id = $1', [params.id], db);
      if (!u) throw notFound('User');
      await db.query('update users set status = $2, suspended_reason = $3 where id = $1', [params.id, body.status, body.status === 'suspended' ? body.reason : null]);
      if (body.status === 'suspended') await db.query('update sessions set revoked_at = now() where user_id = $1 and revoked_at is null', [params.id]);
      await db.query(`insert into verification_decisions (entity_type, entity_id, item, decision, reason, decided_by) values ('user', $1, $2, $3, $4, $5)`,
        [params.id, `account_${body.status}`, body.status === 'active' ? 'verified' : 'rejected', body.reason, auth.userId]);
      await audit({ actorId: auth.userId, action: `account.${body.status}`, entityType: 'user', entityId: params.id, ip, details: { reason: body.reason } }, db);
    });
    return { ok: true };
  },
);

m.route({ method: 'post', path: '/users/:id/unlock', summary: 'Unlock a locked account', access: { any: ['users.manage'] } }, async ({ params, auth, ip }) => {
  await query('update users set locked_until = null, failed_login_attempts = 0 where id = $1', [params.id]);
  await audit({ actorId: auth.userId, action: 'account.unlocked', entityType: 'user', entityId: params.id, ip });
  return { ok: true };
});

m.route({ method: 'get', path: '/roles', summary: 'Roles and their permissions', access: { any: ['roles.manage', 'users.manage'] } }, async () => {
  const roles = await query(
    `select r.code, r.name, r.is_internal as "isInternal", r.description,
            coalesce(array_agg(rp.permission order by rp.permission) filter (where rp.permission is not null), '{}') as permissions
       from roles r left join role_permissions rp on rp.role_code = r.code group by r.code order by r.is_internal desc, r.name`,
  );
  return { roles, catalog: PERMISSIONS };
});

m.route(
  {
    method: 'put', path: '/roles/:code/permissions', summary: 'Set permissions of a role', access: { any: ['roles.manage'] },
    body: z.object({ permissions: z.array(z.string()) }),
  },
  async ({ params, body, auth, ip }) => {
    const unknown = body.permissions.filter((p) => !(p in PERMISSIONS));
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.join(', ')}`);
    if (params.code === 'super_admin' && !['roles.manage', 'users.manage'].every((p) => body.permissions.includes(p))) {
      throw badRequest('Super Admin must keep roles.manage and users.manage, or nobody could fix permissions.');
    }
    await tx(async (db) => {
      const before = await query<{ permission: string }>('select permission from role_permissions where role_code = $1', [params.code], db);
      await db.query('delete from role_permissions where role_code = $1', [params.code]);
      for (const p of body.permissions) await db.query('insert into role_permissions (role_code, permission) values ($1, $2)', [params.code, p]);
      await audit({ actorId: auth.userId, action: 'permissions.role_changed', entityType: 'role', entityId: params.code, ip,
        details: { from: before.map((b) => b.permission), to: body.permissions } }, db);
    });
    clearPermissionCache();
    return { ok: true };
  },
);

m.route(
  { method: 'get', path: '/staff', summary: 'Active staff, optionally by role (for assignment pickers)', access: 'user', query: z.object({ role: z.string().optional() }) },
  async ({ query: q, auth }) => {
    if (!auth.isInternal) throw forbidden();
    return query(
      `select distinct u.id, u.full_name as "fullName", ur.role_code as role
         from users u join user_roles ur on ur.user_id = u.id join roles r on r.code = ur.role_code
        where r.is_internal and u.status = 'active' and ($1::text is null or ur.role_code = $1) order by u.full_name`,
      [q.role ?? null],
    );
  },
);

// ---------------------------------------------------------------------------
// Configuration (FR-ADM-10, 11)
// ---------------------------------------------------------------------------
const num = (min: number, max: number) => z.number().min(min).max(max);
const CONFIG_SCHEMAS: Record<SettingKey, z.ZodType> = {
  'payroll.wage_floor': num(0, 100000),
  'payroll.pay_day': z.number().int().min(1).max(28),
  'payroll.prep_working_days': z.number().int().min(1).max(15),
  'payroll.attendance_default_days': z.number().int().min(1).max(10),
  'payroll.deductions': z.array(z.object({ code: z.string(), label: z.string(), pct: num(0, 50), enabled: z.boolean() })),
  'payroll.bank_file_format': z.enum(['generic_csv', 'bob_csv', 'bnb_txt']),
  'placement.redeploy_working_days': z.number().int().min(1).max(60),
  'placement.bench_pay_pct': num(0, 100),
  'placement.apprenticeship_months': z.number().int().min(3).max(6),
  'placement.checkin_days': z.array(z.number().int().min(1).max(365)).min(1),
  'placement.replacement_entitlement': z.number().int().min(0).max(5),
  'placement.replacement_period_days': z.number().int().min(0).max(365),
  'placement.sign_reminder_days': z.number().int().min(1).max(30),
  'labour.max_hours_per_week': num(1, 72),
  'labour.max_days_per_week': z.number().int().min(1).max(7),
  'labour.min_rest_days': z.number().int().min(0).max(3),
  'labour.min_leave_days': z.number().int().min(0).max(60),
  'billing.invoice_due_days': z.number().int().min(0).max(120),
  'billing.reminder_days': z.array(z.number().int().min(1)).min(1),
  'grievance.target_days': z.record(z.string(), z.number().int().min(1)),
  'grievance.first_contact': z.record(z.string(), z.object({ hours: z.number().optional(), working_days: z.number().optional() })),
  'helpdesk.sla': z.record(z.string(), z.object({ response_h: z.number().min(1), resolution_h: z.number().min(1) })),
  'helpdesk.auto_close_days': z.number().int().min(1).max(60),
  'auth.consent_version': z.string().min(1),
  'auth.consent_text': z.string().min(20),
  'auth.contact_reconfirm_days': z.number().int().min(7).max(365),
  'candidates.no_contact_days': z.number().int().min(1).max(365),
  'candidates.max_contact_attempts': z.number().int().min(1).max(10),
  'seeker.nudge_days': z.number().int().min(1).max(90),
  'calendar.working_days': z.array(z.number().int().min(1).max(7)).min(1),
  'calendar.holidays': z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  'matching.weights': z.object({ skills: z.number(), scorecard: z.number(), location: z.number(), wage: z.number(), availability: z.number() })
    .refine((w) => Object.values(w).reduce((a, b) => a + b, 0) === 100, 'weights must add up to 100'),
  'templates.employment_contract': z.string().min(50),
  'templates.hpa': z.string().min(50),
};

m.route({ method: 'get', path: '/config', summary: 'All configuration settings', access: { any: ['config.manage'] } }, async () =>
  query(`select c.key, c.value, c.description, c.updated_at as "updatedAt", u.full_name as "updatedBy"
           from config_settings c left join users u on u.id = c.updated_by order by c.key`),
);

m.route(
  { method: 'put', path: '/config/:key', summary: 'Change a setting; old and new values are recorded', access: { any: ['config.manage'] }, body: z.object({ value: z.unknown() }) },
  async ({ params, body, auth, ip }) => {
    const schema = CONFIG_SCHEMAS[params.key as SettingKey];
    if (!schema) throw notFound('Setting');
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) throw badRequest(`Invalid value: ${parsed.error.issues[0]?.message}`);
    await tx(async (db) => {
      const old = await one('select value from config_settings where key = $1 for update', [params.key], db);
      await db.query('update config_settings set value = $2, updated_by = $3, updated_at = now() where key = $1', [params.key, JSON.stringify(parsed.data), auth.userId]);
      await db.query('insert into config_history (key, old_value, new_value, changed_by) values ($1, $2, $3, $4)',
        [params.key, JSON.stringify(old?.value ?? null), JSON.stringify(parsed.data), auth.userId]);
      await audit({ actorId: auth.userId, action: 'config.changed', entityType: 'config', entityId: params.key, ip, details: { old: old?.value, new: parsed.data } }, db);
    });
    clearSettingsCache();
    return { ok: true };
  },
);

m.route({ method: 'get', path: '/config/history', summary: 'Configuration change history', access: { any: ['config.manage', 'audit.view'] } }, async () =>
  query(`select h.id, h.key, h.old_value as "oldValue", h.new_value as "newValue", h.created_at as "changedAt", u.full_name as "changedBy"
           from config_history h left join users u on u.id = h.changed_by order by h.id desc limit 300`),
);

// Fee rules are configuration too (FR-ACC-02).
const feeRuleBody = z.object({
  name: z.string().min(2), sizeTier: z.enum(['micro', 'small', 'medium', 'large']).nullable().default(null),
  sectorCode: z.string().nullable().default(null), roleKeyword: z.string().nullable().default(null),
  minMonths: z.number().int().nullable().default(null), maxMonths: z.number().int().nullable().default(null),
  placementFee: z.number().min(0), monthlyServiceFee: z.number().min(0), adminFeePct: z.number().min(0).max(100),
  adminFeeFixed: z.number().min(0).default(0), priority: z.number().int().default(100), active: z.boolean().default(true),
});

m.route({ method: 'get', path: '/fee-rules', summary: 'Fee rules', access: { any: ['config.manage', 'billing.manage', 'billing.view', 'placements.manage'] } }, async () =>
  query(`select id, name, size_tier as "sizeTier", sector_code as "sectorCode", role_keyword as "roleKeyword", min_months as "minMonths",
                max_months as "maxMonths", placement_fee as "placementFee", monthly_service_fee as "monthlyServiceFee",
                admin_fee_pct as "adminFeePct", admin_fee_fixed as "adminFeeFixed", priority, active
           from fee_rules order by active desc, priority`),
);

async function saveFeeRule(id: string | null, b: z.infer<typeof feeRuleBody>, actor: string, ip: string | null) {
  const vals = [b.name, b.sizeTier, b.sectorCode, b.roleKeyword, b.minMonths, b.maxMonths, b.placementFee, b.monthlyServiceFee, b.adminFeePct, b.adminFeeFixed, b.priority, b.active];
  const row = id
    ? await one(`update fee_rules set name=$1, size_tier=$2, sector_code=$3, role_keyword=$4, min_months=$5, max_months=$6, placement_fee=$7,
                   monthly_service_fee=$8, admin_fee_pct=$9, admin_fee_fixed=$10, priority=$11, active=$12 where id = $13 returning id`, [...vals, id])
    : await one(`insert into fee_rules (name, size_tier, sector_code, role_keyword, min_months, max_months, placement_fee, monthly_service_fee,
                   admin_fee_pct, admin_fee_fixed, priority, active) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`, vals);
  if (!row) throw notFound('Fee rule');
  await audit({ actorId: actor, action: 'config.fee_rule_saved', entityType: 'fee_rule', entityId: row.id, ip, details: b });
  return { id: row.id };
}
m.route({ method: 'post', path: '/fee-rules', summary: 'Create a fee rule', access: { any: ['config.manage', 'billing.manage'] }, body: feeRuleBody },
  async ({ body, auth, ip }) => saveFeeRule(null, body, auth.userId, ip));
m.route({ method: 'put', path: '/fee-rules/:id', summary: 'Update a fee rule', access: { any: ['config.manage', 'billing.manage'] }, body: feeRuleBody },
  async ({ params, body, auth, ip }) => saveFeeRule(params.id, body, auth.userId, ip));

// Scorecards (FR-CND-04/05): new versions only, so past results keep theirs.
m.route({ method: 'get', path: '/scorecards', summary: 'Screening scorecards', access: { any: ['config.manage', 'candidates.screen'] } }, async () =>
  query(`select id, sector_code as "sectorCode", version, name, criteria, pass_threshold as "passThreshold", is_active as "isActive", created_at as "createdAt"
           from screening_scorecards order by sector_code, version desc`),
);
m.route(
  {
    method: 'post', path: '/scorecards', summary: 'Publish a new scorecard version', access: { any: ['config.manage'] },
    body: z.object({
      sectorCode: z.string(), name: z.string().min(2), passThreshold: z.number().min(0).max(100),
      criteria: z.array(z.object({ key: z.string().regex(/^[a-z_]+$/), label: z.string(), weight: z.number().min(0), max: z.number().int().min(1).max(10) })).min(1)
        .refine((c) => c.reduce((a, x) => a + x.weight, 0) === 100, 'criteria weights must add up to 100'),
    }),
  },
  async ({ body, auth, ip }) => tx(async (db) => {
    const v = await one<{ v: number }>('select coalesce(max(version), 0) + 1 as v from screening_scorecards where sector_code = $1', [body.sectorCode], db);
    await db.query('update screening_scorecards set is_active = false where sector_code = $1', [body.sectorCode]);
    const row = await one(`insert into screening_scorecards (sector_code, version, name, criteria, pass_threshold, created_by)
                           values ($1, $2, $3, $4, $5, $6) returning id, version`,
      [body.sectorCode, v!.v, body.name, JSON.stringify(body.criteria), body.passThreshold, auth.userId], db);
    await audit({ actorId: auth.userId, action: 'config.scorecard_published', entityType: 'scorecard', entityId: row!.id, ip, details: body }, db);
    return row;
  }),
);

// ---------------------------------------------------------------------------
// Audit (FR-ADM-12)
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'get', path: '/audit', summary: 'Audit log', access: { any: ['audit.view'] },
    query: zPage.extend({ action: z.string().optional(), actorId: z.string().uuid().optional(), entityId: z.string().optional() }),
  },
  async ({ query: q, auth, ip }) => {
    const rows = await query(
      `select a.id, a.created_at as "at", a.action, a.entity_type as "entityType", a.entity_id as "entityId", a.ip, a.details,
              u.full_name as "actor", a.hash, count(*) over() as total
         from audit_log a left join users u on u.id = a.actor_id
        where ($1::text is null or a.action like $1 || '%') and ($2::uuid is null or a.actor_id = $2) and ($3::text is null or a.entity_id = $3)
        order by a.id desc ${pageClause(q)}`,
      [q.action ?? null, q.actorId ?? null, q.entityId ?? null],
    );
    await audit({ actorId: auth.userId, action: 'data.audit_viewed', ip });
    return { items: rows.map(({ total, ...r }) => r), total: rows[0]?.total ?? 0 };
  },
);

m.route({ method: 'get', path: '/audit/verify', summary: 'Verify the audit hash chain', access: { any: ['audit.view'] } }, async () => verifyAuditChain());

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------
m.route(
  {
    method: 'get', path: '/tasks', summary: 'Open follow-up tasks for me or my role', access: { any: ['tasks.view'] },
    query: z.object({ scope: z.enum(['mine', 'all']).default('mine'), status: z.enum(['open', 'done']).default('open') }),
  },
  async ({ query: q, auth }) => {
    const roles = auth.roles.map((r) => r.role);
    return query(
      `select t.id, t.kind, t.title, t.description, t.entity_type as "entityType", t.entity_id as "entityId", t.priority,
              t.due_at as "dueAt", t.due_at < now() as overdue, t.status, t.created_at as "createdAt",
              t.assignee_role as "assigneeRole", u.full_name as "assignee"
         from tasks t left join users u on u.id = t.assignee_id
        where t.status = $1 and ($2 = 'all' and $4 or t.assignee_id = $3 or (t.assignee_id is null and t.assignee_role = any($5)))
        order by case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end, t.due_at nulls last
        limit 300`,
      [q.status, q.scope, auth.userId, auth.role === 'super_admin' || auth.role === 'operations_manager', roles],
    );
  },
);

m.route({ method: 'post', path: '/tasks/:id/complete', summary: 'Mark a task done', access: { any: ['tasks.view'] } }, async ({ params, auth }) => {
  await query(`update tasks set status = 'done', completed_by = $2, completed_at = now() where id = $1`, [params.id, auth.userId]);
  return { ok: true };
});

// ---------------------------------------------------------------------------
// Message templates (FR-NOT-03) and reference data (NFR-LOC-02)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/templates', summary: 'Notification templates', access: { any: ['notifications.templates'] } }, async () =>
  query('select code, channel, language, subject, body, updated_at as "updatedAt" from notification_templates order by code, channel, language'),
);

m.route(
  {
    method: 'put', path: '/templates', summary: 'Create or update a template', access: { any: ['notifications.templates'] },
    body: z.object({ code: z.string().regex(/^[a-z_]+$/), channel: z.enum(['in_app', 'sms', 'email']), language: z.enum(['en', 'dz']), subject: z.string().nullable().default(null), body: z.string().min(1).max(1000) }),
  },
  async ({ body, auth }) => {
    await query(
      `insert into notification_templates (code, channel, language, subject, body, updated_by) values ($1,$2,$3,$4,$5,$6)
       on conflict (code, channel, language) do update set subject = excluded.subject, body = excluded.body, updated_by = excluded.updated_by, updated_at = now()`,
      [body.code, body.channel, body.language, body.subject, body.body, auth.userId],
    );
    return { ok: true };
  },
);

m.route(
  { method: 'post', path: '/reference/gewogs', summary: 'Add a gewog or thromde', access: { any: ['config.manage'] },
    body: z.object({ dzongkhagId: z.number().int(), name: z.string().min(2), kind: z.enum(['gewog', 'thromde']) }) },
  async ({ body }) => one('insert into gewogs (dzongkhag_id, name, kind) values ($1, $2, $3) returning id', [body.dzongkhagId, body.name, body.kind]),
);

m.route(
  { method: 'post', path: '/reference/skills', summary: 'Add a skill', access: { any: ['config.manage', 'candidates.manage'] },
    body: z.object({ name: z.string().min(2), sectorCode: z.string().nullable().default(null) }) },
  async ({ body }) => one('insert into skills (name, sector_code) values ($1, $2) returning id', [body.name, body.sectorCode]),
);

// ---------------------------------------------------------------------------
// Scheduled jobs can also be run on demand (operations and testing)
// ---------------------------------------------------------------------------
m.route({ method: 'get', path: '/jobs', summary: 'List scheduled jobs', access: { any: ['config.manage'] } }, async () =>
  Object.entries(JOBS).map(([name, j]) => ({ name, schedule: j.schedule, description: j.description })),
);

m.route({ method: 'post', path: '/jobs/:name/run', summary: 'Run a scheduled job now', access: { any: ['config.manage'] } }, async ({ params, auth, ip }) => {
  const job = JOBS[params.name];
  if (!job) throw notFound('Job');
  const result = await runJob(params.name);
  if (result === null) throw conflict('This job is already running. Try again shortly.');
  await audit({ actorId: auth.userId, action: 'job.run', entityType: 'job', entityId: params.name, ip, details: { result } });
  return { name: params.name, result };
});
