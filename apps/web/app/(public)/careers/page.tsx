'use client';
import Link from 'next/link';
import { useState } from 'react';
import { Async, Empty } from '@/components/ui';
import { VideoCard } from '@/components/video-card';
import { qs, useApi } from '@/lib/api';
import { money } from '@/lib/format';

export default function CareersPage() {
  const [tag, setTag] = useState('');
  const [q, setQ] = useState('');
  const tags = useApi<any[]>('/campaign/tags');
  const careers = useApi<any[]>(`/campaign/careers${qs({ q })}`);
  const videos = useApi<any[]>(`/campaign/videos${qs({ tag, q })}`);
  return (
    <div className="mx-auto max-w-6xl px-4 py-8">
      <h1 className="text-3xl font-bold text-navy-950">Explore careers</h1>
      <p className="mt-1 max-w-2xl text-slate-600">See what the work is really like, what it pays and how to start. Videos have Dzongkha and English subtitles and a low-data option.</p>
      <input className="input mt-5 max-w-md" placeholder="Search careers and videos" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search careers" />

      <h2 className="mt-8 mb-3 text-lg font-semibold text-navy-950">Careers</h2>
      <Async r={careers} empty={<Empty title="No careers found" />}>
        {(list) => (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.map((c) => (
              <Link key={c.id} href={`/careers/${c.slug}`} className="card overflow-hidden transition hover:-translate-y-0.5 hover:shadow-md">
                {c.coverVideoId ? <img src={`/api/campaign/videos/${c.coverVideoId}/thumbnail`} alt="" className="aspect-video w-full object-cover" loading="lazy" /> : <div className="flex aspect-video items-center justify-center bg-gradient-to-br from-navy-900 to-navy-700 text-4xl text-gold-300">▶</div>}
                <div className="p-4">
                  <p className="font-semibold text-navy-950">{c.title}</p>
                  <p className="mt-1 line-clamp-2 text-sm text-slate-600">{c.summary}</p>
                  <p className="mt-2 text-xs font-medium text-gold-700">{c.wageMin ? `${money(c.wageMin)} to ${money(c.wageMax)}` : ''} {c.videos ? `· ${c.videos} video(s)` : ''}</p>
                </div>
              </Link>
            ))}
          </div>
        )}
      </Async>

      <div className="mt-10 mb-3 flex flex-wrap items-center gap-2">
        <h2 className="mr-3 text-lg font-semibold text-navy-950">Videos</h2>
        <button onClick={() => setTag('')} className={`rounded-full px-3 py-1 text-sm ${tag === '' ? 'bg-navy-900 text-white' : 'bg-white text-navy-800 ring-1 ring-navy-100'}`}>All</button>
        {tags.data?.map((t) => (
          <button key={t.slug} onClick={() => setTag(t.slug)} className={`rounded-full px-3 py-1 text-sm ${tag === t.slug ? 'bg-navy-900 text-white' : 'bg-white text-navy-800 ring-1 ring-navy-100'}`}>{t.name}</button>
        ))}
      </div>
      <Async r={videos} empty={<Empty title="No videos yet">New stories are published every month.</Empty>}>
        {(list) => <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{list.map((v) => <VideoCard key={v.id} v={v} />)}</div>}
      </Async>
    </div>
  );
}
