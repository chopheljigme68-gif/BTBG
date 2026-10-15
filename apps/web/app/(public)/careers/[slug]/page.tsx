'use client';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect } from 'react';
import { JobCard } from '@/components/job-card';
import { Async, Badge } from '@/components/ui';
import { VideoCard } from '@/components/video-card';
import { post, useApi } from '@/lib/api';
import { date, money, viewerRef } from '@/lib/format';

export default function CareerPage() {
  const { slug } = useParams<{ slug: string }>();
  const r = useApi<any>(`/campaign/careers/${slug}`);
  useEffect(() => {
    post('/campaign/events', { careerSlug: slug, viewerRef: viewerRef(), type: 'career_visit' }).catch(() => undefined);
  }, [slug]);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <Link href="/careers" className="text-sm text-navy-700 hover:underline">← All careers</Link>
      <Async r={r}>
        {(c) => (
          <div className="mt-3 space-y-8">
            <header className="rounded-3xl bg-navy-950 p-8 text-white">
              <p className="text-sm font-semibold tracking-wide text-gold-300 uppercase">{c.sector}</p>
              <h1 className="mt-1 text-4xl font-extrabold">{c.title}</h1>
              <p className="mt-3 max-w-2xl text-lg text-navy-100">{c.summary}</p>
              {c.wageMin && <p className="mt-4 inline-block rounded-xl bg-white/10 px-4 py-2 text-gold-300">Typical pay: <b>{money(c.wageMin)} to {money(c.wageMax)}</b> a month</p>}
              <div className="mt-5"><Link href={`/register?career=${c.slug}`} className="btn-gold" onClick={() => post('/campaign/events', { careerSlug: c.slug, viewerRef: viewerRef(), type: 'register_click' }).catch(() => undefined)}>Start this career with BTBG</Link></div>
            </header>
            {c.videos.length > 0 && (
              <section>
                <h2 className="mb-3 text-xl font-bold text-navy-950">Watch</h2>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{c.videos.map((v: any) => <VideoCard key={v.id} v={v} />)}</div>
              </section>
            )}
            <section className="grid gap-4 md:grid-cols-2">
              <div className="card p-6">
                <h2 className="font-semibold text-navy-950">A typical day</h2>
                <p className="mt-2 whitespace-pre-line text-slate-700">{c.dailyTasks ?? '—'}</p>
                {c.skills?.length > 0 && <div className="mt-3 flex flex-wrap gap-1.5">{c.skills.map((s: string) => <Badge key={s} tone="blue">{s}</Badge>)}</div>}
              </div>
              <div className="card p-6">
                <h2 className="font-semibold text-navy-950">How to start and grow</h2>
                <p className="mt-2 text-slate-700">{c.trainingRoutes ?? '—'}</p>
                {c.growthPath && <p className="mt-3 rounded-lg bg-gold-50 p-3 text-sm font-medium text-gold-700">{c.growthPath}</p>}
              </div>
            </section>
            <section>
              <h2 className="mb-3 text-xl font-bold text-navy-950">Open jobs</h2>
              {c.vacancies.length ? <div className="grid gap-4 md:grid-cols-2">{c.vacancies.map((v: any) => <JobCard key={v.id} v={{ ...v, dzongkhag: v.dzongkhag }} />)}</div>
                : <p className="text-sm text-slate-600">No open jobs right now. <Link href="/register" className="link">Create a profile</Link> and we will SMS you when one opens.</p>}
            </section>
            {c.training.length > 0 && (
              <section>
                <h2 className="mb-3 text-xl font-bold text-navy-950">Training</h2>
                <div className="grid gap-3 md:grid-cols-2">
                  {c.training.map((t: any) => (
                    <div key={t.id} className="card p-4">
                      <p className="font-semibold">{t.title}</p>
                      <p className="text-sm text-slate-600">{t.provider} {t.startDate && `· starts ${date(t.startDate)}`}</p>
                      {t.description && <p className="mt-1 text-sm">{t.description}</p>}
                      {t.link && <a className="link text-sm" href={t.link} target="_blank" rel="noreferrer">Details</a>}
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </Async>
    </div>
  );
}
