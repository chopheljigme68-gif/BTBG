'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, DevCode, KeyValue, ModalButton, OtpInput, PageHeader, SubmitButton, Textarea, useAction, useToast } from '@/components/ui';
import { VacancyForm } from '@/components/vacancy-form';
import { fileUrl, post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label } from '@/lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Host record: verification checks, documents, users, placements and status (FR-ENT-01, 03, 04). */
export default function Host({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/hosts/${id}`);
  const { me } = useMe();
  const [creating, setCreating] = useState(false);
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Async r={r}>
        {(h) => creating ? <OnBehalf orgId={id} name={h.name} onClose={() => setCreating(false)} /> : (
          <>
            <PageHeader title={h.name} back={{ href: '/app/staff/hosts', label: 'Hosts' }} subtitle={<span className="flex gap-2"><Badge status={h.verification_status} /><Badge status={h.status} /></span>}
              actions={<div className="flex flex-wrap gap-2">
                {can(me, 'hosts.verify') && <VerifyButton id={id} onDone={() => r.mutate()} />}
                {can(me, 'accounts.suspend') && <StatusButton id={id} status={h.status} onDone={() => r.mutate()} />}
                {can(me, 'vacancies.manage_any') && h.verification_status === 'verified' && <button className="btn-gold btn-sm" onClick={() => setCreating(true)}>Create vacancy (field visit)</button>}
                <Link className="btn-ghost btn-sm" href={`/app/staff/reports?host=${id}`}>Host report</Link>
              </div>} />
            {h.status === 'suspended' && <Alert tone="error" title="Suspended">{h.suspended_reason}</Alert>}
            <div className="grid gap-4 lg:grid-cols-3">
              <div className="space-y-4 lg:col-span-2">
                <Card title="Business">
                  <KeyValue items={[
                    ['Trade licence', h.trade_licence_no], ['Sector', label(h.sector_code)], ['Size', `${label(h.size_tier)}${h.staff_count ? `, ${h.staff_count} staff` : ''}`], ['Star rating', h.star_rating ? `${h.star_rating} star` : '—'],
                    ['Location', [h.address, h.gewog, h.dzongkhag].filter(Boolean).join(', ')], ['Owner', `${h.owner_name ?? '—'}${h.ownerCidOnFile ? ' (CID on file)' : ''}`],
                    ['Peak months', h.peak_months?.map((m: number) => MONTHS[m - 1]).join(', ') || '—'], ['Off-peak', h.off_peak_months?.map((m: number) => MONTHS[m - 1]).join(', ') || '—'],
                    ['Rating from apprentices', h.apprenticeRating.n ? `${h.apprenticeRating.avg} ★ (${h.apprenticeRating.n})` : 'None yet'], ['Verified', h.verified_at ? dateTime(h.verified_at) : '—'],
                  ]} />
                  {h.culture && <p className="mt-3 text-sm text-slate-700">{h.culture}</p>}
                </Card>
                <Card title="Placements">{h.placements.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : <ul className="divide-y divide-navy-50 text-sm">{h.placements.map((p: any) => <li key={p.id} className="py-1.5"><Link className="link" href={`/app/staff/placements/${p.id}`}>{p.apprentice}</Link> · {p.roleTitle} · {date(p.startDate)} <Badge status={p.status} /></li>)}</ul>}</Card>
                <Card title="Change history">{h.changes.length === 0 ? <p className="text-sm text-slate-500">No changes.</p> : <ul className="space-y-1 text-xs">{h.changes.map((c: any, i: number) => <li key={i}><b>{dateTime(c.at)}</b> {c.by}: {Object.entries(c.changes ?? {}).map(([k, v]: [string, any]) => `${label(k)}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`).join('; ')}</li>)}</ul>}</Card>
              </div>
              <div className="space-y-4">
                <Card title="Documents">{h.documents.length === 0 ? <p className="text-sm text-slate-500">No documents uploaded.</p> : <ul className="text-sm">{h.documents.map((d: any) => <li key={d.id}><a className="link" target="_blank" rel="noreferrer" href={fileUrl(`/files/org-docs/${d.id}`)}>{label(d.kind)}</a> · {date(d.createdAt)}</li>)}</ul>}</Card>
                <Card title="Verification decisions">{h.decisions.length === 0 ? <p className="text-sm text-slate-500">None yet.</p> : <ul className="space-y-1 text-xs">{h.decisions.map((d: any, i: number) => <li key={i}>{label(d.item)}: <b>{label(d.decision)}</b> by {d.by}, {date(d.at)}{d.reason && ` · ${d.reason}`}</li>)}</ul>}</Card>
                <Card title="Users">{h.users.map((u: any) => <p key={u.id} className="text-sm">{u.fullName} · {u.mobile} <Badge tone={u.role === 'host_owner' ? 'gold' : 'blue'}>{label(u.role)}</Badge></p>)}</Card>
              </div>
            </div>
          </>
        )}
      </Async>
    </div>
  );
}

function VerifyButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [checks, setChecks] = useState({ tradeLicence: false, address: false, ownerIdentity: false });
  const [run, busy] = useAction((decision: string, reason?: string) => post(`/hosts/${id}/verify`, { decision, checks, reason }), { success: 'Decision recorded', onDone });
  const all = checks.tradeLicence && checks.address && checks.ownerIdentity;
  return (
    <ModalButton label="Verify" className="btn-primary btn-sm" title="Verify this host">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const reason = new FormData(e.currentTarget).get('reason') as string; const decision = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') ?? 'verified'; if (await run(decision, reason || undefined)) close(); }}>
          <p className="text-sm text-slate-600">All three checks must pass before the host can go live.</p>
          <Checkbox label="Trade licence checked and valid" checked={checks.tradeLicence} onChange={(e) => setChecks((c) => ({ ...c, tradeLicence: e.target.checked }))} />
          <Checkbox label="Business address confirmed" checked={checks.address} onChange={(e) => setChecks((c) => ({ ...c, address: e.target.checked }))} />
          <Checkbox label="Owner identity confirmed" checked={checks.ownerIdentity} onChange={(e) => setChecks((c) => ({ ...c, ownerIdentity: e.target.checked }))} />
          <Textarea name="reason" label="Notes or reason" />
          <div className="flex gap-2">
            <SubmitButton busy={busy} value="verified" disabled={!all}>Verify host</SubmitButton>
            <SubmitButton busy={busy} value="pending" className="btn-outline">Save checks</SubmitButton>
            <SubmitButton busy={busy} value="rejected" className="btn-danger">Reject</SubmitButton>
          </div>
        </form>
      )}
    </ModalButton>
  );
}

function StatusButton({ id, status, onDone }: { id: string; status: string; onDone: () => void }) {
  const to = status === 'suspended' ? 'active' : 'suspended';
  const [run, busy] = useAction((reason: string) => post(`/hosts/${id}/status`, { status: to, reason }), { success: to === 'suspended' ? 'Suspended; redeployment tasks created' : 'Reactivated', onDone });
  return (
    <ModalButton label={to === 'suspended' ? 'Suspend' : 'Reactivate'} className={to === 'suspended' ? 'btn-danger btn-sm' : 'btn-outline btn-sm'} title={to === 'suspended' ? 'Suspend this host' : 'Reactivate this host'}>
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(new FormData(e.currentTarget).get('reason') as string)) close(); }}>
          {to === 'suspended' && <Alert tone="warn">Open vacancies are paused and BTBG plans redeployment for every apprentice placed here.</Alert>}
          <Textarea name="reason" label="Reason" required minLength={5} />
          <SubmitButton busy={busy} className={to === 'suspended' ? 'btn-danger' : 'btn-primary'}>Confirm</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function OnBehalf({ orgId, name, onClose }: { orgId: string; name: string; onClose: () => void }) {
  const toast = useToast();
  const [created, setCreated] = useState<any>(null);
  const [code, setCode] = useState('');
  const [run, busy] = useAction(() => post(`/vacancies/${created.id}/host-confirm`, { code }), { success: 'Confirmed by the host and sent for review', onDone: onClose });
  return (
    <div className="mx-auto max-w-4xl space-y-4">
      <PageHeader title={`New vacancy for ${name}`} actions={<button className="btn-ghost" onClick={onClose}>Cancel</button>} subtitle="The host owner confirms it with a code sent to their phone." />
      {!created ? <VacancyForm onSubmitBody={async (vacancy) => { setCreated(await post('/vacancies/on-behalf', { orgId, vacancy })); toast.ok('Code sent to the host owner'); }} /> : (
        <Card title="Host confirmation">
          <p className="mb-2 text-sm">Ask the owner for the code sent to {created.sentTo}.</p>
          <DevCode code={created.devCode} />
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(); }}><OtpInput value={code} onChange={setCode} /><SubmitButton busy={busy} disabled={code.length !== 6}>Confirm and submit</SubmitButton></form>
        </Card>
      )}
    </div>
  );
}
