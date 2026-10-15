import { one, query } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { createModule } from '../../lib/http.js';
import { displayDate } from '../../lib/dates.js';
import { getSetting } from '../../lib/settings.js';

/** Reference data, landing page figures and certificate verification. No login needed. */
const m = createModule('/public', 'Public');
export default m;

m.route({ method: 'get', path: '/reference', summary: 'Dzongkhags, gewogs, sectors and skills for forms', access: 'public' }, async ({ res }) => {
  const [dzongkhags, gewogs, sectors, skills] = await Promise.all([
    query('select id, name from dzongkhags order by name'),
    query('select id, dzongkhag_id as "dzongkhagId", name, kind from gewogs order by name'),
    query('select code, name from sectors order by name'),
    query('select id, name, sector_code as "sectorCode" from skills order by name'),
  ]);
  res.setHeader('cache-control', 'public, max-age=600');
  return { dzongkhags, gewogs, sectors, skills };
});

m.route({ method: 'get', path: '/consent', summary: 'Current privacy consent text and version', access: 'public' }, async () => ({
  version: await getSetting('auth.consent_version'),
  text: await getSetting('auth.consent_text'),
}));

m.route({ method: 'get', path: '/stats', summary: 'Landing page figures', access: 'public' }, async ({ res }) => {
  const s = await one(`select
      (select count(*)::int from vacancies v join organisations o on o.id = v.org_id where v.status = 'open' and o.status = 'active') as "openJobs",
      (select count(*)::int from organisations where verification_status = 'verified' and status = 'active') as "verifiedHosts",
      (select count(*)::int from placements where status in ('active','ending','ended','converted')) as placements,
      (select count(*)::int from placements where outcome = 'conversion') as conversions,
      (select count(*)::int from videos where status = 'published') as videos,
      (select count(distinct dzongkhag_id)::int from vacancies where status = 'open') as dzongkhags`);
  res.setHeader('cache-control', 'public, max-age=300');
  return s;
});

/** FR-EE-55: anyone can verify a certificate by its code. */
m.route({ method: 'get', path: '/certificates/:code', summary: 'Verify a certificate', access: 'public' }, async ({ params }) => {
  const c = await one(
    `select c.title, c.programme, c.outcome, c.nc_mapping as "ncMapping", c.issued_at, c.revoked_at, c.verification_code as code, p.full_name as name
       from certificates c join person_profiles p on p.id = c.person_id where c.verification_code = $1`,
    [params.code.toUpperCase()]);
  if (!c) throw notFound('Certificate');
  return {
    valid: !c.revoked_at, code: c.code, name: c.name, title: c.title, programme: c.programme, outcome: c.outcome, ncMapping: c.ncMapping,
    issuedOn: displayDate(c.issued_at), revokedOn: c.revoked_at ? displayDate(c.revoked_at) : null,
  };
});
