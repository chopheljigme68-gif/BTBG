import { describe, expect, it } from 'vitest';
import { blindIndex, decrypt, encrypt, mask } from '../src/lib/crypto.js';
import { addWorkingDays, displayDate, scheduledDaysInPeriod, workingDaysBetween } from '../src/lib/dates.js';
import { containsProfanity } from '../src/lib/profanity.js';
import { calculatePay } from '../src/modules/payroll/service.js';
import { availabilityScore, combine, locationScore, skillsScore, wageScore } from '../src/modules/vacancies/matching.js';

const cal = { workingDays: [1, 2, 3, 4, 5, 6], holidays: ['2026-11-11'] };

describe('pay calculation', () => {
  const base = { wage: 10000, fullMonthDays: 25, worked: 25, paidLeave: 0, benchDays: 0, benchPct: 75, deductions: [], adjustments: [] };

  it('pays the full wage for a full month', () => {
    expect(calculatePay(base)).toMatchObject({ gross: 10000, net: 10000 });
  });

  it('pro-rates absences and pays bench days at the bench rate', () => {
    const r = calculatePay({ ...base, worked: 15, benchDays: 10 });
    expect(r.gross).toBe(6000 + 3000);
  });

  it('never pays more than the monthly wage', () => {
    expect(calculatePay({ ...base, worked: 26, paidLeave: 2 }).gross).toBe(10000);
  });

  it('applies enabled deductions and corrections', () => {
    const r = calculatePay({ ...base, deductions: [{ label: 'NPPF', pct: 5, enabled: true }, { label: 'Tax', pct: 10, enabled: false }], adjustments: [{ reason: 'Underpaid in May', amount: 250 }] });
    expect(r).toMatchObject({ gross: 10000, totalDeductions: 500, totalAdjustments: 250, net: 9750 });
  });
});

describe('dates and calendar', () => {
  it('skips Sundays and holidays when adding working days', () => {
    expect(addWorkingDays('2026-11-07', 2, cal)).toBe('2026-11-10'); // Sat + Mon, Tue
    expect(addWorkingDays('2026-11-10', 1, cal)).toBe('2026-11-12'); // holiday skipped
  });
  it('counts scheduled days in a month', () => {
    expect(scheduledDaysInPeriod('2026-11', cal)).toBe(24);
    expect(workingDaysBetween('2026-11-02', '2026-11-09', cal)).toBe(6);
  });
  it('formats dates as DD/MM/YYYY', () => {
    expect(displayDate('2026-10-13')).toBe('13/10/2026');
  });
});

describe('field encryption', () => {
  it('round-trips and never stores plain text', () => {
    const c = encrypt('11506000001')!;
    expect(c).not.toContain('11506000001');
    expect(decrypt(c)).toBe('11506000001');
    expect(blindIndex('11506000001')).toBe(blindIndex('11506000001'));
    expect(mask('11506000001')).toMatch(/0001$/);
  });
});

describe('matching scores', () => {
  it('weights the parts into a 0-100 score', () => {
    const b = { skills: skillsScore([{ skill_id: 1 }, { skill_id: 2 }], [{ skill_id: 1, level: 3 }]), scorecard: 0.8, location: locationScore({ dzongkhag_id: 1, gewog_id: 1, accommodation: false }, { dzongkhag_id: 1, gewog_id: 1, preferred_dzongkhags: [], willing_to_relocate: false }), wage: wageScore(10000, 9000), availability: availabilityScore('2026-11-01', '2026-10-01') };
    const score = combine(b, { skills: 30, scorecard: 25, location: 20, wage: 15, availability: 10 });
    expect(score).toBeGreaterThan(50);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('Q&A moderation filter', () => {
  it('catches obvious profanity and leaves normal questions alone', () => {
    expect(containsProfanity('What does a commis cook earn?')).toBe(false);
    expect(containsProfanity('this is sh1t')).toBe(true);
  });
});
