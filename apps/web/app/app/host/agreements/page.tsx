'use client';
import { useState } from 'react';
import { Async, Badge, Card, Checkbox, DevCode, KeyValue, OtpInput, PageHeader, SubmitButton, useToast } from '@/components/ui';
import { fileUrl, post, useApi } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';

/** Host Placement Agreements with SMS-code signing (FR-EMP-24). */
export default function Agreements() {
  const r = useApi<any[]>('/host/agreements');
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title="Placement agreements" subtitle="One agreement for each apprentice, setting out fees and BTBG's support." />
      <Async r={r} empty={<p className="text-sm text-slate-500">No agreements yet.</p>}>
        {(rows) => (
          <div className="space-y-4">
            {rows.map((h) => (
              <Card key={h.id} title={`${h.apprentice} · ${h.roleTitle}`} actions={<Badge status={h.document?.status ?? h.status} />}>
                <KeyValue items={[
                  ['Period', `${date(h.startDate)} to ${date(h.endDate)}`], ['Placement fee', money(h.placementFee)], ['Monthly service fee', money(h.monthlyServiceFee)],
                  ['Admin fee', `${h.adminFeePct}% of wages`], ['Replacements', `${h.replacementsUsed} used of ${h.replacementEntitlement}`],
                  h.document?.signedAt && ['Signed', dateTime(h.document.signedAt)],
                ]} />
                {h.document && (
                  <div className="mt-3 flex gap-2"><a className="btn-outline btn-sm" href={fileUrl(`/files/agreements/${h.document.id}`)} target="_blank" rel="noreferrer">PDF (version {h.document.version})</a></div>
                )}
                {h.document?.status === 'pending_signature' && <Sign h={h} onDone={() => r.mutate()} />}
              </Card>
            ))}
          </div>
        )}
      </Async>
    </div>
  );
}

function Sign({ h, onDone }: { h: any; onDone: () => void }) {
  const toast = useToast();
  const [otp, setOtp] = useState<any>(null);
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <div className="mt-4 space-y-3 border-t border-navy-50 pt-4">
      <details><summary className="cursor-pointer text-sm font-medium text-navy-800">Read the agreement</summary><div className="mt-2 max-h-80 overflow-y-auto whitespace-pre-line rounded bg-cream p-3 text-sm">{h.document.body}</div></details>
      <Checkbox label="I have read the agreement and sign on behalf of the business." checked={agree} onChange={(e) => setAgree(e.target.checked)} />
      {!otp ? <SubmitButton type="button" className="btn-gold" busy={busy} disabled={!agree} onClick={() => run(async () => setOtp(await post(`/host/agreements/${h.id}/sign/start`)))}>Send signing code</SubmitButton> : (
        <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); run(async () => { await post(`/host/agreements/${h.id}/sign`, { code }); toast.ok('Agreement signed'); onDone(); }); }}>
          <p className="text-sm">Code sent to {otp.sentTo}</p><DevCode code={otp.devCode} /><OtpInput value={code} onChange={setCode} />
          <SubmitButton busy={busy} disabled={code.length !== 6} className="btn-gold">Sign agreement</SubmitButton>
        </form>
      )}
    </div>
  );
}
