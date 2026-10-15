'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Alert, Checkbox, DevCode, Input, OtpInput, Select, SubmitButton } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { homeFor } from '@/lib/auth';
import { viewerRef } from '@/lib/format';

export default function RegisterPage() {
  return <Suspense><Register /></Suspense>;
}

type Step = 'type' | 'mobile' | 'details';

function Register() {
  const sp = useSearchParams();
  const router = useRouter();
  const [type, setType] = useState<'job_seeker' | 'host_owner' | null>(sp.get('type') === 'host' ? 'host_owner' : sp.get('career') || sp.get('next') ? 'job_seeker' : null);
  const [step, setStep] = useState<Step>(type ? 'mobile' : 'type');
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState<{ sentTo: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const consent = useApi<any>('/auth/consent');
  const ref = useApi<any>('/public/reference');
  const [scopes, setScopes] = useState<string[]>([]);
  const [form, setForm] = useState<Record<string, any>>({ language: 'en', employmentType: 'full_time', sizeTier: 'small', sectorCode: 'hospitality' });
  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const gewogs = useMemo(() => ref.data?.gewogs.filter((g: any) => String(g.dzongkhagId) === String(form.dzongkhagId)) ?? [], [ref.data, form.dzongkhagId]);
  const requiredScopes = consent.data?.scopes.filter((s: any) => s.required).map((s: any) => s.code) ?? [];
  const consentOk = requiredScopes.every((s: string) => scopes.includes(s));

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  const sendCode = () => run(async () => {
    setOtp(await post('/auth/register/start', { mobile }));
    setStep('details');
  });

  const complete = () => run(async () => {
    const num = (v: any) => (v === '' || v === undefined || v === null ? undefined : Number(v));
    const account = type === 'job_seeker'
      ? { type, employmentType: form.employmentType, dzongkhagId: num(form.dzongkhagId), gewogId: num(form.gewogId), careerSlug: sp.get('career') ?? undefined, viewerRef: viewerRef() }
      : { type, orgName: form.orgName, tradeLicenceNo: form.tradeLicenceNo, sectorCode: form.sectorCode, sizeTier: form.sizeTier, dzongkhagId: num(form.dzongkhagId), gewogId: num(form.gewogId) };
    const r = await post('/auth/register/complete', {
      mobile, code, fullName: form.fullName, email: form.email ?? '', password: form.password, language: form.language,
      consentVersion: consent.data.version, consentScopes: scopes, trustedDevice: Boolean(form.trustedDevice), account,
    });
    const next = sp.get('next');
    router.replace(next && next.startsWith('/') ? next : `${homeFor(r.role)}?welcome=1`);
  });

  return (
    <div className="card p-6">
      <h1 className="text-2xl font-bold text-navy-950">Create your BTBG account</h1>

      {step === 'type' && (
        <div className="mt-5 grid gap-3">
          {[
            ['job_seeker', 'I am looking for work', 'Create a profile, apply in one tap and get paid by BTBG.'],
            ['host_owner', 'I want to hire', 'Register your business to host BTBG apprentices.'],
          ].map(([t, title, desc]) => (
            <button key={t} className="rounded-xl border-2 border-navy-100 p-4 text-left transition hover:border-gold-500" onClick={() => { setType(t as any); setStep('mobile'); }}>
              <p className="font-semibold text-navy-950">{title}</p>
              <p className="text-sm text-slate-600">{desc}</p>
            </button>
          ))}
        </div>
      )}

      {step === 'mobile' && (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); sendCode(); }}>
          <p className="text-sm text-slate-600">{type === 'host_owner' ? 'Business owner registration.' : 'Job seeker registration.'} <button type="button" className="link" onClick={() => setStep('type')}>Change</button></p>
          <Input label="Your mobile number" inputMode="tel" autoComplete="tel" placeholder="17xxxxxx or 77xxxxxx" value={mobile} onChange={(e) => setMobile(e.target.value)} required hint="We send a 6-digit code to check it is yours." />
          {error && <Alert tone="error">{error} {error.includes('already has an account') && <Link className="font-semibold underline" href="/login">Sign in</Link>}</Alert>}
          <SubmitButton busy={busy} className="btn-primary w-full py-3">Send code</SubmitButton>
        </form>
      )}

      {step === 'details' && (
        <form className="mt-5 space-y-4" onSubmit={(e) => { e.preventDefault(); complete(); }}>
          <div>
            <p className="mb-2 text-sm text-slate-600">Enter the code sent to {otp?.sentTo}. <button type="button" className="link" onClick={sendCode}>Resend</button></p>
            <DevCode code={otp?.devCode} />
            <div className="mt-2"><OtpInput value={code} onChange={setCode} /></div>
          </div>
          <Input label="Full name" autoComplete="name" required value={form.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} />
          <Input label="Email (optional)" type="email" autoComplete="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          <Input label="Password" type="password" autoComplete="new-password" minLength={8} required value={form.password ?? ''} onChange={(e) => set('password', e.target.value)} hint="At least 8 characters." />
          <Select label="Language for messages" value={form.language} onChange={(e) => set('language', e.target.value)} options={[{ value: 'en', label: 'English' }, { value: 'dz', label: 'རྫོང་ཁ Dzongkha' }]} />

          {type === 'host_owner' && (
            <fieldset className="space-y-3 rounded-xl bg-cream p-4">
              <legend className="px-1 text-sm font-semibold text-navy-900">Your business</legend>
              <Input label="Business name" required value={form.orgName ?? ''} onChange={(e) => set('orgName', e.target.value)} />
              <Input label="Trade licence number" required value={form.tradeLicenceNo ?? ''} onChange={(e) => set('tradeLicenceNo', e.target.value)} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Select label="Sector" value={form.sectorCode} onChange={(e) => set('sectorCode', e.target.value)} options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
                <Select label="Size" value={form.sizeTier} onChange={(e) => set('sizeTier', e.target.value)} options={[{ value: 'micro', label: 'Micro (1-4 staff)' }, { value: 'small', label: 'Small (5-20)' }, { value: 'medium', label: 'Medium (21-50)' }, { value: 'large', label: 'Large (50+)' }]} />
              </div>
            </fieldset>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Select label="Dzongkhag" required={type === 'host_owner'} placeholder="Choose" value={form.dzongkhagId ?? ''} onChange={(e) => { set('dzongkhagId', e.target.value); set('gewogId', ''); }} options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
            <Select label="Gewog or thromde" placeholder="Choose" value={form.gewogId ?? ''} onChange={(e) => set('gewogId', e.target.value)} options={gewogs.map((g: any) => ({ value: g.id, label: g.name }))} disabled={!gewogs.length} />
          </div>
          {type === 'job_seeker' && (
            <Select label="I am looking for" value={form.employmentType} onChange={(e) => set('employmentType', e.target.value)} options={[{ value: 'full_time', label: 'Full-time work' }, { value: 'freelance', label: 'Freelance or gig work' }]} />
          )}

          {consent.data && (
            <fieldset className="rounded-xl border border-navy-100 p-4">
              <legend className="px-1 text-sm font-semibold text-navy-900">Your consent</legend>
              <details className="mb-2 text-sm text-slate-600"><summary className="cursor-pointer font-medium text-navy-800">Read the privacy statement</summary><p className="mt-2 whitespace-pre-line">{consent.data.text}</p></details>
              {consent.data.scopes.map((s: any) => (
                <Checkbox key={s.code} label={<>{s.label}{s.required && <span className="text-red-600"> *</span>}</>} checked={scopes.includes(s.code)}
                  onChange={(e) => setScopes((x) => (e.target.checked ? [...x, s.code] : x.filter((c) => c !== s.code)))} />
              ))}
            </fieldset>
          )}
          <Checkbox label="Keep me signed in on this device" checked={Boolean(form.trustedDevice)} onChange={(e) => set('trustedDevice', e.target.checked)} />
          {error && <Alert tone="error">{error}</Alert>}
          <SubmitButton busy={busy} className="btn-gold w-full py-3" disabled={code.length !== 6 || !consentOk}>Create account</SubmitButton>
        </form>
      )}
      <p className="mt-5 text-center text-sm">Already registered? <Link href="/login" className="link">Sign in</Link></p>
    </div>
  );
}
