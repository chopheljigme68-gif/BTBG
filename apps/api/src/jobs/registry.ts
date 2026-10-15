import { env } from '../config/env.js';
import { one, pool, query, tx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { addDays, displayDate, displayDateTime, periodOf, todayBT, workingDaysBetween } from '../lib/dates.js';
import { dispatchPending, notify, notifyRole } from '../lib/notify.js';
import { getCalendar, getSetting } from '../lib/settings.js';
import { createTask } from '../lib/tasks.js';
import { money } from '../lib/pdf.js';
import { generateInvoices } from '../modules/billing/service.js';
import { defaultMissingAttendance, payDateFor, preparationDate } from '../modules/payroll/service.js';
import { setPlacementStatus, tryActivate } from '../modules/placements/service.js';

/**
 * Scheduled jobs. Every job is idempotent (flags, dedupe keys or "only missing
 * rows" queries), so running one twice, or on several servers, is harmless.
 * Times are cron expressions in Bhutan Time.
 */
export interface Job {
  schedule: string;
  description: string;
  run: () => Promise<Record<string, number | string>>;
}

const link = (path: string) => `${env.WEB_URL}${path}`;

async function hostUsers(orgId: string, roles = ['host_owner', 'host_supervisor']) {
  return query<{ user_id: string }>(`select distinct user_id from user_roles where org_id = $1 and role_code = any($2)`, [orgId, roles]);
}

export const JOBS: Record<string, Job> = {
  dispatch_notifications: {
    schedule: '* * * * *',
    description: 'Send queued SMS and email, retrying failed SMS once (FR-NOT-04).',
    run: async () => ({ sent: await dispatchPending(500) }),
  },

  activate_placements: {
    schedule: '15 0 * * *',
    description: 'Start contracted placements on their start date once both agreements are signed (FR-PLC-14).',
    run: async () => {
      const due = await query(`select id from placements where status = 'contracted' and start_date <= $1`, [todayBT()]);
      let started = 0;
      for (const p of due) if ((await tx((db) => tryActivate(p.id, null, db))) === 'active') started++;
      return { started };
    },
  },

  checkin_reminders: {
    schedule: '0 8 * * *',
    description: 'Remind apprentices and hosts of check-ins two days before and on the day; flag overdue ones to the officer (FR-PLC-16).',
    run: async () => {
      const today = todayBT();
      const due = await query(
        `select c.id, c.day, c.party, c.due_date, pl.id as placement_id, pl.org_id, pl.officer_id, p.user_id, p.mobile, p.full_name, o.name as host
           from checkins c join placements pl on pl.id = c.placement_id join person_profiles p on p.id = pl.person_id join organisations o on o.id = pl.org_id
          where c.completed_at is null and pl.status in ('active','ending') and c.due_date <= $1`, [addDays(today, 2)]);
      let reminded = 0;
      let overdue = 0;
      for (const c of due) {
        if (c.due_date === today || c.due_date === addDays(today, 2)) {
          const recipients = c.party === 'apprentice' ? [{ userId: c.user_id, mobile: c.mobile }] : (await hostUsers(c.org_id)).map((u) => ({ userId: u.user_id, mobile: undefined }));
          for (const r of recipients) {
            await notify({ ...r, code: 'checkin_due', vars: { day: c.day, link: link(c.party === 'apprentice' ? '/app/seeker/placement' : '/app/host/roster') } });
          }
          reminded++;
        } else if (c.due_date < today) {
          const created = await createTask({
            kind: 'checkin_overdue', title: `Overdue day ${c.day} check-in (${c.party}): ${c.full_name} at ${c.host}`, entityType: 'placement', entityId: c.placement_id,
            assigneeId: c.officer_id, assigneeRole: c.officer_id ? null : 'field_officer', priority: 'high', dueAt: new Date(), dedupeKey: `checkin_overdue:${c.id}`,
          });
          if (created) overdue++;
        }
      }
      return { reminded, overdue };
    },
  },

  bench_timers: {
    schedule: '30 8 * * *',
    description: 'Alert at 50% and 80% of the redeployment period and escalate at expiry (FR-PLC-21).',
    run: async () => {
      const cal = await getCalendar();
      const today = todayBT();
      const open = await query(
        `select b.*, p.full_name, p.id as person_id from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles p on p.id = c.person_id
          where b.ended_at is null`);
      const counts = { alert50: 0, alert80: 0, escalated: 0 };
      for (const b of open) {
        const total = Math.max(1, workingDaysBetween(b.start_date, b.deadline, cal));
        const used = workingDaysBetween(b.start_date, today, cal);
        const pct = used / total;
        const msg = `${b.full_name} has been on bench since ${displayDate(b.start_date)}. Redeployment deadline ${displayDate(b.deadline)}.`;
        if (today > b.deadline && !b.escalated) {
          await notifyRole('super_admin', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Redeployment deadline missed', body: `ESCALATION: ${msg}` } });
          await createTask({ kind: 'bench_expired', title: `Redeployment deadline passed: ${b.full_name}`, entityType: 'person', entityId: b.person_id,
            assigneeRole: 'operations_manager', priority: 'urgent', dedupeKey: `bench_expired:${b.id}` });
          await query('update bench_periods set escalated = true, alerted_50 = true, alerted_80 = true where id = $1', [b.id]);
          counts.escalated++;
        } else if (pct >= 0.8 && !b.alerted_80) {
          await notifyRole('operations_manager', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: 'Bench timer at 80%', body: msg } });
          await query('update bench_periods set alerted_80 = true, alerted_50 = true where id = $1', [b.id]);
          counts.alert80++;
        } else if (pct >= 0.5 && !b.alerted_50) {
          await notifyRole('operations_manager', { code: 'generic', channels: ['in_app'], vars: { subject: 'Bench timer at 50%', body: msg } });
          await createTask({ kind: 'redeploy', title: `Find a new host for ${b.full_name}`, entityType: 'person', entityId: b.person_id,
            assigneeRole: 'operations_manager', priority: 'high', dueAt: `${b.deadline}T17:00:00+06:00`, dedupeKey: `redeploy:${b.id}` });
          await query('update bench_periods set alerted_50 = true where id = $1', [b.id]);
          counts.alert50++;
        }
      }
      return counts;
    },
  },

  planned_end_outcomes: {
    schedule: '45 8 * * *',
    description: 'Two weeks before a placement ends, mark it Ending and ask the officer to record conversion, move or exit (FR-PLC-24).',
    run: async () => {
      const rows = await query(
        `select pl.id, pl.officer_id, pl.planned_end_date, p.full_name, o.name as host from placements pl
           join person_profiles p on p.id = pl.person_id join organisations o on o.id = pl.org_id
          where pl.status = 'active' and pl.planned_end_date <= $1`, [addDays(todayBT(), 14)]);
      for (const r of rows) {
        await tx(async (db) => {
          await setPlacementStatus(r.id, 'ending', 'Planned end date approaching', null, db);
          await createTask({ kind: 'record_outcome', title: `Record outcome for ${r.full_name} at ${r.host} (ends ${displayDate(r.planned_end_date)})`,
            entityType: 'placement', entityId: r.id, assigneeId: r.officer_id, assigneeRole: r.officer_id ? null : 'operations_manager',
            dueAt: `${r.planned_end_date}T17:00:00+06:00`, dedupeKey: `record_outcome:${r.id}` }, db);
        });
      }
      return { ending: rows.length };
    },
  },

  signing_reminders: {
    schedule: '0 9 * * *',
    description: 'Remind both parties and the officer when agreements stay unsigned (FR-PLC-12).',
    run: async () => {
      const days = await getSetting('placement.sign_reminder_days');
      const rows = await query(
        `select pl.id, pl.org_id, pl.officer_id, pl.contract_id, pl.hpa_id, p.user_id, p.mobile, p.full_name,
                exists (select 1 from agreement_documents d where d.kind = 'employment_contract' and d.agreement_id = pl.contract_id and d.status = 'pending_signature') as contract_pending,
                exists (select 1 from agreement_documents d where d.kind = 'hpa' and d.agreement_id = pl.hpa_id and d.status = 'pending_signature') as hpa_pending
           from placements pl join person_profiles p on p.id = pl.person_id
          where pl.status = 'offered' and not pl.sign_reminder_sent and pl.created_at < now() - make_interval(days => $1)`, [days]);
      for (const r of rows) {
        if (r.contract_pending) await notify({ userId: r.user_id, mobile: r.mobile, code: 'contract_to_sign', vars: { link: link('/app/seeker/contract') } });
        if (r.hpa_pending) {
          for (const u of await hostUsers(r.org_id, ['host_owner'])) await notify({ userId: u.user_id, code: 'hpa_to_sign', vars: { apprentice: r.full_name, link: link('/app/host/agreements') } });
        }
        await createTask({ kind: 'unsigned_agreement', title: `Agreements unsigned after ${days} days: ${r.full_name}`, entityType: 'placement', entityId: r.id,
          assigneeId: r.officer_id, assigneeRole: r.officer_id ? null : 'operations_manager', priority: 'high', dedupeKey: `unsigned:${r.id}` });
        await query('update placements set sign_reminder_sent = true where id = $1', [r.id]);
      }
      return { reminded: rows.length };
    },
  },

  payroll_cycle: {
    schedule: '0 7 * * *',
    description: 'Ask hosts for attendance and finance to prepare payroll on the preparation date; default missing attendance before pay date (FR-PAY-01, 04).',
    run: async () => {
      const today = todayBT();
      const period = periodOf(today);
      const [prepDate, payDate, defaultDays] = await Promise.all([preparationDate(period, pool), payDateFor(period, pool), getSetting('payroll.attendance_default_days')]);
      const out = { requested: 0, defaulted: 0, invoices: 0 };
      if (today >= prepDate && (await createTask({ kind: 'payroll_prepare', title: `Prepare payroll for ${period} (pay date ${displayDate(payDate)})`, entityType: 'payroll',
        assigneeRole: 'finance_officer', priority: 'high', dueAt: `${payDate}T09:00:00+06:00`, dedupeKey: `payroll_prepare:${period}` }))) {
        const orgs = await query(`select distinct org_id from placements where status in ('active','ending')`);
        for (const o of orgs) {
          for (const u of await hostUsers(o.org_id)) {
            await notify({ userId: u.user_id, code: 'attendance_request', vars: { period, deadline: displayDate(addDays(payDate, -defaultDays)), link: link('/app/host/attendance') } });
          }
        }
        out.requested = orgs.length;
      }
      if (today >= addDays(payDate, -defaultDays)) out.defaulted = await tx((db) => defaultMissingAttendance(period, db));
      // Draft host invoices once attendance is settled, for Finance to review and issue.
      if (today >= payDate && !(await one(`select 1 from invoices where period = $1 limit 1`, [period]))) {
        out.invoices = (await tx((db) => generateInvoices(period, null, db)))?.length ?? 0;
        await createTask({ kind: 'invoices_review', title: `Review and issue host invoices for ${period}`, entityType: 'billing', assigneeRole: 'finance_officer', dedupeKey: `invoices_review:${period}` });
      }
      return out;
    },
  },

  invoice_reminders: {
    schedule: '0 10 * * *',
    description: 'Mark invoices overdue and send reminders at 7, 14 and 30 days; alert the Super Admin at the last one (FR-ACC-06).',
    run: async () => {
      const steps = await getSetting('billing.reminder_days');
      await query(`update invoices set status = 'overdue' where status in ('issued','part_paid') and due_date < current_date`);
      const rows = await query(
        `select i.id, i.number, i.org_id, i.total - i.amount_paid as balance, current_date - i.due_date as days, i.reminder_days, o.name
           from invoices i join organisations o on o.id = i.org_id where i.status = 'overdue'`);
      let sent = 0;
      for (const i of rows) {
        const step = [...steps].reverse().find((d) => i.days >= d && !i.reminder_days.includes(d));
        if (!step) continue;
        for (const u of await hostUsers(i.org_id, ['host_owner'])) {
          await notify({ userId: u.user_id, code: 'invoice_reminder', channels: ['in_app', 'email', 'sms'], vars: { number: i.number, days: i.days, balance: money(i.balance) } });
        }
        if (step === Math.max(...steps)) {
          await notifyRole('super_admin', { code: 'generic', channels: ['in_app'], vars: { subject: `Invoice ${i.number} ${i.days} days overdue`, body: `${i.name} owes Nu ${money(i.balance)}.` } });
        }
        await query(`update invoices set reminder_days = array_append(reminder_days, $2) where id = $1`, [i.id, step]);
        sent++;
      }
      return { sent };
    },
  },

  helpdesk_sla: {
    schedule: '*/15 * * * *',
    description: 'Alert on response and resolution breaches, and close resolved tickets after 5 days (FR-HLP-04, 06).',
    run: async () => {
      const breaches = await query(
        `select id, ref, assignee_id, subject, first_response_at is null and response_due < now() and not response_breach_alerted as response,
                status not in ('resolved','closed','converted') and resolution_due < now() and not resolution_breach_alerted as resolution
           from helpdesk_tickets
          where (first_response_at is null and response_due < now() and not response_breach_alerted)
             or (status not in ('resolved','closed','converted') and resolution_due < now() and not resolution_breach_alerted)`);
      for (const t of breaches) {
        const kind = t.response ? 'response' : 'resolution';
        const input = { code: 'generic', channels: ['in_app' as const], vars: { subject: `Ticket ${t.ref}: ${kind} target missed`, body: t.subject } };
        if (t.assignee_id) await notify({ ...input, userId: t.assignee_id });
        await notifyRole('operations_manager', input);
        await query(`update helpdesk_tickets set response_breach_alerted = response_breach_alerted or $2, resolution_breach_alerted = resolution_breach_alerted or $3 where id = $1`,
          [t.id, t.response, t.resolution]);
      }
      const days = await getSetting('helpdesk.auto_close_days');
      const closed = await query(
        `update helpdesk_tickets set status = 'closed', closed_at = now() where status = 'resolved' and resolved_at < now() - make_interval(days => $1) returning id`, [days]);
      return { breaches: breaches.length, closed: closed.length };
    },
  },

  grievance_sla: {
    schedule: '5 * * * *',
    description: 'Flag missed first-contact deadlines and escalate cases past their target date (FR-FDB-04, 06).',
    run: async () => {
      const late = await query(
        `select id, ref, severity, officer_id from grievances where first_contact_at is null and first_contact_due < now() and status not in ('closed','referred')`);
      let firstContact = 0;
      for (const g of late) {
        if (await createTask({ kind: 'grievance_first_contact', title: `First contact overdue on ${g.ref} (severity ${g.severity})`, entityType: 'grievance', entityId: g.id,
          assigneeId: g.officer_id, assigneeRole: g.officer_id ? null : 'grievance_officer', priority: 'urgent', dedupeKey: `grievance_first_contact:${g.id}` })) {
          await notifyRole('operations_manager', { code: 'generic', channels: ['in_app'], vars: { subject: `Grievance ${g.ref}: first contact overdue`, body: `Severity ${g.severity} case has not been contacted.` } });
          firstContact++;
        }
      }
      const overdue = await query(
        `update grievances set escalation_level = greatest(escalation_level, 1), status = case when status in ('new','assigned','under_review') then 'escalated' else status end
          where target_date < now() and status not in ('resolved','closed','referred','escalated') and escalation_level = 0 returning id, ref, severity, target_date`);
      for (const g of overdue) {
        await query(`insert into grievance_actions (grievance_id, action, visible_to_complainant) values ($1, 'escalated_overdue', true)`, [g.id]);
        await notifyRole('operations_manager', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: `Grievance ${g.ref} past target`, body: `Grievance ${g.ref} missed its target of ${displayDateTime(g.target_date)} and was escalated.` } });
        if (g.severity === 1) await notifyRole('super_admin', { code: 'generic', channels: ['in_app', 'sms'], vars: { subject: `Severity 1 grievance ${g.ref} overdue`, body: `Grievance ${g.ref} is past its target date.` } });
        await audit({ actorId: null, action: 'grievance.escalated', entityType: 'grievance', entityId: g.id, details: { reason: 'target date passed' } });
      }
      return { firstContact, escalated: overdue.length };
    },
  },

  candidate_followups: {
    schedule: '0 9 * * 1-6',
    description: 'Create follow-up tasks for candidates not contacted in 30 days and flag unreachable contacts (FR-CND-08, 09).',
    run: async () => {
      const [days, maxAttempts] = await Promise.all([getSetting('candidates.no_contact_days'), getSetting('candidates.max_contact_attempts')]);
      const unverified = await query(
        `update person_profiles set contact_unverified = true where failed_contact_attempts >= $1 and not contact_unverified returning id`, [maxAttempts]);
      const stale = await query(
        `select id, full_name, assigned_officer_id from person_profiles
          where stage in ('registered','contacted','screening','screened','training','ready') and lifecycle = 'job_seeker'
            and coalesce(last_contact_at, created_at) < now() - make_interval(days => $1)`, [days]);
      let created = 0;
      const week = todayBT().slice(0, 8);
      for (const p of stale) {
        if (await createTask({ kind: 'no_contact', title: `No contact in ${days} days: ${p.full_name}`, entityType: 'person', entityId: p.id,
          assigneeId: p.assigned_officer_id, assigneeRole: p.assigned_officer_id ? null : 'field_officer', dedupeKey: `no_contact:${p.id}:${week}` })) created++;
      }
      return { unverified: unverified.length, tasks: created };
    },
  },

  contact_reconfirm: {
    schedule: '0 11 * * *',
    description: 'Ask users to re-confirm their mobile number every 90 days (FR-EE-07).',
    run: async () => {
      const days = await getSetting('auth.contact_reconfirm_days');
      const rows = await query(
        `select u.id from users u where u.status = 'active' and coalesce(u.contact_confirmed_at, u.created_at) < now() - make_interval(days => $1)
            and not exists (select 1 from notifications n where n.user_id = u.id and n.template_code = 'reconfirm_mobile' and n.created_at > now() - make_interval(days => $1))
          limit 500`, [days]);
      for (const u of rows) await notify({ userId: u.id, code: 'reconfirm_mobile', channels: ['sms', 'in_app'] });
      return { asked: rows.length };
    },
  },

  seeker_nudges: {
    schedule: '30 10 * * *',
    description: 'Nudge registered job seekers who have not applied after 14 days (FR-EE-16).',
    run: async () => {
      const days = await getSetting('seeker.nudge_days');
      const rows = await query(
        `select p.id, p.user_id, p.mobile, split_part(p.full_name, ' ', 1) as name,
                (select count(*)::int from vacancies v where v.status = 'open' and (p.dzongkhag_id is null or v.dzongkhag_id = p.dzongkhag_id or v.dzongkhag_id = any(p.preferred_dzongkhags))) as open_jobs
           from person_profiles p
          where p.lifecycle = 'job_seeker' and p.nudged_at is null and p.user_id is not null and p.stage not in ('not_suitable','withdrawn','placed')
            and p.created_at < now() - make_interval(days => $1)
            and not exists (select 1 from applications a where a.person_id = p.id)`, [days]);
      let sent = 0;
      for (const p of rows) {
        if (p.open_jobs > 0) {
          await notify({ userId: p.user_id, mobile: p.mobile, code: 'nudge_apply', vars: { name: p.name, count: p.open_jobs, link: link('/jobs') } });
          sent++;
        }
        await query('update person_profiles set nudged_at = now() where id = $1', [p.id]);
      }
      return { sent };
    },
  },

  interview_reminders: {
    schedule: '0 * * * *',
    description: 'Remind candidates of interviews in the next 24 hours.',
    run: async () => {
      const rows = await query(
        `select i.id, i.scheduled_at, p.user_id, p.mobile, o.name as host from interviews i
           join applications a on a.id = i.application_id join person_profiles p on p.id = a.person_id
           join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id
          where i.status = 'scheduled' and not i.reminder_sent and i.scheduled_at between now() and now() + interval '24 hours'`);
      for (const r of rows) {
        await notify({ userId: r.user_id, mobile: r.mobile, code: 'interview_reminder', vars: { when: displayDateTime(r.scheduled_at), host: r.host } });
        await query('update interviews set reminder_sent = true where id = $1', [r.id]);
      }
      return { reminded: rows.length };
    },
  },

  job_alerts: {
    schedule: '0 7 * * *',
    description: 'Send saved job alerts for new matching vacancies (FR-EE-15).',
    run: async () => {
      const alerts = await query(`select a.id, a.criteria, a.last_sent_at, p.user_id, p.mobile from job_alerts a join person_profiles p on p.id = a.person_id where p.user_id is not null`);
      let sent = 0;
      for (const a of alerts) {
        const c = a.criteria ?? {};
        const m = await one(
          `select count(*)::int as n from vacancies v join organisations o on o.id = v.org_id
            where v.status = 'open' and o.status = 'active' and v.opened_at > coalesce($1, now() - interval '1 day')
              and ($2::text is null or v.title ilike '%' || $2 || '%' or v.description ilike '%' || $2 || '%')
              and ($3::text is null or v.sector_code = $3) and ($4::int is null or v.dzongkhag_id = $4) and ($5::numeric is null or v.wage >= $5)
              and ($6::boolean is not true or v.accommodation) and ($7::boolean is not true or v.first_time_friendly)`,
          [a.last_sent_at, c.q ?? null, c.sector ?? null, c.dzongkhagId ?? null, c.wageMin ?? null, c.accommodation ?? null, c.firstTime ?? null]);
        if (m!.n > 0) {
          await notify({ userId: a.user_id, code: 'job_alert', channels: ['in_app', 'sms'], vars: { count: m!.n }, link: '/jobs' });
          sent++;
        }
        await query('update job_alerts set last_sent_at = now() where id = $1', [a.id]);
      }
      return { sent };
    },
  },

  publish_scheduled_videos: {
    schedule: '*/5 * * * *',
    description: 'Publish scheduled campaign videos whose consents are still confirmed (FR-VID-20, 21).',
    run: async () => {
      const rows = await query(
        `update videos v set status = 'published', published_at = now()
          where v.status = 'scheduled' and v.scheduled_at <= now()
            and not exists (select 1 from video_featured_people f where f.video_id = v.id and f.consent_status <> 'confirmed')
          returning id`);
      for (const r of rows) await audit({ actorId: null, action: 'video.published', entityType: 'video', entityId: r.id, details: { scheduled: true } });
      return { published: rows.length };
    },
  },

  housekeeping: {
    schedule: '30 2 * * *',
    description: 'Remove expired sessions, one-time codes and reset tokens.',
    run: async () => {
      const s = await query(`delete from sessions where last_seen_at + make_interval(secs => idle_timeout_s) < now() - interval '1 day' or revoked_at < now() - interval '30 days' returning id`);
      const o = await query(`delete from otp_codes where expires_at < now() - interval '1 day' returning id`);
      const t = await query(`delete from password_reset_tokens where expires_at < now() - interval '1 day' returning token_hash`);
      return { sessions: s.length, otps: o.length, resetTokens: t.length };
    },
  },
};
