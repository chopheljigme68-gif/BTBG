'use client';
import Link from 'next/link';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, Input, KeyValue, ModalButton, PageHeader, Select, Stars, SubmitButton, Tabs, Textarea, formData, useAction, useToast } from '@/components/ui';
import { api, fileUrl, patch, post, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label, money, relative } from '@/lib/format';
import { SOURCES, STAGES } from '../constants';

/** Candidate record (FR-CND-04..10): contact log, screening, training, verification and history. */
export default function Candidate({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/candidates/${id}`);
  const { me } = useMe();
  const [tab, setTab] = useState('overview');
  const refresh = () => r.mutate();
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Async r={r}>
        {(c) => (
          <>
            <PageHeader title={c.fullName} back={{ href: '/app/staff/candidates', label: 'Candidates' }}
              subtitle={<span className="flex flex-wrap items-center gap-2"><Badge status={c.stage} /><Badge tone="blue">{label(c.lifecycle)}</Badge>{c.identityStatus === 'verified' ? <Badge tone="green">ID verified</Badge> : <Badge tone="amber">ID {label(c.identityStatus)}</Badge>}{c.contactUnverified && <Badge tone="red">Contact unverified</Badge>}<span className="text-sm">{c.mobile}</span></span>}
              actions={<div className="flex flex-wrap gap-2">
                {can(me, 'candidates.manage') && <ContactButton id={id} onDone={refresh} />}
                {can(me, 'candidates.manage') && <StageButton id={id} stage={c.stage} onDone={refresh} />}
                {can(me, 'candidates.manage') && ['screened', 'training'].includes(c.stage) && <ReadyButton id={id} onDone={refresh} />}
                <Link className="btn-ghost btn-sm" href={`/app/staff/candidates/${id}?trust=1`} onClick={(e) => { e.preventDefault(); setTab('trust'); }}>Trust profile</Link>
              </div>} />
            {c.failedContactAttempts >= 3 && <Alert tone="warn">We could not reach this person {c.failedContactAttempts} times. Try the second contact or a field visit.</Alert>}
            <Tabs value={tab} onChange={setTab} tabs={[
              { id: 'overview', label: 'Overview' }, { id: 'screening', label: 'Screening and training', count: c.screening.length + c.training.length },
              { id: 'jobs', label: 'Applications and placements', count: c.applications.length + c.placements.length }, { id: 'contact', label: 'Contact log', count: c.contacts.length },
              { id: 'history', label: 'History' }, { id: 'trust', label: 'Trust profile' },
            ]} />
            {tab === 'overview' && <Overview c={c} onDone={refresh} />}
            {tab === 'screening' && <Screening c={c} onDone={refresh} />}
            {tab === 'jobs' && <Jobs c={c} />}
            {tab === 'contact' && (
              <Card title="Contact log">
                {c.contacts.length === 0 ? <p className="text-sm text-slate-500">No contact logged yet.</p> : (
                  <ul className="divide-y divide-navy-50 text-sm">{c.contacts.map((x: any, i: number) => <li key={i} className="py-2"><b>{label(x.channel)}</b> · <Badge tone={x.outcome === 'reached' || x.outcome === 'alt_contact_reached' ? 'green' : 'amber'}>{label(x.outcome)}</Badge> · {dateTime(x.at)} by {x.officer}{x.notes && <p className="text-slate-600">{x.notes}</p>}</li>)}</ul>
                )}
              </Card>
            )}
            {tab === 'history' && <History c={c} />}
            {tab === 'trust' && <Trust id={id} />}
          </>
        )}
      </Async>
    </div>
  );
}

function Overview({ c, onDone }: { c: any; onDone: () => void }) {
  const { me } = useMe();
  const toast = useToast();
  const [sensitive, setSensitive] = useState<any>(null);
  const ref = useApi<any>('/public/reference');
  const staff = useApi<any[]>('/admin/staff?role=field_officer');
  const [verify] = useAction((decision: string, reason?: string) => post(`/candidates/${c.id}/verify-identity`, { decision, reason }), { success: 'Saved', onDone });
  const [verifyCred] = useAction((credId: string, decision: string) => post(`/candidates/${c.id}/credentials/${credId}/verify`, { decision }), { success: 'Saved', onDone });
  const [save, saving] = useAction((b: any) => patch(`/candidates/${c.id}`, b), { success: 'Saved', onDone });
  const reveal = async () => { try { setSensitive(await api(`/candidates/${c.id}/sensitive`)); } catch (e) { toast.error(e); } };
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        <Card title="Details" actions={can(me, 'candidates.manage') && (
          <ModalButton label="Edit" title="Edit candidate" wide>
            {(close) => (
              <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => { e.preventDefault(); const b = formData(e.currentTarget); for (const k of ['dzongkhagId', 'gewogId', 'expectedWage']) if (b[k] !== undefined) b[k] = Number(b[k]); if (await save(b)) close(); }}>
                <Input name="fullName" label="Full name" defaultValue={c.fullName} required />
                <Input name="email" label="Email" type="email" defaultValue={c.email ?? ''} />
                <Input name="cid" label="CID (leave blank to keep)" pattern="\d{11}" />
                <Input name="dateOfBirth" type="date" label="Date of birth" defaultValue={c.dateOfBirth ?? ''} />
                <Select name="gender" label="Gender" defaultValue={c.gender ?? ''} placeholder="Not set" options={['female', 'male', 'other', 'prefer_not'].map((g) => ({ value: g, label: label(g) }))} />
                <Select name="dzongkhagId" label="Dzongkhag" defaultValue={c.dzongkhagId ?? ''} placeholder="Not set" options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
                <Input name="village" label="Village" defaultValue={c.village ?? ''} />
                <Input name="expectedWage" type="number" label="Expected wage" defaultValue={c.expectedWage ?? ''} />
                <Select name="source" label="Source" defaultValue={c.source} options={SOURCES.map((s) => ({ value: s, label: label(s) }))} />
                <Input name="sourceDetail" label="Source detail" defaultValue={c.sourceDetail ?? ''} />
                <Select name="officerId" label="Field officer" defaultValue={c.officerId ?? ''} placeholder="Unassigned" options={staff.data?.map((s) => ({ value: s.id, label: s.fullName })) ?? []} />
                <Input name="altContactName" label="Second contact name" defaultValue={c.altContact.name ?? ''} />
                <Input name="altContactMobile" label="Second contact mobile" defaultValue={c.altContact.mobile ?? ''} />
                <Input name="altContactRelation" label="Relationship" defaultValue={c.altContact.relation ?? ''} />
                <div className="sm:col-span-2"><SubmitButton busy={saving}>Save</SubmitButton></div>
              </form>
            )}
          </ModalButton>
        )}>
          <KeyValue items={[
            ['CID', sensitive ? sensitive.cid ?? '—' : <span key="c">{c.cidMasked ?? '—'} {c.canViewSensitive && c.cidMasked && <button className="link ml-1 text-xs" onClick={reveal}>Show (audited)</button>}</span>],
            ['Date of birth', date(c.dateOfBirth)], ['Gender', label(c.gender)], ['From', [c.village, c.gewog, c.dzongkhag].filter(Boolean).join(', ') || '—'],
            ['Email', c.email], ['Expected wage', money(c.expectedWage)], ['Available from', date(c.availableFrom)], ['Work type', label(c.employmentType)],
            ['Wants', c.preferredRoles.join(', ') || '—'], ['Career interest', c.preferredCareer], ['Languages', c.languages?.join(', ') || '—'], ['Relocate', c.willingToRelocate === null ? '—' : c.willingToRelocate ? 'Yes' : 'No'],
            ['Source', `${label(c.source)}${c.sourceDetail ? ` (${c.sourceDetail})` : ''}`], ['Field officer', c.officer], ['Second contact', c.altContact.name ? `${c.altContact.name} (${c.altContact.relation ?? ''}) ${c.altContact.mobile ?? ''}` : '—'],
            ['Bank', sensitive?.bankAccount ? `${c.bank?.name} ${sensitive.bankAccount}` : c.bank?.accountLast4 ? `${c.bank.name} ••••${c.bank.accountLast4} (${c.bank.holder})` : '—'],
            ['Registered', date(c.createdAt)], ['Last contact', relative(c.lastContactAt)],
          ]} />
          {c.bio && <p className="mt-3 text-sm text-slate-700">{c.bio}</p>}
        </Card>
        <Card title="Education and credentials">
          {c.credentials.length === 0 ? <p className="text-sm text-slate-500">None added.</p> : (
            <ul className="divide-y divide-navy-50 text-sm">
              {c.credentials.map((x: any) => (
                <li key={x.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>{x.qualification ?? label(x.type)} · {x.institution} {x.year && `(${x.year})`} {x.filePath && <a className="link" target="_blank" rel="noreferrer" href={fileUrl(`/files/credentials/${x.id}`)}>file</a>}</span>
                  <span className="flex items-center gap-1"><Badge status={x.verificationStatus} />{can(me, 'candidates.verify') && x.verificationStatus !== 'verified' && <><button className="btn-outline btn-sm" onClick={() => verifyCred(x.id, 'verified')}>Verify</button><button className="btn-ghost btn-sm" onClick={() => verifyCred(x.id, 'rejected')}>Reject</button></>}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card title="Work history">{c.workHistory.length === 0 ? <p className="text-sm text-slate-500">None added.</p> : <ul className="text-sm">{c.workHistory.map((w: any) => <li key={w.id} className="py-1"><b>{w.role}</b> · {w.employer} · {date(w.startDate)} to {w.endDate ? date(w.endDate) : 'now'}</li>)}</ul>}</Card>
      </div>
      <div className="space-y-4">
        <Card title={`Profile ${c.completeness.score}% complete`}><ul className="list-disc pl-5 text-xs text-slate-600">{c.completeness.tips.map((t: string) => <li key={t}>{t}</li>)}</ul></Card>
        <Card title="Identity">
          <p className="text-sm">Status: <Badge status={c.identityStatus} /></p>
          {can(me, 'candidates.verify') && c.identityStatus !== 'verified' && (
            <div className="mt-2 flex gap-2"><button className="btn-primary btn-sm" onClick={() => verify('verified')}>Mark verified</button><button className="btn-ghost btn-sm" onClick={() => { const r = prompt('Reason for rejecting'); if (r) verify('rejected', r); }}>Reject</button></div>
          )}
          {c.verifications.length > 0 && <ul className="mt-2 text-xs text-slate-500">{c.verifications.map((v: any, i: number) => <li key={i}>{label(v.item)}: {label(v.decision)} by {v.by}, {date(v.at)}{v.reason && ` (${v.reason})`}</li>)}</ul>}
        </Card>
        <Card title="Skills">{c.skills.length ? <ul className="text-sm">{c.skills.map((s: any) => <li key={s.id} className="flex justify-between">{s.name}<Stars value={s.level} size="text-sm" /></li>)}</ul> : <p className="text-sm text-slate-500">None.</p>}</Card>
        {c.certificates.length > 0 && <Card title="Certificates"><ul className="text-sm">{c.certificates.map((x: any) => <li key={x.id}>{x.title} · <Link className="link" href={`/verify/${x.code}`}>{x.code}</Link>{x.revokedAt && <Badge tone="red">Revoked</Badge>}</li>)}</ul></Card>}
        {can(me, 'payroll.prepare') && <AdjustmentButton id={c.id} />}
      </div>
    </div>
  );
}

function Screening({ c, onDone }: { c: any; onDone: () => void }) {
  const { me } = useMe();
  const cards = useApi<any[]>(can(me, 'candidates.screen') ? '/admin/scorecards' : null);
  const [card, setCard] = useState<string>('');
  const [scores, setScores] = useState<Record<string, number>>({});
  const [run, busy] = useAction((b: any) => post(`/candidates/${c.id}/screening`, b), { success: (r: any) => `Screening saved: ${r.total ?? ''} points`, onDone });
  const [train, training] = useAction((b: any) => post(`/candidates/${c.id}/training`, b), { success: 'Training recorded', onDone });
  const active = cards.data?.filter((s) => s.isActive) ?? [];
  const sc = active.find((s) => s.id === (card || active[0]?.id));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Screening results">
        {c.screening.length === 0 ? <p className="text-sm text-slate-500">Not screened yet.</p> : c.screening.map((s: any) => (
          <div key={s.id} className="mb-3 rounded-lg border border-navy-100 p-3 text-sm">
            <p><b>{s.total} points</b> <Badge tone={s.passed ? 'green' : 'red'}>{s.passed ? 'Passed' : 'Below threshold'}</Badge> · {s.scorecard} v{s.version} · {date(s.createdAt)} by {s.officer}</p>
            <ul className="mt-1 grid grid-cols-2 text-xs text-slate-600">{s.criteria.map((k: any) => <li key={k.key}>{k.label}: {s.scores[k.key] ?? 0}/{k.max}</li>)}</ul>
            {s.notes && <p className="mt-1 text-xs">{s.notes}</p>}
          </div>
        ))}
        {sc && (
          <ModalButton label="Record screening" className="btn-primary btn-sm" title="Screening scorecard" wide>
            {(close) => (
              <form className="space-y-3" onSubmit={async (e) => {
                e.preventDefault(); const f = formData(e.currentTarget);
                if (await run({ scorecardId: sc.id, scores, wageExpectation: f.wageExpectation ?? null, commitmentMonths: f.commitmentMonths ?? null, willingToRelocate: f.willingToRelocate === undefined ? null : f.willingToRelocate === 'true', notes: f.notes })) { setScores({}); close(); }
              }}>
                {active.length > 1 && <Select label="Scorecard" value={sc.id} onChange={(e) => setCard(e.target.value)} options={active.map((s) => ({ value: s.id, label: s.name }))} />}
                <p className="text-xs text-slate-500">Pass mark {sc.passThreshold}. Score each item 0 to its maximum.</p>
                {sc.criteria.map((k: any) => (
                  <div key={k.key} className="flex items-center justify-between gap-3 text-sm">
                    <span>{k.label} <span className="text-xs text-slate-400">(weight {k.weight})</span></span>
                    <div className="flex gap-1">{Array.from({ length: k.max + 1 }, (_, n) => <button key={n} type="button" onClick={() => setScores((x) => ({ ...x, [k.key]: n }))} className={`h-7 w-7 rounded text-xs ring-1 ${scores[k.key] === n ? 'bg-navy-900 text-white ring-navy-900' : 'ring-navy-200'}`}>{n}</button>)}</div>
                  </div>
                ))}
                <div className="grid grid-cols-3 gap-3">
                  <Input name="wageExpectation" type="number" label="Wage expected" />
                  <Input name="commitmentMonths" type="number" label="Commits (months)" />
                  <Select name="willingToRelocate" label="Relocate" placeholder="Unknown" options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
                </div>
                <Textarea name="notes" label="Notes" />
                <SubmitButton busy={busy} disabled={sc.criteria.some((k: any) => scores[k.key] === undefined)}>Save screening</SubmitButton>
              </form>
            )}
          </ModalButton>
        )}
      </Card>
      <Card title="Training" actions={can(me, 'candidates.screen') && (
        <ModalButton label="Record training" title="Training record">
          {(close) => (
            <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const b = formData(e.currentTarget); b.issueCertificate = Boolean(b.issueCertificate); if (b.attendancePct !== undefined) b.attendancePct = Number(b.attendancePct); if (await train(b)) close(); }}>
              <Input name="programme" label="Programme" required />
              <Input name="provider" label="Provider" required />
              <div className="grid grid-cols-2 gap-3"><Input name="startDate" type="date" label="Start" /><Input name="endDate" type="date" label="End" /></div>
              <Input name="attendancePct" type="number" min={0} max={100} label="Attendance %" />
              <Input name="assessment" label="Assessment" />
              <Select name="result" label="Result" options={[{ value: 'in_progress', label: 'In progress' }, { value: 'passed', label: 'Passed' }, { value: 'failed', label: 'Failed' }]} />
              <Checkbox name="issueCertificate" value="true" label="Issue a BTBG training certificate" />
              <SubmitButton busy={training}>Save</SubmitButton>
            </form>
          )}
        </ModalButton>
      )}>
        {c.training.length === 0 ? <p className="text-sm text-slate-500">No training yet.</p> : (
          <ul className="divide-y divide-navy-50 text-sm">{c.training.map((t: any) => <li key={t.id} className="py-2"><b>{t.programme}</b> · {t.provider} <Badge status={t.result} /><p className="text-xs text-slate-500">{date(t.startDate)} to {date(t.endDate)} · {t.attendancePct ?? '—'}% attendance{t.assessment && ` · ${t.assessment}`}</p></li>)}</ul>
        )}
      </Card>
    </div>
  );
}

function Jobs({ c }: { c: any }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Applications">
        {c.applications.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="divide-y divide-navy-50 text-sm">{c.applications.map((a: any) => <li key={a.id} className="py-2"><Link className="link" href={`/app/staff/vacancies/${a.vacancyId}`}>{a.title}</Link> · {a.host} <Badge status={a.stage} /><p className="text-xs text-slate-500">Applied {date(a.appliedAt)} · match {a.matchScore ?? '—'}% · {money(a.offeredWage)}{a.hostDecision && ` · host ${a.hostDecision}`}</p></li>)}</ul>}
      </Card>
      <Card title="Placements">
        {c.placements.length === 0 ? <p className="text-sm text-slate-500">None.</p> : <ul className="divide-y divide-navy-50 text-sm">{c.placements.map((p: any) => <li key={p.id} className="py-2"><Link className="link" href={`/app/staff/placements/${p.id}`}>{p.roleTitle} at {p.host}</Link> <Badge status={p.status} /><p className="text-xs text-slate-500">{date(p.startDate)} to {date(p.plannedEndDate)}{p.outcome && ` · ${label(p.outcome)}`}</p></li>)}</ul>}
      </Card>
    </div>
  );
}

function History({ c }: { c: any }) {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Stage history"><ul className="space-y-1.5 text-sm">{c.stageHistory.map((h: any, i: number) => <li key={i}>{h.from ? `${label(h.from)} → ` : ''}<b>{label(h.to)}</b> · {dateTime(h.at)} by {h.by ?? 'system'}<p className="text-xs text-slate-500">{h.reason}</p></li>)}</ul></Card>
      <Card title="Changes to details">{c.changes.length === 0 ? <p className="text-sm text-slate-500">No edits.</p> : <ul className="space-y-1.5 text-xs">{c.changes.map((h: any, i: number) => <li key={i}><b>{dateTime(h.at)}</b> by {h.by}: {Object.entries(h.changes ?? {}).map(([k, v]: [string, any]) => `${label(k)}: ${v?.from ?? '—'} → ${v?.to ?? '—'}`).join('; ')}</li>)}</ul>}</Card>
    </div>
  );
}

function Trust({ id }: { id: string }) {
  const r = useApi<any>(`/candidates/${id}/trust-profile`);
  return (
    <Card title="Trust Profile (what hosts see)">
      <Async r={r}>{(t) => !t ? <p className="text-sm">Not available.</p> : (
        <KeyValue items={[['Name', t.name], ['Age', t.age], ['From', t.location], ['ID verified', t.identityVerified ? 'Yes' : 'No'], ['Screening', t.screening ? `${t.screening.score} (${t.screening.passed ? 'passed' : 'below'})` : '—'], ['Training attendance', t.trainingAttendanceAvg !== null ? `${t.trainingAttendanceAvg}%` : '—'], ['Skills', t.skills.map((s: any) => s.name).join(', ') || '—'], ['References', t.references.length], ['Contact', t.contact.hidden ? 'Hidden until interview' : t.contact.mobile]]} />
      )}</Async>
    </Card>
  );
}

function ContactButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/candidates/${id}/contact`, b), { success: 'Contact logged', onDone });
  return (
    <ModalButton label="Log contact" title="Log a contact attempt">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(formData(e.currentTarget))) close(); }}>
          <Select name="channel" label="How" options={['phone', 'sms', 'visit', 'email', 'alt_contact'].map((x) => ({ value: x, label: label(x) }))} />
          <Select name="outcome" label="Outcome" options={['reached', 'no_answer', 'wrong_number', 'alt_contact_reached'].map((x) => ({ value: x, label: label(x) }))} />
          <Textarea name="notes" label="Notes" />
          <SubmitButton busy={busy}>Save</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function StageButton({ id, stage, onDone }: { id: string; stage: string; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => post(`/candidates/${id}/stage`, b), { success: 'Stage updated', onDone });
  return (
    <ModalButton label="Change stage" title="Move to another stage">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await run(formData(e.currentTarget))) close(); }}>
          <Select name="stage" label="New stage" defaultValue={stage} options={STAGES.map((s) => ({ value: s, label: label(s) }))} />
          <Textarea name="reason" label="Reason" required minLength={3} />
          <SubmitButton busy={busy}>Move</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}

function ReadyButton({ id, onDone }: { id: string; onDone: () => void }) {
  const [run, busy] = useAction(() => post(`/candidates/${id}/ready`), { success: 'Ready for placement; Trust Profile published', onDone });
  return <button className="btn-gold btn-sm" disabled={busy} onClick={() => run()}>Mark ready for placement</button>;
}

function AdjustmentButton({ id }: { id: string }) {
  const [run, busy] = useAction((b: any) => post(`/candidates/${id}/payroll-adjustment`, b), { success: 'Added to the next payroll run' });
  return (
    <ModalButton label="Payroll correction" className="btn-outline btn-sm w-full" title="Correction for the next payroll run">
      {(close) => (
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const b = formData(e.currentTarget); b.amount = Number(b.amount); if (await run(b)) close(); }}>
          <Input name="amount" type="number" step="0.01" label="Amount (Nu, negative to deduct)" required />
          <Textarea name="reason" label="Reason" required minLength={3} />
          <SubmitButton busy={busy}>Add</SubmitButton>
        </form>
      )}
    </ModalButton>
  );
}
