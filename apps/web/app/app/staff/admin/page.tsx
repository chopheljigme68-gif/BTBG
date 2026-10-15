'use client';
import { useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, Input, ModalButton, PageHeader, Select, SubmitButton, Table, Tabs, Textarea, useAction, useToast } from '@/components/ui';
import { ListView } from '@/components/staff';
import { api, post, put, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { dateTime, label, money, relative } from '@/lib/format';

/** System administration (SRS 3.11): users, roles, settings, fees, scorecards, templates, jobs and audit. */
export default function Admin() {
  const { me } = useMe();
  const tabs = [
    ...(can(me, 'users.manage', 'accounts.suspend') ? [{ id: 'users', label: 'Users' }] : []),
    ...(can(me, 'roles.manage', 'users.manage') ? [{ id: 'roles', label: 'Roles' }] : []),
    ...(can(me, 'config.manage') ? [{ id: 'config', label: 'Settings' }, { id: 'reference', label: 'Places and skills' }, { id: 'scorecards', label: 'Scorecards' }, { id: 'jobs', label: 'Scheduled jobs' }] : []),
    ...(can(me, 'billing.manage', 'config.manage') ? [{ id: 'fees', label: 'Fee rules' }] : []),
    ...(can(me, 'notifications.templates') ? [{ id: 'templates', label: 'Messages' }] : []),
    ...(can(me, 'audit.view') ? [{ id: 'audit', label: 'Audit log' }] : []),
  ];
  const [tab, setTab] = useState(tabs[0]?.id ?? 'users');
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Administration" />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'users' && <Users />}
      {tab === 'roles' && <Roles />}
      {tab === 'config' && <Config />}
      {tab === 'reference' && <Reference />}
      {tab === 'scorecards' && <Scorecards />}
      {tab === 'jobs' && <Jobs />}
      {tab === 'fees' && <Fees />}
      {tab === 'templates' && <Templates />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

function useRoles() {
  return useApi<{ roles: any[]; catalog: Record<string, string> }>('/admin/roles');
}

function Users() {
  const roles = useRoles();
  const { me } = useMe();
  const [key, setKey] = useState(0);
  const refresh = () => setKey((k) => k + 1);
  const internal = roles.data?.roles.filter((r) => r.isInternal) ?? [];
  const [create, creating] = useAction((b: any) => post('/admin/users', b), { success: 'Staff account created', onDone: refresh });
  const [setRoles] = useAction((id: string, r: string[]) => put(`/admin/users/${id}/roles`, { roles: r }), { success: 'Roles updated', onDone: refresh });
  const [status] = useAction((id: string, s: string, reason: string) => post(`/admin/users/${id}/status`, { status: s, reason }), { success: 'Updated', onDone: refresh });
  const [unlock] = useAction((id: string) => post(`/admin/users/${id}/unlock`), { success: 'Unlocked', onDone: refresh });
  return (
    <ListView key={key} path="/admin/users" searchPlaceholder="Name or mobile"
      filters={[{ name: 'kind', label: 'Kind', options: [{ value: 'staff', label: 'Staff' }, { value: 'host', label: 'Hosts' }, { value: 'seeker', label: 'Job seekers' }] }, { name: 'role', label: 'Role', options: roles.data?.roles.map((r) => ({ value: r.code, label: r.name })) ?? [] }]}
      toolbar={can(me, 'users.manage') && (
        <ModalButton label="New staff account" className="btn-gold btn-sm" title="Create a staff account">
          {(close) => (
            <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await create({ fullName: f.get('fullName'), mobile: f.get('mobile'), email: (f.get('email') as string) || undefined, initialPassword: f.get('initialPassword'), roles: f.getAll('roles') })) close(); }}>
              <Input name="fullName" label="Full name" required /><Input name="mobile" label="Mobile" required /><Input name="email" type="email" label="Email" />
              <Input name="initialPassword" type="text" label="Temporary password" minLength={8} required hint="They must set up two-step sign-in on first login." />
              <fieldset><legend className="label">Roles</legend>{internal.map((r) => <label key={r.code} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" name="roles" value={r.code} />{r.name}</label>)}</fieldset>
              <SubmitButton busy={creating}>Create</SubmitButton>
            </form>
          )}
        </ModalButton>
      )}
      columns={[
        { key: 'fullName', label: 'Name', render: (u: any) => <><b>{u.fullName}</b><p className="text-xs text-slate-500">{u.mobile}{u.email && ` · ${u.email}`}</p></> },
        { key: 'roles', label: 'Roles', render: (u: any) => <div className="flex flex-wrap gap-1">{u.roles.map((r: any, i: number) => <Badge key={i} tone="blue">{label(r.role)}{r.orgName && ` · ${r.orgName}`}</Badge>)}</div> },
        { key: 'status', label: 'Status', render: (u: any) => <><Badge status={u.status} />{u.locked && <Badge tone="red">Locked</Badge>}</> },
        { key: 'lastLoginAt', label: 'Last sign-in', render: (u: any) => relative(u.lastLoginAt) || 'Never' },
        { key: 'x', label: '', render: (u: any) => (
          <div className="flex flex-wrap justify-end gap-1">
            {u.locked && <button className="btn-outline btn-sm" onClick={() => unlock(u.id)}>Unlock</button>}
            {can(me, 'users.manage') && u.roles.some((r: any) => !r.orgId && !['job_seeker'].includes(r.role)) && (
              <ModalButton label="Roles" title={`Roles for ${u.fullName}`}>
                {(close) => <form className="space-y-2" onSubmit={async (e) => { e.preventDefault(); if (await setRoles(u.id, new FormData(e.currentTarget).getAll('roles') as string[])) close(); }}>
                  {internal.map((r) => <label key={r.code} className="flex items-center gap-2 text-sm"><input type="checkbox" name="roles" value={r.code} defaultChecked={u.roles.some((x: any) => x.role === r.code)} />{r.name}</label>)}
                  <SubmitButton>Save</SubmitButton>
                </form>}
              </ModalButton>
            )}
            {can(me, 'accounts.suspend') && u.id !== me?.user.id && (
              <button className={u.status === 'suspended' ? 'btn-outline btn-sm' : 'btn-ghost btn-sm text-red-700'} onClick={() => { const r = prompt(u.status === 'suspended' ? 'Reason for reactivating' : 'Reason for suspending'); if (r) status(u.id, u.status === 'suspended' ? 'active' : 'suspended', r); }}>{u.status === 'suspended' ? 'Reactivate' : 'Suspend'}</button>
            )}
          </div>
        ) },
      ]} />
  );
}

function Roles() {
  const r = useRoles();
  const { me } = useMe();
  const [save, busy] = useAction((code: string, permissions: string[]) => put(`/admin/roles/${code}/permissions`, { permissions }), { success: 'Permissions saved', onDone: () => r.mutate() });
  return (
    <Async r={r}>{(d) => (
      <div className="grid gap-4 md:grid-cols-2">
        {d.roles.map((role) => (
          <Card key={role.code} title={role.name} actions={<Badge tone={role.isInternal ? 'blue' : 'gold'}>{role.isInternal ? 'Staff' : 'External'}</Badge>}>
            <p className="mb-2 text-xs text-slate-500">{role.description}</p>
            <form onSubmit={(e) => { e.preventDefault(); save(role.code, new FormData(e.currentTarget).getAll('p') as string[]); }}>
              <div className="max-h-56 space-y-0.5 overflow-y-auto">
                {Object.entries(d.catalog).map(([code, desc]) => <label key={code} className="flex items-start gap-2 text-xs"><input type="checkbox" name="p" value={code} defaultChecked={role.permissions.includes(code)} disabled={!can(me, 'roles.manage') || role.code === 'super_admin'} className="mt-0.5" /><span><b>{code}</b> {desc}</span></label>)}
              </div>
              {can(me, 'roles.manage') && role.code !== 'super_admin' && <SubmitButton busy={busy} className="btn-outline btn-sm mt-2">Save</SubmitButton>}
            </form>
          </Card>
        ))}
      </div>
    )}</Async>
  );
}

function Config() {
  const r = useApi<any[]>('/admin/config');
  const h = useApi<any[]>('/admin/config/history');
  const toast = useToast();
  const save = async (key: string, raw: string, original: unknown) => {
    let value: unknown = raw;
    if (typeof original !== 'string') { try { value = JSON.parse(raw); } catch { toast.error(new Error('Enter a valid value (numbers, true/false or JSON).')); return; } }
    try { await put(`/admin/config/${encodeURIComponent(key)}`, { value }); toast.ok('Setting saved'); r.mutate(); h.mutate(); } catch (e) { toast.error(e); }
  };
  return (
    <div className="space-y-4">
      <Alert tone="info">Every change is recorded with the old and new values.</Alert>
      <Async r={r}>{(rows) => (
        <Card padded={false}>
          <Table rows={rows.map((x) => ({ ...x, id: x.key }))} columns={[
            { key: 'key', label: 'Setting', render: (s: any) => <><b className="font-mono text-xs">{s.key}</b><p className="text-xs text-slate-500">{s.description}</p></> },
            { key: 'value', label: 'Value', render: (s: any) => {
              const v = typeof s.value === 'string' ? s.value : JSON.stringify(s.value);
              return v.length > 60 ? <form onSubmit={(e) => { e.preventDefault(); save(s.key, (new FormData(e.currentTarget).get('v') as string), s.value); }} className="space-y-1"><textarea name="v" className="input text-xs" rows={3} defaultValue={v} /><button className="btn-outline btn-sm">Save</button></form>
                : <form onSubmit={(e) => { e.preventDefault(); save(s.key, (new FormData(e.currentTarget).get('v') as string), s.value); }} className="flex gap-1"><input name="v" className="input py-1 text-xs" defaultValue={v} /><button className="btn-outline btn-sm">Save</button></form>;
            } },
            { key: 'updatedAt', label: 'Changed', render: (s: any) => <span className="text-xs">{dateTime(s.updatedAt)}{s.updatedBy && ` by ${s.updatedBy}`}</span> },
          ]} />
        </Card>
      )}</Async>
      <Card title="Change history"><Async r={h}>{(rows) => rows.length === 0 ? <p className="text-sm text-slate-500">No changes yet.</p> : <ul className="space-y-1 text-xs">{rows.map((x: any, i: number) => <li key={i}><b>{x.key}</b>: {JSON.stringify(x.oldValue ?? x.old_value)} → {JSON.stringify(x.newValue ?? x.new_value)} · {dateTime(x.at ?? x.changedAt ?? x.created_at)} by {x.by ?? x.changedBy}</li>)}</ul>}</Async></Card>
    </div>
  );
}

function Reference() {
  const ref = useApi<any>('/public/reference');
  const [gewog, g1] = useAction((b: any) => post('/admin/reference/gewogs', b), { success: 'Added', onDone: () => ref.mutate() });
  const [skill, s1] = useAction((b: any) => post('/admin/reference/skills', b), { success: 'Added', onDone: () => ref.mutate() });
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card title="Add a gewog or thromde">
        <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; const d = new FormData(f); if (await gewog({ dzongkhagId: Number(d.get('dz')), name: d.get('name'), kind: d.get('kind') })) f.reset(); }}>
          <Select name="dz" label="Dzongkhag" required options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
          <Input name="name" label="Name" required /><Select name="kind" label="Kind" options={[{ value: 'gewog', label: 'Gewog' }, { value: 'thromde', label: 'Thromde' }]} />
          <SubmitButton busy={g1}>Add</SubmitButton>
        </form>
        <p className="mt-3 text-xs text-slate-500">{ref.data?.gewogs.length ?? 0} gewogs and thromdes on file.</p>
      </Card>
      <Card title="Skills">
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; const d = new FormData(f); if (await skill({ name: d.get('name'), sectorCode: d.get('sector') || undefined })) f.reset(); }}>
          <Input name="name" label="New skill" required /><Select name="sector" label="Sector" placeholder="Any" options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} /><SubmitButton busy={s1}>Add</SubmitButton>
        </form>
        <div className="mt-3 flex flex-wrap gap-1">{ref.data?.skills.map((s: any) => <Badge key={s.id} tone="gray">{s.name}</Badge>)}</div>
      </Card>
    </div>
  );
}

function Scorecards() {
  const r = useApi<any[]>('/admin/scorecards');
  const ref = useApi<any>('/public/reference');
  const [rows, setRows] = useState<any[]>([{ key: 'attitude', label: 'Attitude', max: 5, weight: 25 }]);
  const [run, busy] = useAction((b: any) => post('/admin/scorecards', b), { success: 'New version published', onDone: () => r.mutate() });
  const total = rows.reduce((a, x) => a + Number(x.weight || 0), 0);
  return (
    <div className="space-y-4">
      <Async r={r}>{(cards) => (
        <div className="grid gap-4 md:grid-cols-2">
          {cards.map((c) => (
            <Card key={c.id} title={`${c.name} (v${c.version})`} actions={c.isActive ? <Badge tone="green">Active</Badge> : <Badge tone="gray">Old</Badge>}>
              <p className="text-xs text-slate-500">{label(c.sectorCode)} · pass mark {c.passThreshold}</p>
              <ul className="mt-2 text-sm">{c.criteria.map((k: any) => <li key={k.key} className="flex justify-between"><span>{k.label}</span><span className="text-slate-500">max {k.max} · weight {k.weight}%</span></li>)}</ul>
              <button className="btn-ghost btn-sm mt-2" onClick={() => setRows(c.criteria.map((k: any) => ({ ...k })))}>Use as starting point</button>
            </Card>
          ))}
        </div>
      )}</Async>
      <Card title="Publish a new scorecard version">
        <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); run({ sectorCode: f.get('sector'), name: f.get('name'), passThreshold: Number(f.get('pass')), criteria: rows.map((x) => ({ ...x, max: Number(x.max), weight: Number(x.weight) })) }); }}>
          <div className="grid gap-3 sm:grid-cols-3"><Select name="sector" label="Sector" options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} /><Input name="name" label="Name" required /><Input name="pass" type="number" label="Pass mark (0-100)" defaultValue={60} required /></div>
          {rows.map((x, i) => (
            <div key={i} className="grid grid-cols-12 gap-2">
              <input className="input col-span-3 py-1 text-sm" placeholder="key" value={x.key} onChange={(e) => setRows((r) => r.map((y, j) => (j === i ? { ...y, key: e.target.value } : y)))} aria-label="Key" />
              <input className="input col-span-5 py-1 text-sm" placeholder="Label" value={x.label} onChange={(e) => setRows((r) => r.map((y, j) => (j === i ? { ...y, label: e.target.value } : y)))} aria-label="Label" />
              <input className="input col-span-1 py-1 text-sm" type="number" value={x.max} onChange={(e) => setRows((r) => r.map((y, j) => (j === i ? { ...y, max: e.target.value } : y)))} aria-label="Max" />
              <input className="input col-span-2 py-1 text-sm" type="number" value={x.weight} onChange={(e) => setRows((r) => r.map((y, j) => (j === i ? { ...y, weight: e.target.value } : y)))} aria-label="Weight" />
              <button type="button" className="btn-ghost btn-sm col-span-1" onClick={() => setRows((r) => r.filter((_, j) => j !== i))} aria-label="Remove">✕</button>
            </div>
          ))}
          <div className="flex items-center gap-3"><button type="button" className="btn-outline btn-sm" onClick={() => setRows((r) => [...r, { key: '', label: '', max: 5, weight: 0 }])}>Add item</button><span className={`text-sm ${total === 100 ? 'text-emerald-700' : 'text-red-700'}`}>Weights total {total}% (must be 100)</span></div>
          <SubmitButton busy={busy} disabled={total !== 100}>Publish version</SubmitButton>
        </form>
      </Card>
    </div>
  );
}

function Jobs() {
  const r = useApi<any[]>('/admin/jobs');
  const toast = useToast();
  const [running, setRunning] = useState<string | null>(null);
  const run = async (name: string) => { setRunning(name); try { const x = await post(`/admin/jobs/${name}/run`); toast.ok(`${label(name)}: ${JSON.stringify(x.result ?? x)}`); } catch (e) { toast.error(e); } finally { setRunning(null); } };
  return (
    <Card padded={false}>
      <Async r={r}>{(rows) => <Table rows={rows.map((j) => ({ ...j, id: j.name }))} columns={[
        { key: 'name', label: 'Job', render: (j: any) => <><b>{label(j.name)}</b><p className="text-xs text-slate-500">{j.description}</p></> },
        { key: 'schedule', label: 'Schedule (Bhutan time)', render: (j: any) => <code className="text-xs">{j.schedule}</code> },
        { key: 'x', label: '', render: (j: any) => <button className="btn-outline btn-sm" disabled={running !== null} onClick={() => run(j.name)}>{running === j.name ? 'Running…' : 'Run now'}</button> },
      ]} />}</Async>
    </Card>
  );
}

function Fees() {
  const r = useApi<any[]>('/admin/fee-rules');
  const ref = useApi<any>('/public/reference');
  const [save, busy] = useAction((id: string | null, b: any) => (id ? put(`/admin/fee-rules/${id}`, b) : post('/admin/fee-rules', b)), { success: 'Fee rule saved', onDone: () => r.mutate() });
  const form = (x: any, close: () => void) => (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const n = (k: string) => (f.get(k) === '' || f.get(k) === null ? null : Number(f.get(k))); const s = (k: string) => (f.get(k) as string) || null;
      if (await save(x?.id ?? null, { name: f.get('name'), sizeTier: s('sizeTier'), sectorCode: s('sectorCode'), roleKeyword: s('roleKeyword'), minMonths: n('minMonths'), maxMonths: n('maxMonths'), placementFee: n('placementFee'), monthlyServiceFee: n('monthlyServiceFee'), adminFeePct: n('adminFeePct'), adminFeeFixed: n('adminFeeFixed') ?? 0, priority: n('priority') ?? 100, active: f.get('active') === 'on' })) close();
    }}>
      <div className="sm:col-span-2"><Input name="name" label="Name" defaultValue={x?.name} required /></div>
      <Select name="sizeTier" label="Host size" defaultValue={x?.sizeTier ?? ''} placeholder="Any" options={['micro', 'small', 'medium', 'large'].map((s) => ({ value: s, label: label(s) }))} />
      <Select name="sectorCode" label="Sector" defaultValue={x?.sectorCode ?? ''} placeholder="Any" options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
      <Input name="roleKeyword" label="Role keyword" defaultValue={x?.roleKeyword ?? ''} />
      <div className="grid grid-cols-2 gap-2"><Input name="minMonths" type="number" label="Min months" defaultValue={x?.minMonths ?? ''} /><Input name="maxMonths" type="number" label="Max months" defaultValue={x?.maxMonths ?? ''} /></div>
      <Input name="placementFee" type="number" label="Placement fee (Nu)" defaultValue={x?.placementFee} required />
      <Input name="monthlyServiceFee" type="number" label="Monthly service fee (Nu)" defaultValue={x?.monthlyServiceFee} required />
      <Input name="adminFeePct" type="number" step="0.01" label="Admin fee % of wages" defaultValue={x?.adminFeePct} required />
      <Input name="adminFeeFixed" type="number" label="Fixed admin fee (Nu)" defaultValue={x?.adminFeeFixed ?? 0} />
      <Input name="priority" type="number" label="Priority (lower wins)" defaultValue={x?.priority ?? 100} />
      <Checkbox name="active" label="Active" defaultChecked={x?.active ?? true} />
      <div className="sm:col-span-2"><SubmitButton busy={busy}>Save</SubmitButton></div>
    </form>
  );
  return (
    <Card title="Fee rules" actions={<ModalButton label="New rule" className="btn-gold btn-sm" title="New fee rule" wide>{(close) => form(null, close)}</ModalButton>} padded={false}>
      <Async r={r}>{(rows) => <Table rows={rows} columns={[
        { key: 'name', label: 'Rule', render: (x: any) => <><b>{x.name}</b>{!x.active && <Badge tone="gray">Inactive</Badge>}</> },
        { key: 'match', label: 'Applies to', render: (x: any) => [x.sizeTier && label(x.sizeTier), x.sectorCode && label(x.sectorCode), x.roleKeyword && `“${x.roleKeyword}”`, (x.minMonths || x.maxMonths) && `${x.minMonths ?? 0}-${x.maxMonths ?? '∞'} months`].filter(Boolean).join(', ') || 'Everyone' },
        { key: 'placementFee', label: 'Placement', render: (x: any) => money(x.placementFee) }, { key: 'monthlyServiceFee', label: 'Monthly', render: (x: any) => money(x.monthlyServiceFee) },
        { key: 'adminFeePct', label: 'Admin', render: (x: any) => `${x.adminFeePct}%${Number(x.adminFeeFixed) ? ` + ${money(x.adminFeeFixed)}` : ''}` }, { key: 'priority', label: 'Priority' },
        { key: 'x', label: '', render: (x: any) => <ModalButton label="Edit" title={`Edit ${x.name}`} wide>{(close) => form(x, close)}</ModalButton> },
      ]} />}</Async>
    </Card>
  );
}

function Templates() {
  const r = useApi<any[]>('/admin/templates');
  const [save, busy] = useAction((b: any) => put('/admin/templates', b), { success: 'Template saved', onDone: () => r.mutate() });
  return (
    <Card padded={false}>
      <Async r={r}>{(rows) => <Table rows={rows.map((t) => ({ ...t, id: `${t.code}-${t.channel}-${t.language}` }))} columns={[
        { key: 'code', label: 'Message', render: (t: any) => <><b>{label(t.code)}</b><p className="text-xs text-slate-500">{t.channel.toUpperCase()} · {t.language === 'dz' ? 'Dzongkha' : 'English'}</p></> },
        { key: 'body', label: 'Text', render: (t: any) => <span className="text-xs">{t.subject && <b>{t.subject}: </b>}{t.body}</span> },
        { key: 'x', label: '', render: (t: any) => (
          <ModalButton label="Edit" title={`${label(t.code)} (${t.channel}, ${t.language})`} wide>
            {(close) => <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await save({ code: t.code, channel: t.channel, language: t.language, subject: (f.get('subject') as string) || null, body: f.get('body') })) close(); }}>
              {t.channel === 'email' && <Input name="subject" label="Subject" defaultValue={t.subject ?? ''} />}
              <Textarea name="body" label="Text" defaultValue={t.body} rows={5} required hint="Use {{name}} style placeholders as in the original. SMS should stay under 160 characters." />
              <SubmitButton busy={busy}>Save</SubmitButton>
            </form>}
          </ModalButton>
        ) },
      ]} />}</Async>
    </Card>
  );
}

function Audit() {
  const toast = useToast();
  const check = async () => { try { const x = await api('/admin/audit/verify'); x.ok ? toast.ok(`Audit chain intact: ${x.checked} entries checked`) : toast.error(new Error(`Audit chain broken at entry ${x.brokenAt ?? '?'}`)); } catch (e) { toast.error(e); } };
  return (
    <ListView path="/admin/audit" pageSize={50} searchPlaceholder="Action, entity or IP" toolbar={<button className="btn-outline btn-sm" onClick={check}>Verify integrity</button>}
      columns={[
        { key: 'at', label: 'When', render: (a: any) => <span className="text-xs whitespace-nowrap">{dateTime(a.at)}</span> },
        { key: 'actor', label: 'Who', render: (a: any) => a.actor ?? 'System' },
        { key: 'action', label: 'Action', render: (a: any) => <code className="text-xs">{a.action}</code> },
        { key: 'entity', label: 'Record', render: (a: any) => <span className="text-xs">{a.entityType} {a.entityId?.slice?.(0, 8)}</span> },
        { key: 'details', label: 'Details', render: (a: any) => <span className="text-xs text-slate-600">{a.details ? JSON.stringify(a.details).slice(0, 120) : ''}</span> },
        { key: 'ip', label: 'IP', render: (a: any) => <span className="text-xs">{a.ip}</span> },
      ]} />
  );
}
