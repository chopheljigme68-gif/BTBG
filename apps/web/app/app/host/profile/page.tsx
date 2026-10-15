'use client';
import { useEffect, useState } from 'react';
import { Alert, Async, Badge, Card, FilePicker, Input, PageHeader, Select, SubmitButton, Textarea, useToast } from '@/components/ui';
import { fileUrl, put, upload, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, label } from '@/lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Company profile, verification documents and workplace photos (FR-EMP-01..03). */
export default function HostProfile() {
  const r = useApi<any>('/host/profile');
  const ref = useApi<any>('/public/reference');
  const { me } = useMe();
  const admin = can(me, 'host.admin');
  const toast = useToast();
  const [f, setF] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [up, setUp] = useState(false);
  const [docKind, setDocKind] = useState('trade_licence');
  useEffect(() => { if (r.data && !f) setF({ ...r.data }); }, [r.data, f]);
  const set = (k: string, v: any) => setF((x: any) => ({ ...x, [k]: v }));
  const toggleMonth = (k: 'peakMonths' | 'offPeakMonths', m: number) => set(k, f[k].includes(m) ? f[k].filter((x: number) => x !== m) : [...f[k], m].sort((a: number, b: number) => a - b));

  const save = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    try {
      const n = (v: any) => (v === '' || v === null || v === undefined ? null : Number(v));
      await put('/host/profile', {
        name: f.name, sectorCode: f.sectorCode, starRating: n(f.starRating), dzongkhagId: Number(f.dzongkhagId), gewogId: n(f.gewogId), address: f.address || null,
        sizeTier: f.sizeTier, staffCount: n(f.staffCount), peakMonths: f.peakMonths ?? [], offPeakMonths: f.offPeakMonths ?? [], culture: f.culture || null,
        valuesText: f.valuesText || null, complianceNeeds: f.complianceNeeds || null, ownerName: f.ownerName || null, ownerCid: f.ownerCid || undefined,
      });
      toast.ok('Profile saved'); set('ownerCid', ''); r.mutate();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };
  const uploadFile = async (path: string, file: File, body?: any) => {
    setUp(true);
    try { await upload(path, file, body); toast.ok('Uploaded'); r.mutate(); } catch (e) { toast.error(e); } finally { setUp(false); }
  };

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Company profile" />
      <Async r={r}>
        {(p) => !f ? null : (
          <>
            <div className="flex flex-wrap gap-3">
              <Badge status={p.verificationStatus} />
              <span className="text-sm text-slate-600">Rating from apprentices: {p.rating.average ? `${p.rating.average} ★ (${p.rating.count})` : `shown after ${p.rating.hiddenUntil} ratings`}</span>
            </div>
            <form onSubmit={save} className="space-y-6">
              <fieldset disabled={!admin} className="space-y-6">
                <Card title="Business">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Input label="Business name" required value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} />
                    <Input label="Trade licence number" value={p.tradeLicenceNo ?? ''} disabled hint="Contact BTBG to change this." />
                    <Select label="Sector" value={f.sectorCode} onChange={(e) => set('sectorCode', e.target.value)} options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
                    <Select label="Hotel star rating" placeholder="Not rated" value={f.starRating ?? ''} onChange={(e) => set('starRating', e.target.value)} options={[1, 2, 3, 4, 5].map((n) => ({ value: n, label: `${n} star` }))} />
                    <Select label="Size" value={f.sizeTier} onChange={(e) => set('sizeTier', e.target.value)} options={['micro', 'small', 'medium', 'large'].map((s) => ({ value: s, label: label(s) }))} />
                    <Input label="Number of staff" type="number" min={0} value={f.staffCount ?? ''} onChange={(e) => set('staffCount', e.target.value)} />
                    <Select label="Dzongkhag" value={f.dzongkhagId ?? ''} onChange={(e) => { set('dzongkhagId', e.target.value); set('gewogId', ''); }} options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
                    <Select label="Gewog or thromde" placeholder="Choose" value={f.gewogId ?? ''} onChange={(e) => set('gewogId', e.target.value)} options={ref.data?.gewogs.filter((g: any) => String(g.dzongkhagId) === String(f.dzongkhagId)).map((g: any) => ({ value: g.id, label: g.name })) ?? []} />
                    <Input label="Address" value={f.address ?? ''} onChange={(e) => set('address', e.target.value)} />
                    <Input label="Owner name" value={f.ownerName ?? ''} onChange={(e) => set('ownerName', e.target.value)} />
                    <Input label="Owner CID" value={f.ownerCid ?? ''} onChange={(e) => set('ownerCid', e.target.value)} pattern="\d{11}" placeholder="Leave blank to keep" hint="Stored encrypted." />
                  </div>
                </Card>
                <Card title="Seasons and culture">
                  {(['peakMonths', 'offPeakMonths'] as const).map((k) => (
                    <div key={k} className="mb-3"><p className="label">{k === 'peakMonths' ? 'Peak months' : 'Off-peak months'}</p>
                      <div className="flex flex-wrap gap-1">{MONTHS.map((m, i) => <button key={m} type="button" aria-pressed={f[k]?.includes(i + 1)} onClick={() => toggleMonth(k, i + 1)} className={`rounded px-2.5 py-1 text-xs ring-1 ${f[k]?.includes(i + 1) ? 'bg-navy-900 text-white ring-navy-900' : 'ring-navy-200'}`}>{m}</button>)}</div>
                    </div>
                  ))}
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Textarea label="Workplace culture" value={f.culture ?? ''} onChange={(e) => set('culture', e.target.value)} maxLength={2000} />
                    <Textarea label="Our values" value={f.valuesText ?? ''} onChange={(e) => set('valuesText', e.target.value)} maxLength={2000} />
                  </div>
                  <div className="mt-4"><Textarea label="Compliance needs (e.g. food handler certificate)" value={f.complianceNeeds ?? ''} onChange={(e) => set('complianceNeeds', e.target.value)} maxLength={2000} /></div>
                </Card>
                {admin && <SubmitButton busy={busy}>Save profile</SubmitButton>}
              </fieldset>
            </form>
            <Card title="Verification documents" actions={admin && (
              <div className="flex items-center gap-2">
                <select className="input py-1 text-sm" value={docKind} onChange={(e) => setDocKind(e.target.value)} aria-label="Document type">
                  {['trade_licence', 'owner_id', 'address_proof', 'other'].map((k) => <option key={k} value={k}>{label(k)}</option>)}
                </select>
                <FilePicker label="Upload" accept=".pdf,image/*" busy={up} onFile={(file) => uploadFile('/host/documents', file, { kind: docKind })} />
              </div>
            )}>
              {p.verificationStatus !== 'verified' && <div className="mb-3"><Alert tone="info">Upload your trade licence, the owner&apos;s CID and proof of address. BTBG checks all three before your vacancies go live.</Alert></div>}
              {p.documents.length === 0 ? <p className="text-sm text-slate-500">No documents uploaded.</p> : (
                <ul className="text-sm">{p.documents.map((d: any) => <li key={d.id} className="py-1"><a className="link" href={fileUrl(`/files/org-docs/${d.id}`)} target="_blank" rel="noreferrer">{label(d.kind)}: {d.fileName}</a> · {date(d.createdAt)}</li>)}</ul>
              )}
            </Card>
            <Card title="Workplace photos" actions={admin && <FilePicker label="Add photo" accept="image/*" busy={up} onFile={(file) => uploadFile('/host/profile/photos', file)} />}>
              <p className="mb-3 text-sm text-slate-600">Photos appear on your public vacancies so job seekers know where they will work.</p>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">{(p.photos ?? []).map((k: string) => <img key={k} src={fileUrl(`/files/org-photo?key=${encodeURIComponent(k)}`)} alt="Workplace" className="aspect-square rounded object-cover" />)}</div>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}
