import { type Db, one, pool, query } from '../db/pool.js';
import type { Calendar } from './dates.js';

/**
 * Typed access to config_settings (FR-ADM-10). Values are cached briefly and
 * the cache is cleared whenever a Super Admin changes a value.
 */
export type Deduction = { code: string; label: string; pct: number; enabled: boolean };

export interface Settings {
  'payroll.wage_floor': number;
  'payroll.pay_day': number;
  'payroll.prep_working_days': number;
  'payroll.attendance_default_days': number;
  'payroll.deductions': Deduction[];
  'payroll.bank_file_format': 'generic_csv' | 'bob_csv' | 'bnb_txt';
  'placement.redeploy_working_days': number;
  'placement.bench_pay_pct': number;
  'placement.apprenticeship_months': number;
  'placement.checkin_days': number[];
  'placement.replacement_entitlement': number;
  'placement.replacement_period_days': number;
  'placement.sign_reminder_days': number;
  'labour.max_hours_per_week': number;
  'labour.max_days_per_week': number;
  'labour.min_rest_days': number;
  'labour.min_leave_days': number;
  'billing.invoice_due_days': number;
  'billing.reminder_days': number[];
  'grievance.target_days': Record<string, number>;
  'grievance.first_contact': Record<string, { hours?: number; working_days?: number }>;
  'helpdesk.sla': Record<string, { response_h: number; resolution_h: number }>;
  'helpdesk.auto_close_days': number;
  'auth.consent_version': string;
  'auth.consent_text': string;
  'auth.contact_reconfirm_days': number;
  'candidates.no_contact_days': number;
  'candidates.max_contact_attempts': number;
  'seeker.nudge_days': number;
  'calendar.working_days': number[];
  'calendar.holidays': string[];
  'matching.weights': Record<'skills' | 'scorecard' | 'location' | 'wage' | 'availability', number>;
  'templates.employment_contract': string;
  'templates.hpa': string;
}

export type SettingKey = keyof Settings;

let cache: { at: number; values: Map<string, unknown> } | null = null;
const TTL_MS = 30_000;

async function load(db: Db = pool) {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.values;
  const rows = await query<{ key: string; value: unknown }>('select key, value from config_settings', [], db);
  cache = { at: Date.now(), values: new Map(rows.map((r) => [r.key, r.value])) };
  return cache.values;
}

export function clearSettingsCache() {
  cache = null;
}

export async function getSetting<K extends SettingKey>(key: K, db?: Db): Promise<Settings[K]> {
  const values = await load(db);
  if (!values.has(key)) {
    // Fall back to a direct read in case the key was added after caching.
    const row = await one<{ value: Settings[K] }>('select value from config_settings where key = $1', [key], db ?? pool);
    if (!row) throw new Error(`Missing configuration setting ${key}`);
    return row.value;
  }
  return values.get(key) as Settings[K];
}

export async function getCalendar(db?: Db): Promise<Calendar> {
  return {
    workingDays: await getSetting('calendar.working_days', db),
    holidays: await getSetting('calendar.holidays', db),
  };
}
