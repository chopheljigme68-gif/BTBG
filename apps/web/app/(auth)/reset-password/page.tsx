'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { Alert, Input, SubmitButton } from '@/components/ui';
import { post } from '@/lib/api';

export default function ResetPage() {
  return <Suspense><Reset /></Suspense>;
}

function Reset() {
  const token = useSearchParams().get('token') ?? '';
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="card p-6">
      <h1 className="text-2xl font-bold text-navy-950">Choose a new password</h1>
      <form className="mt-5 space-y-4" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setError(null);
        try { await post('/auth/password/reset', { token, newPassword: password }); router.replace('/login?reset=1'); }
        catch (err) { setError((err as Error).message); } finally { setBusy(false); }
      }}>
        <Input label="New password" type="password" autoComplete="new-password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        {error && <Alert tone="error">{error}</Alert>}
        <SubmitButton busy={busy} className="btn-primary w-full">Save password</SubmitButton>
      </form>
    </div>
  );
}
