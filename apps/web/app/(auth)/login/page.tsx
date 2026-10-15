'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Checkbox, DevCode, Input, OtpInput, SubmitButton } from '@/components/ui';
import { ApiError, post } from '@/lib/api';
import { homeFor } from '@/lib/auth';

export default function LoginPage() {
  return <Suspense><Login /></Suspense>;
}

function Login() {
  const router = useRouter();
  const sp = useSearchParams();
  const next = sp.get('next');
  const [step, setStep] = useState<'password' | 'mfa'>('password');
  const [mobile, setMobile] = useState('');
  const [password, setPassword] = useState('');
  const [trusted, setTrusted] = useState(false);
  const [code, setCode] = useState('');
  const [mfa, setMfa] = useState<{ sentTo: string; devCode?: string } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const done = (role?: string) => router.replace(next && next.startsWith('/') ? next : homeFor(role));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError(null);
    try {
      if (step === 'password') {
        const r = await post('/auth/login', { mobile, password, trustedDevice: trusted });
        if (r.mfaRequired) { setMfa(r); setStep('mfa'); }
        else done(r.role);
      } else {
        const r = await post('/auth/mfa/verify', { code });
        done(r.role);
      }
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card p-6">
      <h1 className="text-2xl font-bold text-navy-950">{step === 'password' ? 'Sign in' : 'Enter your code'}</h1>
      {sp.get('expired') && step === 'password' && <div className="mt-3"><Alert tone="warn">Your session ended. Please sign in again.</Alert></div>}
      <form className="mt-5 space-y-4" onSubmit={submit}>
        {step === 'password' ? (
          <>
            <Input label="Mobile number" inputMode="tel" autoComplete="tel" placeholder="17xxxxxx" value={mobile} onChange={(e) => setMobile(e.target.value)} required />
            <Input label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
            <Checkbox label="Keep me signed in on this device" hint="Only on your own phone or computer." checked={trusted} onChange={(e) => setTrusted(e.target.checked)} />
          </>
        ) : (
          <>
            <p className="text-sm text-slate-600">We sent a 6-digit code to {mfa?.sentTo}.</p>
            <DevCode code={mfa?.devCode} />
            <OtpInput value={code} onChange={setCode} />
            <button type="button" className="text-sm text-navy-700 hover:underline" onClick={async () => setMfa(await post('/auth/mfa/resend'))}>Send a new code</button>
          </>
        )}
        {error && (
          <Alert tone="error">
            {error.message} {error.code === 'password_not_set' || error.code === 'locked' ? <Link href="/forgot-password" className="font-semibold underline">Reset password</Link> : null}
          </Alert>
        )}
        <SubmitButton busy={busy} className="btn-primary w-full py-3" disabled={step === 'mfa' && code.length !== 6}>{step === 'password' ? 'Sign in' : 'Verify and continue'}</SubmitButton>
      </form>
      <div className="mt-5 flex justify-between text-sm">
        <Link href="/forgot-password" className="link">Forgot password?</Link>
        <Link href={`/register${next ? `?next=${encodeURIComponent(next)}` : ''}`} className="link">Create an account</Link>
      </div>
    </div>
  );
}
