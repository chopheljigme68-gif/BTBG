'use client';
import { useMemo, useState } from 'react';
import { Alert, Async, Badge, Card, FilePicker, Input, ModalButton, PageHeader, Select, SubmitButton, Textarea, formData, useAction, useToast } from '@/components/ui';
import { del, fileUrl, patch, post, put, upload, useApi } from '@/lib/api';
import { date, label } from '@/lib/format';

/**
 * Profile with autosave (FR-EE-01): each field saves when you leave it, so
 * nothing is lost on a slow or dropped connection.
 */
export default function Profile() {
  const r = useApi<any>('/me/profile');
  const ref = useApi<any>('/public/reference');
  const toast = useToast();
  const [savedAt, setSavedAt] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const save = async (field: string, value: unknown) => {
    setSaving(true);
    try {
      await patch('/me/profile', { [field]: value });
      setSavedAt(new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }));
      r.mutate();
    } catch (e) {
      toast.error(e);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title="My profile" subtitle="Changes save automatically when you move to the next field."
        actions={<span className="text-sm text-slate-500" aria-live="polite">{saving ? 'Saving…' : savedAt ? `✓ Saved at ${savedAt}` : ''}</span>} />
      <Async r={r}>
        {(p) => (
          <>
            <Card>
              <div className="flex items-center justify-between gap-4">
                <div className="flex-1">
                  <p className="text-sm font-medium text-navy-900">Profile strength: {p.completeness.score}%</p>
                  <div className="mt-1 h-2 rounded-full bg-navy-50"><div className="h-2 rounded-full bg-gold-500 transition-all" style={{ width: `${p.completeness.score}%` }} /></div>
                  {p.completeness.tips[0] && <p className="mt-1 text-xs text-slate-600">Next: {p.completeness.tips[0]}</p>}
                </div>
                <div className="text-right text-xs"><Badge status={p.stage} /><br /><span className="text-slate-500">Identity: {label(p.identityStatus)}</span></div>
              </div>
            </Card>

            <Card title="About me">
              <div className="grid gap-4 sm:grid-cols-2">
                <Auto label="Full name" field="fullName" value={p.fullName} save={save} required />
                <Auto label="Email" field="email" type="email" value={p.email} save={save} />
                <Auto label="CID number" field="cid" value="" placeholder={p.cidLast4 ? `Saved, ends ${p.cidLast4}` : '11 digits'} save={save} hint="Stored encrypted. Only BTBG staff who need it can see it." />
                <Auto label="Date of birth" field="dateOfBirth" type="date" value={p.dateOfBirth} save={save} />
                <AutoSelect label="Gender" field="gender" value={p.gender} save={save} options={['female', 'male', 'other', 'prefer_not'].map((g) => ({ value: g, label: g === 'prefer_not' ? 'Prefer not to say' : label(g) }))} />
                <AutoSelect label="Dzongkhag" field="dzongkhagId" numeric value={p.dzongkhagId} save={save} options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
                <AutoSelect label="Gewog" field="gewogId" numeric value={p.gewogId} save={save} options={ref.data?.gewogs.filter((g: any) => g.dzongkhagId === p.dzongkhagId).map((g: any) => ({ value: g.id, label: g.name })) ?? []} />
                <Auto label="Village" field="village" value={p.village} save={save} />
              </div>
              <div className="mt-4"><Auto label="A few words about me" field="bio" textarea value={p.bio} save={save} /></div>
            </Card>

            <Card title="Someone we can call if we cannot reach you">
              <div className="grid gap-4 sm:grid-cols-3">
                <Auto label="Name" field="altContactName" value={p.altContactName} save={save} />
                <Auto label="Mobile" field="altContactMobile" value={p.altContactMobile} save={save} />
                <Auto label="Relationship" field="altContactRelation" value={p.altContactRelation} save={save} />
              </div>
            </Card>

            <Card title="What I am looking for">
              <div className="grid gap-4 sm:grid-cols-2">
                <Auto label="Expected wage (Nu a month)" field="expectedWage" type="number" value={p.expectedWage} save={save} />
                <Auto label="Available from" field="availableFrom" type="date" value={p.availableFrom} save={save} />
                <AutoSelect label="Type of work" field="employmentType" value={p.employmentType} save={save} options={[{ value: 'full_time', label: 'Full-time' }, { value: 'freelance', label: 'Freelance or gig' }]} allowEmpty={false} />
                <AutoSelect label="Willing to move for work" field="willingToRelocate" value={p.willingToRelocate === null ? '' : String(p.willingToRelocate)} save={(f, v) => save(f, v === '' ? null : v === 'true')} options={[{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }]} />
                <AutoList label="Jobs I want" field="preferredRoles" value={p.preferredRoles} save={save} hint="Separate with commas, e.g. housekeeping, waiter" />
                <AutoList label="Languages I speak" field="languages" value={p.languages} save={save} hint="e.g. Dzongkha, English, Sharchop" />
              </div>
              <PreferredPlaces value={p.preferredDzongkhags} options={ref.data?.dzongkhags ?? []} save={save} />
            </Card>

            <SkillsCard skills={p.skills} all={ref.data?.skills ?? []} onSaved={() => r.mutate()} />
            <CredentialsCard items={p.credentials} onChange={() => r.mutate()} />
            <WorkCard items={p.workHistory} onChange={() => r.mutate()} />
            <PortfolioCard items={p.portfolio} onChange={() => r.mutate()} />
            <BankCard p={p} onChange={() => r.mutate()} />
          </>
        )}
      </Async>
    </div>
  );
}

type SaveFn = (field: string, value: unknown) => void;

function Auto({ label: l, field, value, save, type = 'text', textarea, hint, placeholder, required }: { label: string; field: string; value: any; save: SaveFn; type?: string; textarea?: boolean; hint?: string; placeholder?: string; required?: boolean }) {
  const initial = value ?? '';
  const onBlur = (e: React.FocusEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const v = e.target.value.trim();
    if (v === String(initial)) return;
    if (field === 'cid' && !v) return;
    if (required && !v) return;
    save(field, v === '' ? null : type === 'number' ? Number(v) : v);
    if (field === 'cid') e.target.value = '';
  };
  return textarea
    ? <Textarea label={l} defaultValue={initial} onBlur={onBlur} hint={hint} maxLength={1000} />
    : <Input label={l} type={type} defaultValue={initial} onBlur={onBlur} hint={hint} placeholder={placeholder} required={required} />;
}

function AutoSelect({ label: l, field, value, save, options, numeric, allowEmpty = true }: { label: string; field: string; value: any; save: SaveFn; options: Array<{ value: any; label: string }>; numeric?: boolean; allowEmpty?: boolean }) {
  return (
    <Select label={l} value={value ?? ''} placeholder={allowEmpty ? 'Not set' : undefined} options={options}
      onChange={(e) => save(field, e.target.value === '' ? null : numeric ? Number(e.target.value) : e.target.value)} />
  );
}

function AutoList({ label: l, field, value, save, hint }: { label: string; field: string; value: string[]; save: SaveFn; hint?: string }) {
  const initial = (value ?? []).join(', ');
  return <Input label={l} defaultValue={initial} hint={hint} onBlur={(e) => { if (e.target.value !== initial) save(field, e.target.value.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 10)); }} />;
}

function PreferredPlaces({ value, options, save }: { value: number[]; options: any[]; save: SaveFn }) {
  const toggle = (id: number) => save('preferredDzongkhags', value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  return (
    <div className="mt-4">
      <p className="label">Dzongkhags where I would work</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((d) => (
          <button key={d.id} type="button" onClick={() => toggle(d.id)} aria-pressed={value.includes(d.id)}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ${value.includes(d.id) ? 'bg-navy-900 text-white ring-navy-900' : 'bg-white text-navy-800 ring-navy-200 hover:bg-navy-50'}`}>{d.name}</button>
        ))}
      </div>
    </div>
  );
}

function SkillsCard({ skills, all, onSaved }: { skills: any[]; all: any[]; onSaved: () => void }) {
  const [sel, setSel] = useState<Record<number, number>>(() => Object.fromEntries(skills.map((s) => [s.id, s.level])));
  const [filter, setFilter] = useState('');
  const [run, busy] = useAction(() => put('/me/skills', { skills: Object.entries(sel).map(([id, level]) => ({ skillId: Number(id), level })) }), { success: 'Skills saved', onDone: onSaved });
  const shown = useMemo(() => all.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase())), [all, filter]);
  return (
    <Card title="Skills" actions={<button className="btn-primary btn-sm" disabled={busy} onClick={() => run()}>Save skills</button>}>
      <input className="input mb-3 max-w-xs" placeholder="Filter skills" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filter skills" />
      <div className="grid gap-2 sm:grid-cols-2">
        {shown.map((s) => (
          <div key={s.id} className="flex items-center justify-between gap-2 rounded-lg border border-navy-100 px-3 py-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="h-4 w-4 accent-navy-900" checked={s.id in sel} onChange={(e) => setSel((x) => { const n = { ...x }; if (e.target.checked) n[s.id] = 2; else delete n[s.id]; return n; })} />
              {s.name}
            </label>
            {s.id in sel && (
              <select className="rounded border border-navy-200 px-1 py-0.5 text-xs" value={sel[s.id]} onChange={(e) => setSel((x) => ({ ...x, [s.id]: Number(e.target.value) }))} aria-label={`${s.name} level`}>
                {['Beginner', 'Some practice', 'Confident', 'Experienced', 'Expert'].map((l, i) => <option key={l} value={i + 1}>{l}</option>)}
              </select>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}

function CredentialsCard({ items, onChange }: { items: any[]; onChange: () => void }) {
  const [remove] = useAction((id: string) => del(`/me/credentials/${id}`), { onDone: onChange });
  return (
    <Card title="Education and certificates" actions={
      <ModalButton label="Add" title="Add education or a certificate">
        {(close) => <CredentialForm onDone={() => { close(); onChange(); }} />}
      </ModalButton>
    }>
      {items.length === 0 ? <p className="text-sm text-slate-500">Add your school, TTI or other certificates. Photos of the certificate are fine.</p> : (
        <ul className="divide-y divide-navy-50 text-sm">
          {items.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-3 py-2">
              <span><b>{c.qualification ?? label(c.type)}</b> · {c.institution} {c.year && `(${c.year})`} {c.hasFile && <a className="link ml-1" href={fileUrl(`/files/credentials/${c.id}`)} target="_blank" rel="noreferrer">file</a>}</span>
              <span className="flex items-center gap-2"><Badge status={c.verificationStatus} />{c.verificationStatus !== 'verified' && <button className="btn-ghost btn-sm" onClick={() => remove(c.id)}>Remove</button>}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CredentialForm({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [run, busy] = useAction((b: any) => (file ? upload('/me/credentials', file, b) : post('/me/credentials', b)), { success: 'Added', onDone });
  return (
    <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run(formData(e.currentTarget)); }}>
      <Select name="type" label="Type" required options={[{ value: 'school', label: 'School' }, { value: 'tvet', label: 'TTI or vocational' }, { value: 'university', label: 'College or university' }, { value: 'certificate', label: 'Other certificate' }]} />
      <Input name="institution" label="School or institution" required minLength={2} />
      <Input name="qualification" label="Qualification" placeholder="e.g. Class XII, Certificate in Food Production" />
      <Input name="year" type="number" label="Year" min={1970} max={2100} />
      <FilePicker label={file ? file.name : 'Attach PDF or photo (optional)'} accept=".pdf,image/*" onFile={setFile} hint="Up to 10 MB." />
      <SubmitButton busy={busy}>Add</SubmitButton>
    </form>
  );
}

function WorkCard({ items, onChange }: { items: any[]; onChange: () => void }) {
  const [remove] = useAction((id: string) => del(`/me/work/${id}`), { onDone: onChange });
  const [add, busy] = useAction((b: any) => post('/me/work', b), { success: 'Added', onDone: onChange });
  return (
    <Card title="Work experience" actions={
      <ModalButton label="Add" title="Add work experience">
        {(close) => (
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); if (await add(formData(e.currentTarget))) close(); }}>
            <Input name="employer" label="Employer" required minLength={2} />
            <Input name="role" label="Role" required minLength={2} />
            <div className="grid grid-cols-2 gap-3"><Input name="startDate" type="date" label="From" /><Input name="endDate" type="date" label="To" /></div>
            <Textarea name="description" label="What you did" maxLength={500} />
            <SubmitButton busy={busy}>Add</SubmitButton>
          </form>
        )}
      </ModalButton>
    }>
      {items.length === 0 ? <p className="text-sm text-slate-500">Farm work, family business and volunteering count too.</p> : (
        <ul className="divide-y divide-navy-50 text-sm">
          {items.map((w) => (
            <li key={w.id} className="flex items-start justify-between gap-3 py-2">
              <div><b>{w.role}</b> · {w.employer}<p className="text-xs text-slate-500">{date(w.startDate)} to {w.endDate ? date(w.endDate) : 'now'}</p>{w.description && <p className="text-slate-600">{w.description}</p>}</div>
              <button className="btn-ghost btn-sm" onClick={() => remove(w.id)}>Remove</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function PortfolioCard({ items, onChange }: { items: any[]; onChange: () => void }) {
  const toast = useToast();
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [remove] = useAction((id: string) => del(`/me/portfolio/${id}`), { onDone: onChange });
  const onFile = async (file: File) => {
    setBusy(true);
    try {
      let durationSeconds: number | undefined;
      if (file.type.startsWith('video/')) {
        durationSeconds = await videoDuration(file);
        if (durationSeconds > 60) throw new Error('Videos must be 60 seconds or shorter.');
      }
      await upload('/me/portfolio', file, { caption: caption || undefined, durationSeconds });
      setCaption('');
      toast.ok('Added to your portfolio');
      onChange();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Portfolio" actions={<FilePicker label="Upload photo or video" accept="image/*,video/*" onFile={onFile} busy={busy} />}>
      <Input label="Caption for the next upload" value={caption} onChange={(e) => setCaption(e.target.value)} hint="Show your work: a dish you cooked, a room you prepared. Videos up to 60 seconds." />
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {items.map((m) => (
          <figure key={m.id} className="group relative overflow-hidden rounded-lg bg-navy-50">
            {m.kind === 'video' ? <video src={fileUrl(`/files/portfolio/${m.id}`)} controls preload="none" className="aspect-square w-full object-cover" /> : <img src={fileUrl(`/files/portfolio/${m.id}`)} alt={m.caption ?? 'Portfolio item'} className="aspect-square w-full object-cover" loading="lazy" />}
            {m.caption && <figcaption className="p-1.5 text-xs">{m.caption}</figcaption>}
            <button className="absolute top-1 right-1 rounded bg-white/90 px-1.5 text-xs opacity-0 group-hover:opacity-100 focus:opacity-100" onClick={() => remove(m.id)} aria-label="Remove">✕</button>
          </figure>
        ))}
      </div>
    </Card>
  );
}

function videoDuration(file: File) {
  return new Promise<number>((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.onloadedmetadata = () => { URL.revokeObjectURL(v.src); resolve(Math.ceil(v.duration || 1)); };
    v.onerror = () => resolve(1);
    v.src = URL.createObjectURL(file);
  });
}

function BankCard({ p, onChange }: { p: any; onChange: () => void }) {
  const [run, busy] = useAction((b: any) => put('/me/bank', b), { success: 'Bank details saved securely', onDone: onChange });
  return (
    <Card title="Bank account for your salary">
      {p.bankAccountLast4 && <div className="mb-3"><Alert tone="ok">Salary goes to {p.bankName} account ending <b>{p.bankAccountLast4}</b> ({p.bankAccountHolder}).</Alert></div>}
      <form className="grid gap-3 sm:grid-cols-3 sm:items-end" onSubmit={(e) => { e.preventDefault(); run(formData(e.currentTarget)); }}>
        <Select name="bankName" label="Bank" required options={['BoB', 'BNB', 'BDBL', 'T-Bank', 'DPNB'].map((b) => ({ value: b, label: b }))} />
        <Input name="accountNumber" label="Account number" inputMode="numeric" pattern="\d{6,20}" required />
        <Input name="accountHolder" label="Name on account" required defaultValue={p.fullName} />
        <div className="sm:col-span-3"><SubmitButton busy={busy}>{p.bankAccountLast4 ? 'Change account' : 'Save account'}</SubmitButton></div>
      </form>
      <p className="mt-2 text-xs text-slate-500">Encrypted; only Finance can see the full number.</p>
    </Card>
  );
}
