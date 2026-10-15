import ExcelJS from 'exceljs';
import type { Response } from 'express';
import { z } from 'zod';
import { one, pool, query } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { addDays, todayBT } from '../../lib/dates.js';
import { createModule, zDate } from '../../lib/http.js';
import { reportPdf } from '../../lib/pdf.js';
import { ageing, cashExposure } from '../billing/service.js';
import { hostReport } from '../hosts/routes.js';

/** Oversight dashboard (SRS 3.3.1) and reports (SRS 3.8). */
const m = createModule('/reports', 'Dashboard and reports');
export default m;

const VIEW = { any: ['dashboard.view', 'reports.view'] };

// FR-ADM-03: every figure can be filtered by Dzongkhag, gewog, sector, host, role and dates.
const filters = z.object({
  dzongkhagId: z.coerce.number().int().optional(),
  gewogId: z.coerce.number().int().optional(),
  sector: z.string().optional(),
  orgId: z.string().uuid().optional(),
  role: z.string().trim().max(60).optional(),
  from: zDate.optional(),
  to: zDate.optional(),
});
type Filters = z.infer<typeof filters>;

/**
 * Filter values become positional parameters; each report refers to them by a
 * fixed number so the same SQL fragments work everywhere.
 *   $1 dzongkhag  $2 gewog  $3 sector  $4 org  $5 role  $6 from  $7 to
 */
function params(f: Filters) {
  const to = f.to ?? todayBT();
  const from = f.from ?? addDays(to, -365);
  return [f.dzongkhagId ?? null, f.gewogId ?? null, f.sector ?? null, f.orgId ?? null, f.role ?? null, from, to];
}
const F = {
  person: (p: string) => `($1::int is null or ${p}.dzongkhag_id = $1) and ($2::int is null or ${p}.gewog_id = $2)`,
  org: (o: string) => `($1::int is null or ${o}.dzongkhag_id = $1) and ($2::int is null or ${o}.gewog_id = $2) and ($3::text is null or ${o}.sector_code = $3) and ($4::uuid is null or ${o}.id = $4)`,
  placement: (pl: string, o: string) => `${F.org(o)} and ($5::text is null or ${pl}.role_title ilike '%' || $5 || '%')`,
  vacancy: (v: string, o: string) =>
    `($1::int is null or ${v}.dzongkhag_id = $1) and ($2::int is null or ${v}.gewog_id = $2) and ($3::text is null or ${v}.sector_code = $3) and ($4::uuid is null or ${o}.id = $4) and ($5::text is null or ${v}.title ilike '%' || $5 || '%')`,
  range: (col: string) => `${col}::date between $6::date and $7::date`,
};
// Always true; it declares every parameter's type so a query may leave some filters unused.
const keepAll = `(select true from (select $1::int, $2::int, $3::text, $4::uuid, $5::text, $6::date, $7::date) as typed)`;

async function dashboard(f: Filters) {
  const p = params(f);
  const counts = await one(
    `select
       (select count(*)::int from person_profiles pp where pp.lifecycle = 'job_seeker' and ${F.person('pp')}) as "registeredJobSeekers",
       (select count(*)::int from person_profiles pp where pp.stage in ('screening','screened') and ${F.person('pp')}) as "inScreening",
       (select count(*)::int from person_profiles pp where pp.stage = 'training' and ${F.person('pp')}) as "inTraining",
       (select count(*)::int from placements pl join organisations o on o.id = pl.org_id where pl.status in ('active','ending') and ${F.placement('pl', 'o')}) as "onPlacement",
       (select count(*)::int from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles pp on pp.id = c.person_id
          where b.ended_at is null and ${F.person('pp')}) as "onBench",
       (select count(*)::int from placements pl join organisations o on o.id = pl.org_id where pl.outcome = 'conversion' and ${F.placement('pl', 'o')} and ${F.range('pl.outcome_at')}) as conversions,
       (select count(*)::int from placements pl join organisations o on o.id = pl.org_id where pl.outcome = 'exit' and ${F.placement('pl', 'o')} and ${F.range('pl.outcome_at')}) as exits,
       (select count(*)::int from vacancies v join organisations o on o.id = v.org_id where v.status = 'open' and ${F.vacancy('v', 'o')}) as "openVacancies",
       (select count(*)::int from organisations o where o.status = 'active' and o.verification_status = 'verified' and ${F.org('o')}) as "activeHosts"
       where ${keepAll}`, p);

  // FR-ADM-02: the four MVP tests.
  const mvp = await one(
    `with shared as (select distinct o.id from applications a join vacancies v on v.id = a.vacancy_id join organisations o on o.id = v.org_id
                      where a.shared_with_host_at is not null and ${F.vacancy('v', 'o')} and ${F.range('a.shared_with_host_at')}),
          agreed as (select distinct o.id from interviews i join applications a on a.id = i.application_id join vacancies v on v.id = a.vacancy_id
                       join organisations o on o.id = v.org_id where i.status <> 'cancelled' and ${F.vacancy('v', 'o')} and ${F.range('i.created_at')}),
          started as (select pl.* from placements pl join organisations o on o.id = pl.org_id
                       where pl.status in ('active','ending','ended','converted') and ${F.placement('pl', 'o')} and ${F.range('pl.start_date')}),
          invoiced as (select i.org_id, bool_and(i.status = 'paid') as all_paid from invoices i join organisations o on o.id = i.org_id
                        where i.status not in ('draft','written_off') and ${F.org('o')} and ${F.range('i.issue_date')} group by i.org_id),
          due90 as (select * from started where start_date <= current_date - 90)
     select (select count(*) from agreed)::int as "hostsAgreeingToInterview", (select count(*) from shared)::int as "hostsShownCandidates",
            (select count(*) from started)::int as "matchesStarted",
            (select count(*) filter (where all_paid) from invoiced)::int as "hostsPayingNamedPrice", (select count(*) from invoiced)::int as "hostsInvoiced",
            (select count(*) filter (where status in ('active','ending','converted') or actual_end_date >= start_date + 90) from due90)::int as "retained90",
            (select count(*) from due90)::int as "eligible90"
      where ${keepAll}`, p);
  const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return {
    counts,
    mvp: {
      hostsAgreeingToInterview: { value: mvp!.hostsAgreeingToInterview, of: mvp!.hostsShownCandidates, pct: pct(mvp!.hostsAgreeingToInterview, mvp!.hostsShownCandidates) },
      matchesStarted: { value: mvp!.matchesStarted },
      hostsPayingNamedPrice: { value: mvp!.hostsPayingNamedPrice, of: mvp!.hostsInvoiced, pct: pct(mvp!.hostsPayingNamedPrice, mvp!.hostsInvoiced) },
      retainedAt90Days: { value: mvp!.retained90, of: mvp!.eligible90, pct: pct(mvp!.retained90, mvp!.eligible90) },
    },
    filters: { from: p[5], to: p[6] },
  };
}

/** FR-ADM-04: what needs attention today. */
async function riskPanel(f: Filters) {
  const p = params(f);
  const [checkins, bench, invoices, grievances, contacts] = await Promise.all([
    query(`select c.id, c.placement_id as "placementId", c.day, c.party, c.due_date as "dueDate", pp.full_name as apprentice, o.name as host, u.full_name as officer
             from checkins c join placements pl on pl.id = c.placement_id join person_profiles pp on pp.id = pl.person_id join organisations o on o.id = pl.org_id
             left join users u on u.id = pl.officer_id
            where c.completed_at is null and c.due_date < current_date and pl.status in ('active','ending') and ${F.placement('pl', 'o')} and ${keepAll}
            order by c.due_date limit 100`, p),
    query(`select b.id, pp.full_name as apprentice, b.start_date as "startDate", b.deadline, (b.deadline - current_date) as "daysLeft", pp.id as "personId"
             from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles pp on pp.id = c.person_id
            where b.ended_at is null and b.deadline - current_date <= 5 and ${F.person('pp')} and ${keepAll} order by b.deadline`, p),
    query(`select i.id, i.number, o.name as host, i.due_date as "dueDate", (current_date - i.due_date) as "daysOverdue", i.total - i.amount_paid as balance
             from invoices i join organisations o on o.id = i.org_id
            where i.status in ('issued','part_paid','overdue') and i.due_date < current_date and ${F.org('o')} and ${keepAll} order by i.due_date`, p),
    query(`select g.id, g.ref, g.severity, g.category, g.status, g.target_date as "targetDate", o.name as host
             from grievances g left join organisations o on o.id = g.against_org_id
            where g.status not in ('resolved','closed','referred') and g.target_date < now() and ($4::uuid is null or g.against_org_id = $4) and ${keepAll}
            order by g.severity, g.target_date`, p),
    query(`select pp.id, pp.full_name as name, pp.mobile, pp.failed_contact_attempts as attempts, pp.last_contact_at as "lastContactAt"
             from person_profiles pp where pp.contact_unverified and ${F.person('pp')} and ${keepAll} order by pp.updated_at desc limit 100`, p),
  ]);
  return { overdueCheckins: checkins, redeploymentNearExpiry: bench, unpaidInvoices: invoices, overdueGrievances: grievances, unverifiedContacts: contacts };
}

/** FR-ADM-05: seasonal demand by month from host peak months and vacancy dates. */
async function seasonalDemand(f: Filters) {
  const p = params(f);
  return query(
    `with months as (select generate_series(1, 12) as m)
     select m as month,
            (select count(*)::int from organisations o where m = any(o.peak_months) and o.status = 'active' and ${F.org('o')}) as "hostsInPeak",
            (select coalesce(sum(v.openings), 0)::int from vacancies v join organisations o on o.id = v.org_id
              where ${F.vacancy('v', 'o')} and (extract(month from v.start_date) = m
                    or (v.is_seasonal and m between extract(month from v.season_start) and extract(month from v.season_end)))) as "openingsStarting"
       from months where ${keepAll} order by m`, p);
}

/** FR-RPT-01 standard reports. */
async function standardReport(f: Filters) {
  const p = params(f);
  const base = `from placements pl join organisations o on o.id = pl.org_id where ${F.placement('pl', 'o')} and ${keepAll}`;
  const [byStatus, retention, conversion, timeToFill, redeploy, bench, grievances, revenue] = await Promise.all([
    query(`select pl.status, count(*)::int as count ${base} group by pl.status order by count desc`, p),
    one(`select ${[30, 60, 90].map((d) => `count(*) filter (where pl.start_date <= current_date - ${d})::int as "eligible${d}",
            count(*) filter (where pl.start_date <= current_date - ${d} and (pl.status in ('active','ending','converted') or pl.actual_end_date >= pl.start_date + ${d}))::int as "retained${d}"`).join(',')}
         ${base} and pl.status in ('active','ending','ended','converted') and ${F.range('pl.start_date')}`, p),
    one(`select count(*) filter (where pl.outcome = 'conversion')::int as conversions, count(*) filter (where pl.outcome is not null)::int as outcomes
         ${base} and ${F.range('pl.start_date')}`, p),
    one(`select round(avg(first_start - v.opened_at::date), 1) as "avgDays", count(*)::int as vacancies
           from (select pl.vacancy_id, min(pl.start_date) as first_start from placements pl where pl.status in ('active','ending','ended','converted','contracted') group by pl.vacancy_id) x
           join vacancies v on v.id = x.vacancy_id join organisations o on o.id = v.org_id
          where v.opened_at is not null and ${F.vacancy('v', 'o')} and ${F.range('v.opened_at')}`, p),
    one(`select count(*)::int as "benchPeriods", count(*) filter (where b.end_reason = 'Redeployed')::int as redeployed,
                count(*) filter (where b.ended_at is not null and b.ended_at::date <= b.deadline and b.end_reason = 'Redeployed')::int as "withinDeadline"
           from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles pp on pp.id = c.person_id
          where ${F.person('pp')} and ${F.range('b.start_date')} and ${keepAll}`, p),
    one(`select coalesce(sum(coalesce(b.ended_at::date, current_date) - b.start_date), 0)::int as "benchDays"
           from bench_periods b join employment_contracts c on c.id = b.contract_id join person_profiles pp on pp.id = c.person_id
          where ${F.person('pp')} and ${F.range('b.start_date')} and ${keepAll}`, p),
    query(`select g.category, count(*)::int as opened, count(*) filter (where g.status in ('resolved','closed'))::int as resolved,
                  round(avg(extract(epoch from (g.closed_at - g.created_at)) / 86400) filter (where g.closed_at is not null), 1) as "avgDaysToClose"
             from grievances g where ($4::uuid is null or g.against_org_id = $4) and ${F.range('g.created_at')} and ${keepAll} group by g.category order by opened desc`, p),
    one(`select coalesce(sum(i.total), 0) as invoiced, coalesce(sum(i.amount_paid), 0) as collected,
                coalesce(sum(i.total - i.amount_paid) filter (where i.status in ('issued','part_paid','overdue')), 0) as receivable
           from invoices i join organisations o on o.id = i.org_id where i.status <> 'draft' and ${F.org('o')} and ${F.range('i.issue_date')} and ${keepAll}`, p),
  ]);
  const rate = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
  return {
    from: p[5], to: p[6],
    placementsByStatus: byStatus,
    retention: [30, 60, 90].map((d) => ({ day: d, retained: retention![`retained${d}`], eligible: retention![`eligible${d}`], pct: rate(retention![`retained${d}`], retention![`eligible${d}`]) })),
    conversionRate: { ...conversion, pct: rate(conversion!.conversions, conversion!.outcomes) },
    timeToFill: timeToFill,
    redeploymentRate: { ...redeploy, pct: rate(redeploy!.redeployed, redeploy!.benchPeriods) },
    benchDays: bench!.benchDays,
    grievances,
    revenue,
    receivablesAgeing: await ageing(pool),
  };
}

/** FR-RPT-03 impact report: reached, trained, placed, retained and converted by gender, Dzongkhag and sector. */
async function impactReport(f: Filters) {
  const p = params(f);
  const funnel = (group: string, join = '') =>
    query(`select ${group} as "group",
                  count(distinct pp.id)::int as reached,
                  count(distinct pp.id) filter (where exists (select 1 from training_records t where t.person_id = pp.id))::int as trained,
                  count(distinct pp.id) filter (where pl.id is not null)::int as placed,
                  count(distinct pp.id) filter (where pl.start_date <= current_date - 90 and (pl.status in ('active','ending','converted') or pl.actual_end_date >= pl.start_date + 90))::int as "retained90",
                  count(distinct pp.id) filter (where pl.outcome = 'conversion')::int as converted
             from person_profiles pp
             left join placements pl on pl.person_id = pp.id and pl.status in ('active','ending','ended','converted')
             left join organisations o on o.id = pl.org_id
             left join dzongkhags d on d.id = pp.dzongkhag_id ${join}
            where ${F.person('pp')} and ($3::text is null or o.sector_code = $3) and ($4::uuid is null or o.id = $4) and ($5::text is null or pl.role_title ilike '%' || $5 || '%')
              and ${F.range('pp.created_at')}
            group by 1 order by reached desc`, p);
  const [total, byGender, byDzongkhag, bySector] = await Promise.all([
    funnel(`'All'`),
    funnel(`coalesce(pp.gender, 'not recorded')`),
    funnel(`coalesce(d.name, 'not recorded')`),
    funnel(`coalesce(s.name, 'Not placed')`, 'left join sectors s on s.code = o.sector_code'),
  ]);
  return { from: p[5], to: p[6], total: total[0] ?? null, byGender, byDzongkhag, bySector };
}

m.route({ method: 'get', path: '/dashboard', summary: 'Live dashboard counts and MVP measures', access: VIEW, query: filters }, async ({ query: q }) => dashboard(q));
m.route({ method: 'get', path: '/risks', summary: 'Risk panel', access: VIEW, query: filters }, async ({ query: q }) => riskPanel(q));
m.route({ method: 'get', path: '/seasonal', summary: 'Seasonal demand by month', access: VIEW, query: filters }, async ({ query: q }) => seasonalDemand(q));
m.route({ method: 'get', path: '/standard', summary: 'Standard operating report', access: { any: ['reports.view'] }, query: filters }, async ({ query: q }) => standardReport(q));
m.route({ method: 'get', path: '/impact', summary: 'Impact report for funders and government', access: { any: ['reports.view'] }, query: filters }, async ({ query: q }) => impactReport(q));
m.route({ method: 'get', path: '/exposure', summary: 'Cash exposure', access: { any: ['billing.view', 'reports.view'] } }, async () => cashExposure(pool));
m.route({ method: 'get', path: '/hosts/:orgId', summary: 'Host report for one employer', access: { any: ['reports.view', 'hosts.view'] }, query: z.object({ from: zDate.optional(), to: zDate.optional() }) },
  async ({ params: pr, query: q }) => hostReport({ orgId: pr.orgId }, q.from, q.to));

m.route({ method: 'get', path: '/filters', summary: 'Values for the dashboard filters', access: VIEW }, async () => {
  const [dzongkhags, gewogs, sectors, hosts] = await Promise.all([
    query('select id, name from dzongkhags order by name'),
    query('select id, dzongkhag_id as "dzongkhagId", name from gewogs order by name'),
    query('select code, name from sectors order by name'),
    query(`select id, name from organisations order by name`),
  ]);
  return { dzongkhags, gewogs, sectors, hosts };
});

// ---------------------------------------------------------------------------
// FR-ADM-06: every figure exports to Excel and PDF
// ---------------------------------------------------------------------------
type Section = { heading: string; columns: string[]; rows: Array<Array<string | number>> };

const fromObjects = (heading: string, rows: Array<Record<string, any>>): Section => {
  const columns = rows.length ? Object.keys(rows[0]) : ['(no rows)'];
  return { heading, columns, rows: rows.map((r) => columns.map((c) => (r[c] === null || r[c] === undefined ? '' : r[c] instanceof Date ? r[c].toISOString().slice(0, 10) : r[c]))) };
};
const fromRecord = (heading: string, rec: Record<string, any>): Section => ({
  heading, columns: ['Measure', 'Value'],
  rows: Object.entries(rec).map(([k, v]) => [k, typeof v === 'object' && v !== null ? Object.entries(v).map(([a, b]) => `${a}: ${b ?? '-'}`).join(', ') : v ?? '']),
});

async function sectionsFor(report: string, f: Filters): Promise<{ title: string; sections: Section[] }> {
  if (report === 'dashboard') {
    const [d, r] = await Promise.all([dashboard(f), riskPanel(f)]);
    return {
      title: 'BTBG dashboard',
      sections: [fromRecord('Programme counts', d.counts!), fromRecord('MVP success measures', d.mvp), fromObjects('Overdue check-ins', r.overdueCheckins),
        fromObjects('Redeployment timers near expiry', r.redeploymentNearExpiry), fromObjects('Unpaid invoices', r.unpaidInvoices),
        fromObjects('Grievances past target', r.overdueGrievances), fromObjects('Unverified contacts', r.unverifiedContacts)],
    };
  }
  if (report === 'standard') {
    const s = await standardReport(f);
    return {
      title: `BTBG standard report ${s.from} to ${s.to}`,
      sections: [fromObjects('Placements by status', s.placementsByStatus), fromObjects('Retention', s.retention),
        fromRecord('Conversion, time to fill, redeployment and bench', { conversionRate: s.conversionRate, timeToFill: s.timeToFill, redeploymentRate: s.redeploymentRate, benchDays: s.benchDays }),
        fromObjects('Grievances', s.grievances), fromRecord('Revenue', s.revenue!), fromObjects('Receivables ageing', s.receivablesAgeing)],
    };
  }
  if (report === 'impact') {
    const i = await impactReport(f);
    return {
      title: `BTBG impact report ${i.from} to ${i.to}`,
      sections: [fromObjects('Overall', i.total ? [i.total] : []), fromObjects('By gender', i.byGender), fromObjects('By Dzongkhag', i.byDzongkhag), fromObjects('By sector', i.bySector)],
    };
  }
  const s = await seasonalDemand(f);
  return { title: 'Seasonal demand', sections: [fromObjects('Hosts in peak season and openings by month', s)] };
}

async function sendExcel(res: Response, title: string, sections: Section[]) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'BTBG';
  for (const s of sections) {
    const ws = wb.addWorksheet(s.heading.replace(/[*?:\\/[\]]/g, '').slice(0, 31));
    ws.addRow(s.columns).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A2C5C' } };
    for (const r of s.rows) ws.addRow(r);
    ws.columns.forEach((c) => (c.width = 20));
  }
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.xlsx"`);
  res.send(Buffer.from(await wb.xlsx.writeBuffer()));
}

m.route({ method: 'get', path: '/export', summary: 'Export a report to Excel or PDF', access: { any: ['reports.export'] },
  query: filters.extend({ report: z.enum(['dashboard', 'standard', 'impact', 'seasonal']), format: z.enum(['xlsx', 'pdf']).default('xlsx') }) },
async ({ res, query: q, auth, ip }) => {
  const { report, format, ...f } = q;
  const { title, sections } = await sectionsFor(report, f);
  await audit({ actorId: auth.userId, action: 'report.exported', entityType: 'report', details: { report, format, filters: f }, ip });
  if (format === 'xlsx') return sendExcel(res, title, sections);
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `attachment; filename="${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.pdf"`);
  res.send(await reportPdf(title, sections));
});
