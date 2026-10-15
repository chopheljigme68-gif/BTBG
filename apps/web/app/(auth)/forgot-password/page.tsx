'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Alert, DevCode, Input, OtpInput, SubmitButton, Tabs } from '@/components/ui';
import { post } from '@/lib/api';

export default function Forgot() {
  const router = useRouter();
  const [channel, setChannel] = useState<'sms' | 'email'>('sms');
  const [mobile, setMobile] = useState('');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState<any>(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  };

  return (
    <div className="card p-6">
      <h1 className="text-2xl font-bold text-navy-950">Reset your password</h1>
      <div className="mt-4"><Tabs value={channel} onChange={(c) => { setChannel(c as any); setSent(null); }} tabs={[{ id: 'sms', label: 'By SMS code' }, { id: 'email', label: 'By email link' }]} /></div>
      {!sent ? (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => setSent(await post('/auth/password/forgot', channel === 'sms' ? { channel, mobile } : { channel, email }))); }}>
          {channel === 'sms'
            ? <Input label="Mobile number" inputMode="tel" placeholder="17xxxxxx" value={mobile} onChange={(e) => setMobile(e.target.value)} required />
            : <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />}
          {error && <Alert tone="error">{error}</Alert>}
          <SubmitButton busy={busy} className="btn-primary w-full">Send</SubmitButton>
        </form>
      ) : channel === 'email' ? (
        <div className="space-y-3">
          <Alert tone="ok">{sent.message} The link works for 15 minutes.</Alert>
          {sent.devLink && <Alert tone="warn" title="Development mode"><a className="underline" href={sent.devLink}>Open the reset link</a></Alert>}
        </div>
      ) : (
        <form className="space-y-4" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/auth/password/reset', { mobile, code, newPassword: password }); router.replace('/login?reset=1'); }); }}>
          <p className="text-sm text-slate-600">{sent.message}</p>
          <DevCode code={sent.devCode} />
          <OtpInput value={code} onChange={setCode} />
          <Input label="New password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required hint="At least 8 characters." />
          {error && <Alert tone="error">{error}</Alert>}
          <SubmitButton busy={busy} className="btn-primary w-full" disabled={code.length !== 6}>Set new password</SubmitButton>
        </form>
      )}
      <Link href="/login" className="mt-5 inline-block text-sm link">Back to sign in</Link>
    </div>
  );
}
