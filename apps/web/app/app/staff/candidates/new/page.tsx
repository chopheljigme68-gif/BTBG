'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, Card, Checkbox, DevCode, Input, OtpInput, PageHeader, Select, SubmitButton, useToast } from '@/components/ui';
import { post, useApi } from '@/lib/api';
import { label } from '@/lib/format';
import { SOURCES } from '../constants';

/** Assisted registration (FR-AUTH-04): the job seeker reads the SMS code aloud to the field officer. */
export default function AssistedRegistration() {
  const ref = useApi<any>('/public/reference');
  const consent = useApi<any>('/public/consent');
  const router = useRouter();
  const toast = useToast();
  const [mobile, setMobile] = useState('');
  const [otp, setOtp] = useState<any>(null);
  const [code, setCode] = useState('');
  const [f, setF] = useState<any>({ source: 'field_officer' });
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <PageHeader title="Register a job seeker" back={{ href: '/app/staff/candidates', label: 'Candidates' }} subtitle="For walk-ins and field visits. The person must have their phone with them." />
      <Card title="1. Their mobile number">
        <form className="flex flex-wrap items-end gap-3" onSubmit={(e) => { e.preventDefault(); run(async () => setOtp(await post('/candidates/assisted/start', { mobile }))); }}>
          <Input label="Mobile" value={mobile} onChange={(e) => setMobile(e.target.value)} required inputMode="tel" />
          <SubmitButton busy={busy}>{otp ? 'Resend code' : 'Send code'}</SubmitButton>
        </form>
      </Card>
      {otp && (
        <Card title="2. Details and consent">
          <form className="space-y-4" onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              const n = (v: any) => (v ? Number(v) : undefined);
              const r = await post('/candidates/assisted/complete', { mobile, code, fullName: f.fullName, cid: f.cid || undefined, gender: f.gender || undefined, dateOfBirth: f.dateOfBirth || undefined, dzongkhagId: n(f.dzongkhagId), gewogId: n(f.gewogId), source: f.source, sourceDetail: f.sourceDetail || undefined, consentRead: read });
              toast.ok('Registered. They will get an SMS to set a password.');
              router.push(`/app/staff/candidates/${r.personId ?? r.id}`);
            });
          }}>
            <div><p className="mb-1 text-sm">Ask them to read out the code sent to {otp.sentTo}.</p><DevCode code={otp.devCode} /><OtpInput value={code} onChange={setCode} /></div>
            <div className="grid gap-3 sm:grid-cols-2">
              <Input label="Full name" required value={f.fullName ?? ''} onChange={(e) => set('fullName', e.target.value)} />
              <Input label="CID" pattern="\d{11}" value={f.cid ?? ''} onChange={(e) => set('cid', e.target.value)} />
              <Select label="Gender" placeholder="Not set" value={f.gender ?? ''} onChange={(e) => set('gender', e.target.value)} options={['female', 'male', 'other', 'prefer_not'].map((g) => ({ value: g, label: label(g) }))} />
              <Input label="Date of birth" type="date" value={f.dateOfBirth ?? ''} onChange={(e) => set('dateOfBirth', e.target.value)} />
              <Select label="Dzongkhag" placeholder="Choose" value={f.dzongkhagId ?? ''} onChange={(e) => { set('dzongkhagId', e.target.value); set('gewogId', ''); }} options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
              <Select label="Gewog" placeholder="Choose" value={f.gewogId ?? ''} onChange={(e) => set('gewogId', e.target.value)} options={ref.data?.gewogs.filter((g: any) => String(g.dzongkhagId) === String(f.dzongkhagId)).map((g: any) => ({ value: g.id, label: g.name })) ?? []} />
              <Select label="Source" value={f.source} onChange={(e) => set('source', e.target.value)} options={SOURCES.map((s) => ({ value: s, label: label(s) }))} />
              <Input label="Source detail" value={f.sourceDetail ?? ''} onChange={(e) => set('sourceDetail', e.target.value)} placeholder="e.g. TTI Khuruthang 2026 batch" />
            </div>
            {consent.data && <Alert tone="info" title="Read this to them">{consent.data.text}</Alert>}
            <Checkbox label="I read the consent statement aloud and they agreed." checked={read} onChange={(e) => setRead(e.target.checked)} />
            <SubmitButton busy={busy} disabled={code.length !== 6 || !read} className="btn-gold">Register</SubmitButton>
          </form>
        </Card>
      )}
    </div>
  );
}
