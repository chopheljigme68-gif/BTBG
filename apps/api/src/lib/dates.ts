/**
 * Date helpers. All business dates are Bhutan Time (UTC+06:00, no DST) and
 * handled as 'YYYY-MM-DD' strings so they never drift across time zones.
 */
const BTT_OFFSET_MS = 6 * 60 * 60 * 1000;

export type Calendar = { workingDays: number[]; holidays: string[] };

export function todayBT(now = new Date()): string {
  return new Date(now.getTime() + BTT_OFFSET_MS).toISOString().slice(0, 10);
}

export function parseDate(d: string): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function fmt(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  const x = parseDate(d);
  x.setUTCDate(x.getUTCDate() + n);
  return fmt(x);
}

export function addMonths(d: string, n: number): string {
  const x = parseDate(d);
  const day = x.getUTCDate();
  x.setUTCDate(1);
  x.setUTCMonth(x.getUTCMonth() + n);
  const last = new Date(Date.UTC(x.getUTCFullYear(), x.getUTCMonth() + 1, 0)).getUTCDate();
  x.setUTCDate(Math.min(day, last));
  return fmt(x);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 86_400_000);
}

const isoWeekday = (d: Date) => ((d.getUTCDay() + 6) % 7) + 1;

export function isWorkingDay(d: string, cal: Calendar): boolean {
  return cal.workingDays.includes(isoWeekday(parseDate(d))) && !cal.holidays.includes(d);
}

export function addWorkingDays(d: string, n: number, cal: Calendar): string {
  let cur = d;
  let added = 0;
  const step = n >= 0 ? 1 : -1;
  while (added < Math.abs(n)) {
    cur = addDays(cur, step);
    if (isWorkingDay(cur, cal)) added++;
  }
  return cur;
}

/** Working days in (from, to], i.e. counting `to` but not `from`. */
export function workingDaysBetween(from: string, to: string, cal: Calendar): number {
  if (to <= from) return 0;
  let n = 0;
  for (let cur = addDays(from, 1); cur <= to; cur = addDays(cur, 1)) if (isWorkingDay(cur, cal)) n++;
  return n;
}

/** Working days inside a calendar month, optionally clipped to [from, to]. */
export function scheduledDaysInPeriod(period: string, cal: Calendar, from?: string, to?: string): number {
  const start = `${period}-01`;
  const end = fmt(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)));
  const lo = from && from > start ? from : start;
  const hi = to && to < end ? to : end;
  if (hi < lo) return 0;
  return workingDaysBetween(addDays(lo, -1), hi, cal);
}

export function periodBounds(period: string): { start: string; end: string } {
  const start = `${period}-01`;
  const end = fmt(new Date(Date.UTC(Number(period.slice(0, 4)), Number(period.slice(5, 7)), 0)));
  return { start, end };
}

export function periodOf(d: string): string {
  return d.slice(0, 7);
}

/** Format for display: DD/MM/YYYY (NFR-LOC-03). */
export function displayDate(d: string | Date | null | undefined): string {
  if (!d) return '';
  const s = typeof d === 'string' ? d.slice(0, 10) : todayBT(d);
  return `${s.slice(8, 10)}/${s.slice(5, 7)}/${s.slice(0, 4)}`;
}

/** Timestamp shifted into Bhutan time for messages: DD/MM/YYYY HH:mm. */
export function displayDateTime(ts: Date | string): string {
  const d = new Date(new Date(ts).getTime() + BTT_OFFSET_MS);
  const iso = d.toISOString();
  return `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)} ${iso.slice(11, 16)}`;
}

/** End of a Bhutan calendar day as a UTC instant. */
export function endOfDayBT(d: string): Date {
  return new Date(parseDate(d).getTime() + 86_400_000 - 1 - BTT_OFFSET_MS);
}
