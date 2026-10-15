import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { one, pool, query } from '../src/db/pool.js';
import { todayBT } from '../src/lib/dates.js';
import { app, as, login, PASSWORD } from './helpers.js';

/**
 * End-to-end checks of the main SRS workflows against a real database loaded
 * with the demo data (see test/global-setup.ts).
 */
let admin: string, ops: string, finance1: string, finance2: string, curator: string, apprentice: string;

beforeAll(async () => {
  [admin, ops, finance1, finance2, curator, apprentice] = await Promise.all(
    ['17000001', '17000002', '17000004', '17000005', '17000008', '17000021'].map((m) => login(m)),
  );
});
afterAll(() => pool.end());

async function registerAccount(mobile: string, account: object, fullName = 'Test Person') {
  const consent = await request(app).get('/auth/consent');
  const start = await request(app).post('/auth/register/start').send({ mobile });
  expect(start.status).toBe(200);
  const done = await request(app).post('/auth/register/complete').send({
    mobile, code: start.body.devCode, fullName, password: PASSWORD, consentVersion: consent.body.version,
    consentScopes: ['matching', 'employment', 'sharing'], account,
  });
  expect(done.status, JSON.stringify(done.body)).toBeLessThan(300);
  return done.body;
}

describe('accounts and access (SRS 3.1)', () => {
  it('registers a job seeker with an SMS code and recorded consent', async () => {
    const reg = await registerAccount('17111111', { type: 'job_seeker', dzongkhagId: 1 });
    const token = reg.token ?? (await login('17111111'));
    const me = await as(token).get('/auth/me');
    expect(me.body.activeRole).toBe('job_seeker');
    const consent = await one(`select c.version from consents c join users u on u.id = c.user_id where u.mobile = '+97517111111'`);
    expect(consent?.version).toBeTruthy();
  });

  it('requires MFA for staff before anything else works', async () => {
    const res = await request(app).post('/auth/login').send({ mobile: '17000003', password: PASSWORD });
    expect(res.body.mfaRequired).toBe(true);
    const blocked = await as(res.body.token).get('/candidates');
    expect([401, 403]).toContain(blocked.status);
  });

  it('locks an account after five wrong passwords', async () => {
    for (let i = 0; i < 5; i++) await request(app).post('/auth/login').send({ mobile: '17000025', password: 'wrong-password' });
    const res = await request(app).post('/auth/login').send({ mobile: '17000025', password: PASSWORD });
    expect(res.status).toBe(423);
  });

  it('enforces role permissions', async () => {
    expect((await as(apprentice).get('/admin/users')).status).toBe(403);
    expect((await as(apprentice).get('/payroll/runs')).status).toBe(403);
    expect((await as(admin).get('/admin/users')).status).toBe(200);
  });
});

describe('host onboarding to a live vacancy (Workflow 1)', () => {
  let hostToken: string;
  let orgId: string;
  let vacancyId: string;

  it('lets a host register; the company starts unverified', async () => {
    await registerAccount('17222222', { type: 'host_owner', orgName: 'Test Valley Lodge', tradeLicenceNo: 'TL-TEST-9', sectorCode: 'hospitality', dzongkhagId: 1 }, 'Lodge Owner');
    hostToken = await login('17222222');
    const profile = await as(hostToken).get('/host/profile');
    expect(profile.body.verificationStatus ?? profile.body.verification_status).toBe('pending');
    orgId = profile.body.id;
  });

  it('blocks verification until all three checks pass', async () => {
    const partial = await as(ops).post(`/hosts/${orgId}/verify`, { decision: 'verified', checks: { tradeLicence: true, address: false, ownerIdentity: true } });
    expect(partial.status).toBe(422);
    const ok = await as(ops).post(`/hosts/${orgId}/verify`, { decision: 'verified', checks: { tradeLicence: true, address: true, ownerIdentity: true } });
    expect(ok.status).toBe(200);
  });

  it('rejects a vacancy below the wage floor', async () => {
    const res = await as(hostToken).post('/host/vacancies', { title: 'Cleaner', sectorCode: 'hospitality', openings: 1, dzongkhagId: 1, wage: 5000 });
    expect([400, 422]).toContain(res.status);
  });

  it('opens a vacancy only after BTBG approves it', async () => {
    const created = await as(hostToken).post('/host/vacancies', { title: 'Room attendant', sectorCode: 'hospitality', openings: 2, dzongkhagId: 1, wage: 9500, startDate: todayBT() });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    vacancyId = created.body.id;
    expect((await as(hostToken).post(`/host/vacancies/${vacancyId}/submit`)).status).toBe(200);
    let pub = await request(app).get('/vacancies/public?q=Room attendant');
    expect(pub.body.items.some((v: any) => v.id === vacancyId)).toBe(false);
    expect((await as(ops).post(`/vacancies/${vacancyId}/approve`, {})).status).toBe(200);
    pub = await request(app).get('/vacancies/public?q=Room attendant');
    expect(pub.body.items.some((v: any) => v.id === vacancyId)).toBe(true);
  });

  it('lets a job seeker apply in one tap', async () => {
    const seeker = await login('17000020');
    const res = await as(seeker).post('/me/applications', { vacancyId });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const again = await as(seeker).post('/me/applications', { vacancyId });
    expect(again.status).toBe(422);
  });
});

describe('payroll maker and checker (Workflow 5)', () => {
  it('prepares, reviews and approves a run with two different people, then locks it', async () => {
    const period = todayBT().slice(0, 7);
    const prepared = await as(finance1).post('/payroll/runs', { period });
    expect(prepared.status, JSON.stringify(prepared.body)).toBe(200);
    const runId = prepared.body.runId;
    const run = await as(finance1).get(`/payroll/runs/${runId}`);
    const slips = run.body.payslips ?? run.body.lines ?? [];
    expect(slips.length).toBeGreaterThan(0);
    for (const s of slips.filter((x: any) => x.flagged)) {
      expect((await as(finance1).post(`/payroll/payslips/${s.id}/resolve`, { note: 'Checked with host' })).status).toBe(200);
    }
    expect((await as(finance1).post(`/payroll/runs/${runId}/submit`)).status).toBe(200);
    expect((await as(finance1).post(`/payroll/runs/${runId}/approve`)).status).toBe(403);
    expect((await as(finance2).post(`/payroll/runs/${runId}/approve`)).status).toBe(200);
    await expect(query(`update payslips set net = net + 1 where run_id = $1`, [runId])).rejects.toThrow();
  });
});

describe('vocational video consent (FR-VID-21)', () => {
  it('blocks publishing until every featured person has consented', async () => {
    const career = await one(`select id from careers limit 1`);
    const v = await as(curator).post('/campaign/admin/videos', { careerId: career!.id, title: 'A day in the kitchen', tags: ['green-jobs'] });
    expect(v.status).toBe(201);
    await query(`update videos set status = 'review', original_path = 'x.mp4', subtitles = '{"en":"a.vtt","dz":"b.vtt"}', processing_status = 'ready' where id = $1`, [v.body.id]);
    await as(curator).post(`/campaign/admin/videos/${v.body.id}/people`, { name: 'Dawa', isMinor: false });
    const res = await as(curator).post(`/campaign/admin/videos/${v.body.id}/status`, { status: 'consent_confirmed' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/Consent is missing for: Dawa/);
  });
});

describe('grievances (Workflow 6)', () => {
  it('treats safety as severity 1 and alerts the Super Admin', async () => {
    const res = await as(apprentice).post('/grievances', { category: 'safety', subject: 'Unsafe ladder', description: 'The ladder in the store room is broken and we are asked to use it.' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.severity).toBe(1);
    const alert = await one(`select 1 from notifications n join user_roles r on r.user_id = n.user_id where r.role_code = 'super_admin' and n.body like '%' || $1 || '%'`, [res.body.ref]);
    expect(alert).toBeTruthy();
  });
});

describe('oversight', () => {
  it('shows dashboard counts and MVP measures', async () => {
    const d = await as(ops).get('/reports/dashboard');
    expect(d.status).toBe(200);
    expect(d.body.counts.onPlacement).toBeGreaterThanOrEqual(1);
    expect(d.body.mvp.matchesStarted.value).toBeGreaterThanOrEqual(1);
  });

  it('exports the dashboard to Excel and PDF', async () => {
    const x = await as(ops).get('/reports/export?report=dashboard&format=xlsx');
    expect(x.status).toBe(200);
    expect(x.headers['content-type']).toMatch(/spreadsheetml/);
    const p = await as(ops).get('/reports/export?report=standard&format=pdf');
    expect(p.headers['content-type']).toBe('application/pdf');
  });

  it('keeps an unbroken, tamper-evident audit trail', async () => {
    const r = await as(admin).get('/admin/audit/verify');
    expect(r.body.ok).toBe(true);
    expect(r.body.checked).toBeGreaterThan(5);
    await expect(query(`update audit_log set action = 'x' where id = (select min(id) from audit_log)`)).rejects.toThrow();
  });

  it('runs scheduled jobs on demand', async () => {
    const r = await as(admin).post('/admin/jobs/checkin_reminders/run');
    expect(r.status).toBe(200);
    expect(r.body.result.overdue).toBeGreaterThanOrEqual(0);
  });
});
