'use client';
import { Loading } from '@/components/ui';
import { useApi } from '@/lib/api';

export default function Privacy() {
  const r = useApi<any>('/public/consent');
  return (
    <div className="mx-auto max-w-3xl px-4 py-12">
      <h1 className="text-3xl font-bold text-navy-950">Privacy and your data</h1>
      <p className="mt-2 text-slate-600">BTBG follows the Bhutan Information, Communications and Media Act on personal data. Sensitive details such as your CID and bank account are encrypted, and only staff who need them can see them.</p>
      <div className="card mt-6 p-6">
        {r.data ? (
          <>
            <p className="text-xs text-slate-500">Consent statement version {r.data.version}</p>
            <div className="mt-2 whitespace-pre-line text-slate-800">{r.data.text}</div>
          </>
        ) : <Loading />}
      </div>
      <p className="mt-6 text-sm text-slate-600">Signed in? You can download all your data or ask us to delete it from <b>My account</b>.</p>
    </div>
  );
}
