import type { Request, Response } from 'express';
import { createReadStream, statSync } from 'node:fs';
import { one, query } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { displayDate } from '../../lib/dates.js';
import { forbidden, notFound } from '../../lib/errors.js';
import { createModule } from '../../lib/http.js';
import { agreementPdf, certificatePdf, invoicePdf, payslipPdf } from '../../lib/pdf.js';
import { contentTypeFor, localPath, signedUrl } from '../../lib/storage.js';
import type { AuthContext } from '../../middleware/auth.js';
import { verifyUrl } from '../certificates/service.js';

/**
 * Every stored file is served through here after an access check. Large
 * media supports HTTP range requests (local disk) or a short-lived signed URL (Supabase).
 */
const m = createModule('/files', 'Files');
export default m;

export async function sendStored(req: Request, res: Response, key: string, opts: { download?: string; cache?: string } = {}) {
  const type = contentTypeFor(key);
  const signed = await signedUrl(key, 3600);
  if (signed) return res.redirect(302, signed);
  const p = localPath(key)!;
  let size: number;
  try {
    size = statSync(p).size;
  } catch {
    throw notFound('File');
  }
  res.setHeader('content-type', type);
  res.setHeader('accept-ranges', 'bytes');
  res.setHeader('cache-control', opts.cache ?? 'private, max-age=300');
  if (opts.download) res.setHeader('content-disposition', `attachment; filename="${opts.download}"`);
  const range = req.headers.range?.match(/bytes=(\d*)-(\d*)/);
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || start > end) return res.status(416).setHeader('content-range', `bytes */${size}`).end();
    res.status(206).setHeader('content-range', `bytes ${start}-${end}/${size}`);
    res.setHeader('content-length', end - start + 1);
    return createReadStream(p, { start, end }).pipe(res);
  }
  res.setHeader('content-length', size);
  createReadStream(p).pipe(res);
}

function sendPdf(res: Response, pdf: Buffer, filename: string, inline = true) {
  res.setHeader('content-type', 'application/pdf');
  res.setHeader('content-disposition', `${inline ? 'inline' : 'attachment'}; filename="${filename}"`);
  res.setHeader('cache-control', 'private, no-store');
  res.send(pdf);
}

const isPersonOwner = async (auth: AuthContext | null, personId: string) =>
  Boolean(auth && (await one('select 1 from person_profiles where id = $1 and user_id = $2', [personId, auth.userId])));

m.route({ method: 'get', path: '/agreements/:docId', summary: 'Signed or draft agreement PDF', access: 'user' }, async ({ req, res, params, auth, ip }) => {
  const d = await one(
    `select d.*, coalesce(c.person_id, pl.person_id) as person_id, h.org_id
       from agreement_documents d
       left join employment_contracts c on d.kind = 'employment_contract' and c.id = d.agreement_id
       left join host_placement_agreements h on d.kind = 'hpa' and h.id = d.agreement_id
       left join placements pl on pl.hpa_id = h.id
      where d.id = $1 limit 1`, [params.docId]);
  if (!d) throw notFound('Document');
  const allowed = auth.permissions.has('placements.view')
    || (d.kind === 'employment_contract' && (await isPersonOwner(auth, d.person_id)))
    || (d.kind === 'hpa' && auth.orgId === d.org_id && auth.permissions.has('host.admin'));
  if (!allowed) throw forbidden();
  await audit({ actorId: auth.userId, action: 'data.agreement_downloaded', entityType: d.kind, entityId: d.agreement_id, ip });
  if (d.file_path) return sendStored(req, res, d.file_path, { download: `${d.kind}-v${d.version}.pdf` });
  sendPdf(res, await agreementPdf({ title: d.kind === 'hpa' ? 'Host Placement Agreement' : 'Employment Contract', reference: d.agreement_id.slice(0, 8).toUpperCase(), version: d.version, body: d.body_text }), `${d.kind}-v${d.version}-draft.pdf`);
});

m.route({ method: 'get', path: '/payslips/:id', summary: 'Payslip PDF', access: 'user' }, async ({ res, params, auth }) => {
  const s = await one(
    `select ps.*, r.period, r.pay_date, p.full_name, p.bank_account_last4 from payslips ps join payroll_runs r on r.id = ps.run_id
       join person_profiles p on p.id = ps.person_id where ps.id = $1`, [params.id]);
  if (!s) throw notFound('Payslip');
  const own = await isPersonOwner(auth, s.person_id);
  if (!(own && s.published_at) && !auth.permissions.has('payroll.view')) throw forbidden();
  const lines = await query('select kind, label, amount from payslip_lines where payslip_id = $1', [params.id]);
  sendPdf(res, await payslipPdf({ name: s.full_name, period: s.period, payDate: displayDate(s.pay_date), lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })),
    gross: Number(s.gross), deductions: Number(s.total_deductions), adjustments: Number(s.total_adjustments), net: Number(s.net), bankLast4: s.bank_account_last4 }), `payslip-${s.period}.pdf`);
});

m.route({ method: 'get', path: '/certificates/:code', summary: 'Certificate PDF (the code is the access key)', access: 'public' }, async ({ res, params }) => {
  const c = await one(`select c.*, p.full_name from certificates c join person_profiles p on p.id = c.person_id where c.verification_code = $1 and c.revoked_at is null`, [params.code]);
  if (!c) throw notFound('Certificate');
  sendPdf(res, await certificatePdf({ name: c.full_name, programme: c.programme, outcome: c.outcome, issuedAt: displayDate(c.issued_at.toISOString()), code: c.verification_code, verifyUrl: verifyUrl(c.verification_code), ncMapping: c.nc_mapping }), `btbg-certificate-${c.verification_code}.pdf`);
});

m.route({ method: 'get', path: '/invoices/:id', summary: 'Invoice PDF', access: 'user' }, async ({ res, params, auth }) => {
  const i = await one(`select i.*, o.name from invoices i join organisations o on o.id = i.org_id where i.id = $1`, [params.id]);
  if (!i) throw notFound('Invoice');
  if (!auth.permissions.has('billing.view') && !(auth.orgId === i.org_id && auth.permissions.has('host.admin') && i.status !== 'draft')) throw forbidden();
  const lines = await query(`select line_type as type, description, amount from invoice_lines where invoice_id = $1 order by line_type`, [params.id]);
  sendPdf(res, await invoicePdf({ number: i.number, org: i.name, period: i.period, issueDate: i.issue_date && displayDate(i.issue_date), dueDate: i.due_date && displayDate(i.due_date),
    lines: lines.map((l) => ({ ...l, amount: Number(l.amount) })), total: Number(i.total), paid: Number(i.amount_paid) }), `${i.number}.pdf`);
});

m.route({ method: 'get', path: '/credentials/:id', summary: 'Uploaded credential file', access: 'user' }, async ({ req, res, params, auth }) => {
  const c = await one('select person_id, file_path from person_credentials where id = $1', [params.id]);
  if (!c?.file_path) throw notFound('File');
  if (!auth.permissions.has('candidates.view') && !(await isPersonOwner(auth, c.person_id))) throw forbidden();
  return sendStored(req, res, c.file_path);
});

m.route({ method: 'get', path: '/portfolio/:id', summary: 'Portfolio photo or video', access: 'user' }, async ({ req, res, params, auth }) => {
  const p = await one('select person_id, file_path from portfolio_media where id = $1', [params.id]);
  if (!p) throw notFound('File');
  const hostCanSee = auth.orgId && (await one(
    `select 1 from applications a join vacancies v on v.id = a.vacancy_id where a.person_id = $1 and v.org_id = $2 and a.shared_with_host_at is not null`, [p.person_id, auth.orgId]));
  if (!auth.permissions.has('candidates.view') && !(await isPersonOwner(auth, p.person_id)) && !hostCanSee) throw forbidden();
  return sendStored(req, res, p.file_path);
});

m.route({ method: 'get', path: '/org-docs/:id', summary: 'Host verification document', access: 'user' }, async ({ req, res, params, auth }) => {
  const d = await one('select org_id, file_path from org_documents where id = $1', [params.id]);
  if (!d) throw notFound('File');
  if (!auth.permissions.has('hosts.view') && auth.orgId !== d.org_id) throw forbidden();
  return sendStored(req, res, d.file_path);
});

m.route({ method: 'get', path: '/org-photo', summary: 'Public workplace photo', access: 'public' }, async ({ req, res }) => {
  const key = String(req.query.key ?? '');
  const ok = await one('select 1 from organisations where $1 = any(photos) and status = \'active\'', [key]);
  if (!ok) throw notFound('Photo');
  return sendStored(req, res, key, { cache: 'public, max-age=86400' });
});
