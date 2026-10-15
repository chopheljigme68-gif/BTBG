'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { JobCard } from '@/components/job-card';
import { Alert, Async, Textarea, SubmitButton, formData, useAction, useToast } from '@/components/ui';
import { del, post, useApi } from '@/lib/api';
import { relative, viewerRef } from '@/lib/format';

const QUALITY_LABEL: Record<string, string> = { '240': 'Data saver (240p)', '360': 'Standard (360p)', '720': 'HD (720p)' };

export default function VideoPage() {
  const { id } = useParams<{ id: string }>();
  const r = useApi<any>(`/campaign/videos/${id}`);
  const me = useApi<any>('/auth/me', { shouldRetryOnError: false });
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const [quality, setQuality] = useState<string | null>(null);
  const viewed = useRef(false);
  const lastBeat = useRef(0);

  const event = (type: string, extra: object = {}) => post('/campaign/events', { videoId: id, viewerRef: viewerRef(), type, ...extra }).catch(() => undefined);

  useEffect(() => {
    if (!r.data || quality) return;
    // Default to the lightest rendition on slow or metered connections.
    const conn = (navigator as any).connection;
    const slow = conn?.saveData || ['slow-2g', '2g', '3g'].includes(conn?.effectiveType);
    const qs: string[] = r.data.qualities;
    setQuality(slow ? qs[0] ?? '240' : qs.includes('360') ? '360' : qs[0] ?? '360');
  }, [r.data, quality]);

  const changeQuality = (q: string) => {
    const v = video.current;
    const t = v?.currentTime ?? 0;
    const playing = v && !v.paused;
    setQuality(q);
    setTimeout(() => {
      if (!video.current) return;
      video.current.currentTime = t;
      if (playing) video.current.play().catch(() => undefined);
    }, 50);
  };

  const [save] = useAction(async (saved: boolean) => (saved ? del(`/campaign/videos/${id}/save`) : post(`/campaign/videos/${id}/save`)), { onDone: () => r.mutate() });
  const [ask, asking] = useAction((body: any) => post(`/campaign/videos/${id}/questions`, body), { success: (x: any) => x.message });
  const report = (qid: string) => post(`/campaign/questions/${qid}/report`, { viewerRef: viewerRef() }).then(() => toast.ok('Thanks. A moderator will check it.'));

  const share = async (v: any) => {
    event('share');
    if (navigator.share) await navigator.share({ title: v.title, url: v.shareUrl }).catch(() => undefined);
    else { await navigator.clipboard.writeText(v.shareUrl); toast.ok('Link copied'); }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Async r={r}>
        {(v) => (
          <div className="grid gap-8 lg:grid-cols-[1fr_340px]">
            <div className="space-y-5">
              {v.status !== 'published' && <Alert tone="warn">Preview: this video is not published yet ({v.status}).</Alert>}
              <div className="overflow-hidden rounded-2xl bg-black">
                {quality && (
                  <video
                    ref={video} key={quality} controls playsInline preload="metadata" className="aspect-video w-full"
                    poster={v.hasThumbnail ? `/api/campaign/videos/${id}/thumbnail` : undefined}
                    src={`/api/campaign/videos/${id}/stream?q=${quality}`}
                    onPlay={() => { if (!viewed.current) { viewed.current = true; event('view'); } }}
                    onTimeUpdate={(e) => {
                      const t = Math.floor(e.currentTarget.currentTime);
                      if (t - lastBeat.current >= 15) { lastBeat.current = t; event('progress', { watchSeconds: t }); }
                    }}
                    onEnded={(e) => event('complete', { watchSeconds: Math.floor(e.currentTarget.duration) })}
                  >
                    {v.subtitleLanguages.map((l: string) => (
                      <track key={l} kind="subtitles" srcLang={l} label={l === 'dz' ? 'རྫོང་ཁ Dzongkha' : 'English'} src={`/api/campaign/videos/${id}/subtitles/${l}`} default={l === 'dz'} />
                    ))}
                  </video>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-2xl font-bold text-navy-950">{v.title}</h1>
                  <p className="text-sm text-slate-600"><Link href={`/careers/${v.careerSlug}`} className="link">{v.careerTitle}</Link> · {v.views} view(s)</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {v.qualities.length > 1 && (
                    <select className="input w-auto py-1.5 text-sm" value={quality ?? ''} onChange={(e) => changeQuality(e.target.value)} aria-label="Video quality">
                      {v.qualities.map((q: string) => <option key={q} value={q}>{QUALITY_LABEL[q] ?? `${q}p`}</option>)}
                    </select>
                  )}
                  {me.data && <button className="btn-outline btn-sm" onClick={() => save(v.saved)}>{v.saved ? '★ Saved' : '☆ Save'}</button>}
                  <button className="btn-outline btn-sm" onClick={() => share(v)}>Share</button>
                </div>
              </div>
              {v.description && <p className="whitespace-pre-line text-slate-700">{v.description}</p>}

              <section className="card p-5">
                <h2 className="mb-3 font-semibold text-navy-950">Questions and answers</h2>
                {v.questions.length === 0 && <p className="text-sm text-slate-500">No questions yet. Ask the first one.</p>}
                <ul className="space-y-4">
                  {v.questions.map((q: any) => (
                    <li key={q.id} className="border-b border-navy-50 pb-3 last:border-0">
                      <p className="text-sm"><b>{q.asker}</b> <span className="text-xs text-slate-500">{relative(q.createdAt)}</span></p>
                      <p className="text-slate-800">{q.body}</p>
                      {q.answer && <p className="mt-1 rounded-lg bg-cream p-2 text-sm"><b className="text-navy-800">BTBG:</b> {q.answer}</p>}
                      <button className="mt-1 text-xs text-slate-500 hover:underline" onClick={() => report(q.id)}>Report</button>
                    </li>
                  ))}
                </ul>
                {me.data ? (
                  <form className="mt-4 space-y-2" onSubmit={async (e) => { e.preventDefault(); const f = e.currentTarget; if (await ask(formData(f))) f.reset(); }}>
                    <Textarea name="body" label="Ask a question" required minLength={5} maxLength={500} hint="Questions appear after a moderator checks them." />
                    <SubmitButton busy={asking}>Post question</SubmitButton>
                  </form>
                ) : <p className="mt-4 text-sm"><Link href={`/login?next=/careers/videos/${id}`} className="link">Sign in</Link> to ask a question.</p>}
              </section>
            </div>
            <aside className="space-y-4">
              <div className="rounded-2xl bg-navy-950 p-5 text-white">
                <p className="font-semibold">Like what you see?</p>
                <p className="mt-1 text-sm text-navy-200">Create a free profile and BTBG will help you start.</p>
                <a href={v.registerUrl} className="btn-gold mt-3 w-full" onClick={() => event('register_click')}>Start with BTBG</a>
              </div>
              {v.vacancies.length > 0 && (
                <div>
                  <h2 className="mb-2 font-semibold text-navy-950">Open jobs</h2>
                  <div className="space-y-3">{v.vacancies.map((j: any) => <JobCard key={j.id} v={j} />)}</div>
                </div>
              )}
              {v.training.length > 0 && (
                <div className="card p-4">
                  <h2 className="mb-2 font-semibold text-navy-950">Training</h2>
                  <ul className="space-y-2 text-sm">{v.training.map((t: any) => <li key={t.id}><b>{t.title}</b><br /><span className="text-slate-600">{t.provider}</span></li>)}</ul>
                </div>
              )}
            </aside>
          </div>
        )}
      </Async>
    </div>
  );
}
