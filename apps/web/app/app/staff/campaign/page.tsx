'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Async, Badge, Card, Input, ModalButton, PageHeader, Select, SubmitButton, Table, Tabs, Textarea, useAction } from '@/components/ui';
import { post, put, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { date, dateTime, label, money } from '@/lib/format';

/** Vocational video campaign: pipeline, careers, training, Q&A moderation and analytics (FR-VID). */
export default function Campaign() {
  const { me } = useMe();
  const [tab, setTab] = useState(can(me, 'videos.manage', 'videos.review') ? 'videos' : 'questions');
  const tabs = [
    ...(can(me, 'videos.manage', 'videos.review') ? [{ id: 'videos', label: 'Videos' }] : []),
    ...(can(me, 'videos.manage') ? [{ id: 'careers', label: 'Career pages' }, { id: 'training', label: 'Training' }] : []),
    ...(can(me, 'qa.moderate') ? [{ id: 'questions', label: 'Questions' }] : []),
    ...(can(me, 'videos.manage', 'reports.view') ? [{ id: 'analytics', label: 'Analytics' }] : []),
  ];
  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader title="Career campaign" subtitle="Short videos that show young Bhutanese what real jobs look like." />
      <Tabs value={tab} onChange={setTab} tabs={tabs} />
      {tab === 'videos' && <Videos />}
      {tab === 'careers' && <Careers />}
      {tab === 'training' && <Training />}
      {tab === 'questions' && <Questions />}
      {tab === 'analytics' && <Analytics />}
    </div>
  );
}

function Videos() {
  const r = useApi<any[]>('/campaign/admin/videos');
  const careers = useApi<any[]>('/campaign/careers');
  const tags = useApi<any[]>('/campaign/tags');
  const { me } = useMe();
  const router = useRouter();
  const [create, busy] = useAction((b: any) => post('/campaign/admin/videos', b), { success: 'Video created at Idea stage', onDone: (x: any) => router.push(`/app/staff/campaign/${x.id}`) });
  return (
    <Card padded={false} title={<span className="px-1">Pipeline</span>} actions={can(me, 'videos.manage') && (
      <ModalButton label="New video" className="btn-gold btn-sm" title="New video">
        {() => (
          <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); create({ careerId: f.get('careerId'), title: f.get('title'), description: f.get('description') || null, language: f.get('language'), tags: f.getAll('tags') }); }}>
            <Select name="careerId" label="Career" required options={careers.data?.map((c) => ({ value: c.id, label: c.title })) ?? []} />
            <Input name="title" label="Title" required minLength={2} maxLength={140} />
            <Textarea name="description" label="Description" />
            <Select name="language" label="Language" options={[{ value: 'dz', label: 'Dzongkha' }, { value: 'en', label: 'English' }, { value: 'mixed', label: 'Mixed' }]} />
            <fieldset><legend className="label">Tags</legend>{tags.data?.map((t) => <label key={t.slug} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" name="tags" value={t.slug} />{t.name}</label>)}</fieldset>
            <SubmitButton busy={busy}>Create</SubmitButton>
          </form>
        )}
      </ModalButton>
    )}>
      <Async r={r}>{(rows) => <Table rows={rows} rowHref={(v) => `/app/staff/campaign/${v.id}`} empty="No videos yet." columns={[
        { key: 'title', label: 'Title', render: (v: any) => <><b>{v.title}</b><p className="text-xs text-slate-500">{v.career} · {label(v.kind)}</p></> },
        { key: 'status', label: 'Stage', render: (v: any) => <Badge status={v.status} /> },
        { key: 'processingStatus', label: 'File', render: (v: any) => v.processingStatus ? <Badge status={v.processingStatus} /> : '—' },
        { key: 'consents', label: 'Consents', render: (v: any) => `${v.consentsConfirmed ?? 0}/${v.featuredPeople ?? v.people ?? '?'}` },
        { key: 'durationSeconds', label: 'Length', render: (v: any) => v.durationSeconds ? `${Math.round(v.durationSeconds)}s` : '—' },
        { key: 'publishedAt', label: 'Published', render: (v: any) => v.publishedAt ? date(v.publishedAt) : v.scheduledAt ? `Scheduled ${dateTime(v.scheduledAt)}` : '—' },
        { key: 'updatedAt', label: 'Updated', render: (v: any) => date(v.updatedAt) },
      ]} />}</Async>
    </Card>
  );
}

function CareerForm({ c, sectors, onDone }: { c?: any; sectors: any[]; onDone: () => void }) {
  const [run, busy] = useAction((b: any) => (c ? put(`/campaign/careers/${c.id}`, b) : post('/campaign/careers', b)), { success: 'Career page saved', onDone });
  const list = (v: FormDataEntryValue | null) => String(v ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const n = (v: FormDataEntryValue | null) => (v ? Number(v) : null);
  return (
    <form className="grid gap-3 sm:grid-cols-2" onSubmit={async (e) => {
      e.preventDefault(); const f = new FormData(e.currentTarget); const s = (k: string) => (f.get(k) as string) || null;
      await run({ slug: f.get('slug'), title: f.get('title'), sectorCode: s('sectorCode'), summary: s('summary'), dailyTasks: s('dailyTasks'), skills: list(f.get('skills')), trainingRoutes: s('trainingRoutes'), wageMin: n(f.get('wageMin')), wageMax: n(f.get('wageMax')), growthPath: s('growthPath'), roleKeywords: list(f.get('roleKeywords')) });
    }}>
      <Input name="title" label="Title" defaultValue={c?.title} required />
      <Input name="slug" label="Web address" defaultValue={c?.slug} pattern="[a-z0-9-]+" required hint="Lowercase letters, numbers and dashes" />
      <Select name="sectorCode" label="Sector" defaultValue={c?.sectorCode ?? ''} placeholder="None" options={sectors.map((s) => ({ value: s.code, label: s.name }))} />
      <div className="grid grid-cols-2 gap-2"><Input name="wageMin" type="number" label="Wage from" defaultValue={c?.wageMin ?? ''} /><Input name="wageMax" type="number" label="Wage to" defaultValue={c?.wageMax ?? ''} /></div>
      <div className="sm:col-span-2"><Textarea name="summary" label="Summary" defaultValue={c?.summary ?? ''} rows={2} /></div>
      <Textarea name="dailyTasks" label="A typical day" defaultValue={c?.dailyTasks ?? ''} />
      <Textarea name="growthPath" label="Where it leads" defaultValue={c?.growthPath ?? ''} />
      <Textarea name="trainingRoutes" label="How to train" defaultValue={c?.trainingRoutes ?? ''} />
      <Input name="skills" label="Skills (comma separated)" defaultValue={c?.skills?.join(', ') ?? ''} />
      <Input name="roleKeywords" label="Vacancy title keywords (comma separated)" defaultValue={c?.roleKeywords?.join(', ') ?? ''} hint="Links open vacancies to this career." />
      <div className="sm:col-span-2"><SubmitButton busy={busy}>Save</SubmitButton></div>
    </form>
  );
}

function Careers() {
  const r = useApi<any[]>('/campaign/careers');
  const ref = useApi<any>('/public/reference');
  return (
    <Card title="Career pages" actions={<ModalButton label="New career" className="btn-gold btn-sm" title="New career page" wide>{(close) => <CareerForm sectors={ref.data?.sectors ?? []} onDone={() => { close(); r.mutate(); }} />}</ModalButton>}>
      <Async r={r}>{(rows) => <Table rows={rows} columns={[
        { key: 'title', label: 'Career', render: (c: any) => <><b>{c.title}</b><p className="text-xs text-slate-500">/careers/{c.slug}</p></> }, { key: 'sectorCode', label: 'Sector', render: (c: any) => label(c.sectorCode) },
        { key: 'wage', label: 'Wage', render: (c: any) => `${money(c.wageMin)} to ${money(c.wageMax)}` }, { key: 'videos', label: 'Videos' },
        { key: 'x', label: '', render: (c: any) => <CareerEdit c={c} sectors={ref.data?.sectors ?? []} onDone={() => r.mutate()} /> },
      ]} />}</Async>
    </Card>
  );
}

function CareerEdit({ c, sectors, onDone }: { c: any; sectors: any[]; onDone: () => void }) {
  const full = useApi<any>(`/campaign/careers/${c.slug}`);
  return <ModalButton label="Edit" title={`Edit ${c.title}`} wide>{(close) => full.data ? <CareerForm c={{ ...full.data, sectorCode: c.sectorCode }} sectors={sectors} onDone={() => { close(); onDone(); }} /> : <p>Loading…</p>}</ModalButton>;
}

function Training() {
  const r = useApi<any[]>('/campaign/training');
  const careers = useApi<any[]>('/campaign/careers');
  const ref = useApi<any>('/public/reference');
  const [run, busy] = useAction((b: any) => post('/campaign/training', b), { success: 'Training programme added', onDone: () => r.mutate() });
  return (
    <Card title="Training programmes" actions={
      <ModalButton label="Add programme" className="btn-gold btn-sm" title="Add a training programme">
        {(close) => (
          <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const s = (k: string) => (f.get(k) as string) || null; if (await run({ title: f.get('title'), provider: f.get('provider'), careerId: s('careerId'), sectorCode: s('sectorCode'), dzongkhagId: s('dzongkhagId') ? Number(f.get('dzongkhagId')) : null, description: s('description'), startDate: s('startDate'), link: s('link') })) close(); }}>
            <Input name="title" label="Title" required /><Input name="provider" label="Provider" required />
            <Select name="careerId" label="Career" placeholder="None" options={careers.data?.map((c) => ({ value: c.id, label: c.title })) ?? []} />
            <Select name="sectorCode" label="Sector" placeholder="None" options={ref.data?.sectors.map((s: any) => ({ value: s.code, label: s.name })) ?? []} />
            <Select name="dzongkhagId" label="Dzongkhag" placeholder="Anywhere" options={ref.data?.dzongkhags.map((d: any) => ({ value: d.id, label: d.name })) ?? []} />
            <Input name="startDate" type="date" label="Starts" /><Input name="link" type="url" label="Link" /><Textarea name="description" label="Description" />
            <SubmitButton busy={busy}>Add</SubmitButton>
          </form>
        )}
      </ModalButton>
    }>
      <Async r={r}>{(rows) => <Table rows={rows} empty="No programmes." columns={[{ key: 'title', label: 'Programme', render: (t: any) => <b>{t.title}</b> }, { key: 'provider', label: 'Provider' }, { key: 'career', label: 'Career' }, { key: 'startDate', label: 'Starts', render: (t: any) => date(t.startDate) }]} />}</Async>
    </Card>
  );
}

function Questions() {
  const r = useApi<any[]>('/campaign/admin/questions');
  const [decide] = useAction((id: string, b: any) => post(`/campaign/admin/questions/${id}`, b), { success: 'Saved', onDone: () => r.mutate() });
  return (
    <Async r={r}>{(rows) => rows.length === 0 ? <p className="text-sm text-slate-500">No questions waiting.</p> : (
      <div className="space-y-3">
        {rows.map((q) => (
          <Card key={q.id}>
            <p className="text-sm"><b>{q.asker ?? 'Viewer'}</b> on <i>{q.video}</i> · {dateTime(q.createdAt)} <Badge status={q.status} />{q.profanityFlag && <Badge tone="red">Language flag</Badge>}{q.reportCount > 0 && <Badge tone="amber">{q.reportCount} report(s)</Badge>}</p>
            <p className="mt-1">{q.body}</p>
            <form className="mt-3 space-y-2" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); decide(q.id, { decision: (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value'), answer: (f.get('answer') as string) || undefined }); }}>
              <Textarea name="answer" label="Answer (optional, shown publicly)" defaultValue={q.answer ?? ''} rows={2} />
              <div className="flex gap-2"><SubmitButton value="approved" className="btn-primary btn-sm">Approve</SubmitButton><SubmitButton value="rejected" className="btn-ghost btn-sm">Reject</SubmitButton></div>
            </form>
          </Card>
        ))}
      </div>
    )}</Async>
  );
}

function Analytics() {
  const r = useApi<any>('/campaign/admin/analytics');
  return (
    <Async r={r}>{(a) => (
      <div className="space-y-4">
        <Card title="From video to job">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[['videoViews', 'Viewers'], ['careerVisits', 'Career visits'], ['registrations', 'Registered'], ['applications', 'Applied'], ['placements', 'Placed']].map(([k, l]) => (
              <div key={k} className="rounded-lg bg-cream p-3 text-center"><p className="text-2xl font-bold text-navy-950">{a.funnel[k]}</p><p className="text-xs text-slate-600">{l}</p></div>
            ))}
          </div>
        </Card>
        <Card title="Per video" padded={false}><Table rows={a.perVideo} empty="No views yet." columns={Object.keys(a.perVideo[0] ?? { title: 1 }).filter((k) => k !== 'id').map((k) => ({ key: k, label: label(k) }))} /></Card>
        <div className="grid gap-4 md:grid-cols-2">
          <Card title="Careers" padded={false}><Table rows={a.careers.map((c: any, i: number) => ({ ...c, id: i }))} columns={[{ key: 'title', label: 'Career' }, { key: 'views', label: 'Views' }, { key: 'visits', label: 'Visits' }, { key: 'registrations', label: 'Registrations' }]} /></Card>
          <Card title={`Reach (groups under ${a.reachMinimumGroup} hidden for privacy)`} padded={false}><Table rows={a.reach.map((x: any, i: number) => ({ ...x, id: i }))} empty="Not enough data yet." columns={Object.keys(a.reach[0] ?? { dzongkhag: 1 }).map((k) => ({ key: k, label: label(k) }))} /></Card>
        </div>
      </div>
    )}</Async>
  );
}
