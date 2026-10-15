'use client';
import { use, useState } from 'react';
import { Alert, Async, Badge, Card, Checkbox, FilePicker, Input, KeyValue, ModalButton, PageHeader, Select, SubmitButton, Textarea, useAction, useToast } from '@/components/ui';
import { fileUrl, post, put, upload, useApi } from '@/lib/api';
import { can, useMe } from '@/lib/auth';
import { dateTime, label } from '@/lib/format';

const PIPELINE = ['idea', 'filming', 'editing', 'review', 'consent_confirmed', 'scheduled', 'published', 'archived'];

/** One video through the pipeline: file, subtitles, featured people and consent, publishing (FR-VID-10..23). */
export default function VideoAdmin({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const r = useApi<any>(`/campaign/admin/videos/${id}`, { refreshInterval: (d: any) => (d?.processing_status === 'processing' ? 4000 : 0) } as any);
  const careers = useApi<any[]>('/campaign/careers');
  const tags = useApi<any[]>('/campaign/tags');
  const { me } = useMe();
  const toast = useToast();
  const [up, setUp] = useState(false);
  const refresh = () => r.mutate();
  const doUpload = async (path: string, file: File, body?: any, msg = 'Uploaded') => { setUp(true); try { await upload(path, file, body); toast.ok(msg); refresh(); } catch (e) { toast.error(e); } finally { setUp(false); } };
  const [status, moving] = useAction((b: any) => post(`/campaign/admin/videos/${id}/status`, b), { success: 'Stage updated', onDone: refresh });
  const [save, saving] = useAction((b: any) => put(`/campaign/admin/videos/${id}`, b), { success: 'Saved', onDone: refresh });
  const [addPerson, adding] = useAction((b: any) => post(`/campaign/admin/videos/${id}/people`, b), { success: 'Added', onDone: refresh });
  const [withdraw] = useAction((pid: string, reason: string) => post(`/campaign/admin/people/${pid}/withdraw`, { reason }), { success: 'Withdrawal recorded; the video is unpublished if live', onDone: refresh });
  const manage = can(me, 'videos.manage');
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <Async r={r}>
        {(v) => {
          const idx = PIPELINE.indexOf(v.status);
          return (
            <>
              <PageHeader title={v.title} back={{ href: '/app/staff/campaign', label: 'Campaign' }} subtitle={<>{v.career_title} · <Badge status={v.status} /></>}
                actions={manage && <ModalButton label="Edit details" title="Edit video">{(close) => (
                  <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await save({ careerId: f.get('careerId'), title: f.get('title'), description: (f.get('description') as string) || null, language: f.get('language'), tags: f.getAll('tags') })) close(); }}>
                    <Select name="careerId" label="Career" defaultValue={v.career_id} options={careers.data?.map((c) => ({ value: c.id, label: c.title })) ?? []} />
                    <Input name="title" label="Title" defaultValue={v.title} required />
                    <Textarea name="description" label="Description" defaultValue={v.description ?? ''} />
                    <Select name="language" label="Language" defaultValue={v.language} options={[{ value: 'dz', label: 'Dzongkha' }, { value: 'en', label: 'English' }, { value: 'mixed', label: 'Mixed' }]} />
                    <fieldset><legend className="label">Tags</legend>{tags.data?.map((t) => <label key={t.slug} className="mr-3 inline-flex items-center gap-1 text-sm"><input type="checkbox" name="tags" value={t.slug} defaultChecked={v.tags.includes(t.slug)} />{t.name}</label>)}</fieldset>
                    <SubmitButton busy={saving}>Save</SubmitButton>
                  </form>
                )}</ModalButton>} />
              <ol className="flex flex-wrap gap-1 text-xs">{PIPELINE.map((s, i) => <li key={s} className={`rounded-full px-2.5 py-1 ${i < idx ? 'bg-emerald-50 text-emerald-800' : i === idx ? 'bg-navy-900 text-white' : 'bg-slate-100 text-slate-500'}`}>{label(s)}</li>)}</ol>
              {v.review_comment && <Alert tone="warn" title="Reviewer comment">{v.review_comment}</Alert>}
              {v.unpublished_reason && <Alert tone="error" title="Unpublished">{v.unpublished_reason}</Alert>}
              <div className="grid gap-4 lg:grid-cols-3">
                <div className="space-y-4 lg:col-span-2">
                  <Card title="Video file" actions={manage && <FilePicker label={v.original_path ? 'Replace file' : 'Upload edited video'} accept="video/*" busy={up} onFile={(f) => doUpload(`/campaign/admin/videos/${id}/file`, f, undefined, 'Uploaded; processing started')} />}>
                    {!v.ffmpeg && <Alert tone="warn">FFmpeg is not installed on the server, so the original file is served without 240p/360p versions or a generated thumbnail.</Alert>}
                    {v.processing_status === 'processing' && <Alert tone="info">Processing the video into 240p, 360p and 720p…</Alert>}
                    {v.processing_status === 'failed' && <Alert tone="error">{v.processing_error}</Alert>}
                    {v.original_path && v.processing_status === 'ready' && <video controls preload="metadata" className="mt-2 w-full rounded-lg bg-black" poster={fileUrl(`/campaign/videos/${id}/thumbnail`)} src={fileUrl(`/campaign/videos/${id}/stream?q=360`)}>{Object.keys(v.subtitles ?? {}).map((l) => <track key={l} kind="subtitles" srcLang={l} label={l === 'dz' ? 'Dzongkha' : 'English'} src={fileUrl(`/campaign/videos/${id}/subtitles/${l}`)} />)}</video>}
                    <KeyValue items={[['Length', v.duration_seconds ? `${Math.round(v.duration_seconds)} s` : '—'], ['Versions', Object.keys(v.renditions ?? {}).join(', ') || '—'], ['Subtitles', Object.keys(v.subtitles ?? {}).map((l) => l.toUpperCase()).join(', ') || 'None']]} />
                    {manage && (
                      <div className="mt-3 flex gap-2">
                        <FilePicker label="English subtitles (.vtt)" accept=".vtt,text/vtt" busy={up} onFile={(f) => doUpload(`/campaign/admin/videos/${id}/subtitles`, f, { language: 'en' })} />
                        <FilePicker label="Dzongkha subtitles (.vtt)" accept=".vtt,text/vtt" busy={up} onFile={(f) => doUpload(`/campaign/admin/videos/${id}/subtitles`, f, { language: 'dz' })} />
                      </div>
                    )}
                  </Card>
                  <Card title="People in the video" actions={manage && (
                    <ModalButton label="Add person" title="Add a featured person">{(close) => (
                      <form className="space-y-3" onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await addPerson({ name: f.get('name'), roleTitle: (f.get('roleTitle') as string) || undefined, isMinor: f.get('isMinor') === 'on', guardianName: (f.get('guardianName') as string) || undefined })) close(); }}>
                        <Input name="name" label="Name" required /><Input name="roleTitle" label="Role" /><Checkbox name="isMinor" label="Under 18 (needs guardian consent too)" /><Input name="guardianName" label="Guardian name" />
                        <SubmitButton busy={adding}>Add</SubmitButton>
                      </form>
                    )}</ModalButton>
                  )}>
                    <p className="mb-2 text-xs text-slate-500">Every person needs a signed consent form before the video can pass review. Minors also need a guardian form.</p>
                    {v.people.length === 0 ? <p className="text-sm text-slate-500">Nobody added.</p> : (
                      <ul className="divide-y divide-navy-50 text-sm">
                        {v.people.map((p: any) => (
                          <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                            <span><b>{p.name}</b>{p.roleTitle && ` · ${p.roleTitle}`} {p.isMinor && <Badge tone="amber">Minor{p.guardianName && `, guardian ${p.guardianName}`}</Badge>} <Badge status={p.consentStatus} />{p.withdrawnAt && <span className="text-xs text-red-700"> withdrew {dateTime(p.withdrawnAt)}: {p.withdrawalReason}</span>}</span>
                            {manage && !p.withdrawnAt && (
                              <span className="flex flex-wrap gap-1">
                                {!p.hasConsent && <FilePicker label="Consent form" accept=".pdf,image/*" busy={up} onFile={(f) => doUpload(`/campaign/admin/people/${p.id}/consent`, f, { kind: 'person' })} />}
                                {p.isMinor && !p.hasGuardianConsent && <FilePicker label="Guardian form" accept=".pdf,image/*" busy={up} onFile={(f) => doUpload(`/campaign/admin/people/${p.id}/consent`, f, { kind: 'guardian' })} />}
                                {p.consentStatus === 'confirmed' && <button className="btn-ghost btn-sm text-red-700" onClick={() => { const r = prompt('Reason for withdrawal'); if (r) withdraw(p.id, r); }}>Withdraw</button>}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </Card>
                </div>
                <Card title="Move through the pipeline">
                  <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); const at = f.get('scheduledAt') as string; status({ status: f.get('status'), comment: (f.get('comment') as string) || undefined, scheduledAt: at ? new Date(at).toISOString() : undefined }); }}>
                    <Select name="status" label="Move to" defaultValue={PIPELINE[Math.min(idx + 1, PIPELINE.length - 1)]} options={PIPELINE.map((s) => ({ value: s, label: label(s) }))} />
                    <Input name="scheduledAt" type="datetime-local" label="Publish at (for Scheduled)" />
                    <Textarea name="comment" label="Comment" rows={2} />
                    <SubmitButton busy={moving}>Update stage</SubmitButton>
                  </form>
                  <p className="mt-3 text-xs text-slate-500">Review needs a processed file and both subtitle tracks. Consent confirmed needs every person&apos;s form. Only a reviewer can publish.</p>
                  {v.published_at && <p className="mt-2 text-sm">Published {dateTime(v.published_at)}</p>}
                </Card>
              </div>
            </>
          );
        }}
      </Async>
    </div>
  );
}
