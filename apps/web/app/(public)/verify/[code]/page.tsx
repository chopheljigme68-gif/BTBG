'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { Alert, KeyValue, Loading } from '@/components/ui';
import { useApi } from '@/lib/api';

export default function VerifyPage() {
  const { code } = useParams<{ code: string }>();
  const r = useApi<any>(`/public/certificates/${code}`, { shouldRetryOnError: false });
  return (
    <div className="mx-auto max-w-xl px-4 py-14">
      <h1 className="text-3xl font-bold text-navy-950">Certificate check</h1>
      <div className="mt-6">
        {r.isLoading ? <Loading /> : r.error ? (
          <Alert tone="error" title="Not found">No BTBG certificate has the code <b className="font-mono">{decodeURIComponent(code)}</b>. Check the code and try again.</Alert>
        ) : r.data && (
          <div className="card space-y-4 p-6">
            {r.data.valid ? <Alert tone="ok" title="✓ Genuine BTBG certificate">This certificate was issued by BTBG and is valid.</Alert>
              : <Alert tone="error" title="Revoked">This certificate was revoked on {r.data.revokedOn}.</Alert>}
            <KeyValue items={[['Name', r.data.name], ['Programme', r.data.programme], ['Outcome', r.data.outcome], ['Issued', r.data.issuedOn],
              ['National Certificate mapping', r.data.ncMapping], ['Code', <span key="c" className="font-mono">{r.data.code}</span>]]} />
            <a className="btn-outline" href={`/api/files/certificates/${r.data.code}`} target="_blank" rel="noreferrer">View certificate PDF</a>
          </div>
        )}
      </div>
      <Link href="/verify" className="mt-6 inline-block text-sm text-navy-700 hover:underline">Check another code</Link>
    </div>
  );
}
