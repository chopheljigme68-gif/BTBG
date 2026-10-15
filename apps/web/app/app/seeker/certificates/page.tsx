'use client';
import Link from 'next/link';
import { Async, Card, Empty, PageHeader, useToast } from '@/components/ui';
import { fileUrl, useApi } from '@/lib/api';
import { date, label } from '@/lib/format';

/** Certificates with public verification links (FR-CERT). */
export default function Certificates() {
  const r = useApi<any[]>('/me/certificates');
  const toast = useToast();
  const share = async (code: string) => {
    const url = `${location.origin}/verify/${code}`;
    try {
      if (navigator.share) await navigator.share({ title: 'My BTBG certificate', url });
      else { await navigator.clipboard.writeText(url); toast.ok('Verification link copied'); }
    } catch { /* cancelled */ }
  };
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My certificates" subtitle="Employers can check any certificate with its code at btbg.bt/verify." />
      <Async r={r}>
        {(rows) => rows.length === 0 ? <Empty title="No certificates yet">You receive a certificate when you complete training or a placement.</Empty> : (
          <div className="grid gap-4 sm:grid-cols-2">
            {rows.map((c) => (
              <Card key={c.id}>
                <p className="text-xs font-semibold tracking-wide text-gold-700 uppercase">{label(c.kind)}</p>
                <p className="mt-1 text-lg font-semibold text-navy-950">{c.title}</p>
                {c.programme && <p className="text-sm text-slate-600">{c.programme}</p>}
                <p className="mt-2 text-sm">Issued {date(c.issuedAt)} · Code <Link className="link font-mono" href={`/verify/${c.code}`}>{c.code}</Link></p>
                <div className="mt-3 flex gap-2">
                  <a className="btn-primary btn-sm" href={fileUrl(`/files/certificates/${c.code}`)} target="_blank" rel="noreferrer">Download</a>
                  <button className="btn-outline btn-sm" onClick={() => share(c.code)}>Share link</button>
                </div>
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}
