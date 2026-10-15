'use client';
import { useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, DevCode, Empty, KeyValue, OtpInput, PageHeader, SubmitButton, useToast } from '@/components/ui';
import { fileUrl, post, useApi } from '@/lib/api';
import { date, dateTime, money } from '@/lib/format';

/** Employment contract with SMS-code e-signature (FR-EE-20, Workflow 3). */
export default function Contract() {
  const r = useApi<any>('/me/contract');
  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My employment contract" subtitle="BTBG is your employer. Your host supervises your daily work." />
      <Async r={r}>
        {(c) => !c ? <Empty title="No contract yet">Your contract appears here once BTBG matches you with a host.</Empty> : (
          <>
            {c.pending && <SignPanel doc={c.pending} onSigned={() => r.mutate()} />}
            <Card title="Key terms" actions={<Badge status={c.status} />}>
              <KeyValue items={[
                ['Monthly wage', money(c.wage)],
                ['Hours per week', c.hoursPerWeek],
                ['Working days per week', c.daysPerWeek],
                ['Rest days per week', c.restDaysPerWeek],
                ['Paid leave per year', `${c.leaveDaysPerYear} days`],
                ['Start date', date(c.startDate)],
                ['End date', c.endDate ? date(c.endDate) : 'Open-ended'],
              ]} />
            </Card>
            <Card title="Versions">
              <ul className="divide-y divide-navy-50 text-sm">
                {c.documents.map((d: any) => (
                  <li key={d.id} className="flex items-center justify-between gap-3 py-2">
                    <span>Version {d.version} <Badge status={d.status} /> {d.signedAt && <span className="text-slate-500">signed {dateTime(d.signedAt)}</span>}</span>
                    <a className="btn-outline btn-sm" href={fileUrl(`/files/agreements/${d.id}`)} target="_blank" rel="noreferrer">PDF</a>
                  </li>
                ))}
              </ul>
            </Card>
          </>
        )}
      </Async>
    </div>
  );
}

function SignPanel({ doc, onSigned }: { doc: any; onSigned: () => void }) {
  const toast = useToast();
  const [otp, setOtp] = useState<{ sentTo: string; devCode?: string } | null>(null);
  const [code, setCode] = useState('');
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>) => { setBusy(true); try { await fn(); } catch (e) { toast.error(e); } finally { setBusy(false); } };
  return (
    <Card title={`Contract version ${doc.version} is waiting for your signature`}>
      <div className="max-h-96 overflow-y-auto whitespace-pre-line rounded-lg bg-cream p-4 text-sm leading-relaxed text-slate-800">{doc.body}</div>
      <div className="mt-4 space-y-3">
        <Checkbox label="I have read this contract and I agree to its terms." checked={agree} onChange={(e) => setAgree(e.target.checked)} />
        {!otp ? (
          <SubmitButton type="button" busy={busy} disabled={!agree} className="btn-gold" onClick={() => run(async () => setOtp(await post('/me/contract/sign/start')))}>Send me a signing code</SubmitButton>
        ) : (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(async () => { await post('/me/contract/sign', { code, agree: true }); toast.ok('Contract signed. A copy is saved here.'); onSigned(); }); }}>
            <p className="text-sm text-slate-600">Enter the code sent to {otp.sentTo}.</p>
            <DevCode code={otp.devCode} />
            <OtpInput value={code} onChange={setCode} />
            <SubmitButton busy={busy} disabled={code.length !== 6 || !agree} className="btn-gold">Sign contract</SubmitButton>
          </form>
        )}
        <Alert tone="info">Questions about the contract? Use the Help button or call your field officer before signing.</Alert>
      </div>
    </Card>
  );
}
